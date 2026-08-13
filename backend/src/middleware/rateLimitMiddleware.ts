import type { NextFunction, Request, Response } from 'express';
import { authOf } from '@/middleware/authMiddleware.js';
import { AppError } from '@/utils/http.js';

/**
 * A per-learner quota for expensive routes.
 *
 * AI calls cost real money and take real seconds, so a bug in a retry loop or somebody
 * holding down a button must not be able to run up a bill. The limit is per learner, keyed
 * off the verified token, so one person cannot exhaust everybody else's allowance.
 *
 * ponytail: counters live in this process's memory. Restarting the server resets them, and
 * two instances would each allow the full quota. Fine for a single-instance deployment;
 * move the counter into Postgres or Redis before running more than one.
 */

interface Window {
    count: number;
    resetsAt: number;
}

export function rateLimit(options: {
    /** How many requests one learner may make per window. */
    max: number;
    windowMs: number;
    /** Shown to the learner when they run out. */
    message: string;
}) {
    const windows = new Map<string, Window>();

    return (req: Request, _res: Response, next: NextFunction) => {
        try {
            // Keyed on the verified identity, never on an IP or a header the caller
            // controls -- both are trivially spoofed.
            const { userId } = authOf(req);
            const now = Date.now();

            const current = windows.get(userId);

            if (!current || current.resetsAt <= now) {
                windows.set(userId, { count: 1, resetsAt: now + options.windowMs });

                // Opportunistic cleanup: expired entries are dropped as we go, so the map
                // does not grow with every learner who ever visited.
                if (windows.size > 1000) {
                    for (const [key, window] of windows) {
                        if (window.resetsAt <= now) windows.delete(key);
                    }
                }

                next();
                return;
            }

            if (current.count >= options.max) {
                const seconds = Math.ceil((current.resetsAt - now) / 1000);
                throw new AppError(
                    429,
                    'RATE_LIMITED',
                    `${options.message} Try again in ${seconds} seconds.`
                );
            }

            current.count += 1;
            next();
        } catch (error) {
            next(error);
        }
    };
}
