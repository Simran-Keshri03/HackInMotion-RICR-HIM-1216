import type { NextFunction, Request, Response } from 'express';
import { AIProviderError } from '@/utils/errors.js';

/**
 * Every response this API sends uses one of two shapes:
 *   success -> { success: true,  data, error: null }
 *   failure -> { success: false, data: null, error: { code, message } }
 */
export function sendOk<T>(res: Response, data: T, status = 200) {
    res.status(status).json({ success: true, data, error: null });
}

export function sendError(res: Response, status: number, code: string, message: string) {
    res.status(status).json({
        success: false,
        data: null,
        error: { code, message },
    });
}

/** An error we deliberately throw and are happy to show the client. */
export class AppError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = 'AppError';
        this.status = status;
        this.code = code;
    }
}

/** Wraps async controllers so a rejected promise reaches the error handler. */
export function asyncRoute(
    fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
) {
    return (req: Request, res: Response, next: NextFunction) => {
        fn(req, res, next).catch(next);
    };
}

/** Single place where every unhandled error becomes a client response. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
    if (err instanceof AppError) {
        sendError(res, err.status, err.code, err.message);
        return;
    }

    // The AI failing is not a bug in Adigam, so it does not deserve a 500. Report what
    // actually happened, with a status the client can act on.
    if (err instanceof AIProviderError) {
        console.warn(`AI provider failure (${err.code}): ${err.message}`);
        sendError(res, err.httpStatus, err.code, err.message);
        return;
    }

    /**
     * A token that is valid but a second too new.
     *
     * PostgREST rejects a JWT whose `iat` is ahead of the database's own clock with PGRST303, "JWT
     * issued at future". The token is genuine — Supabase's auth server minted it and this backend
     * verified it — the two clocks simply disagree by a fraction of a second, and the database is the
     * one that is behind.
     *
     * Left unmapped it became a 500 on the learner's very first request after signing in, which is the
     * worst possible moment: the dashboard is the first thing they see and it showed an error for
     * something that fixes itself. Reported instead as 503 with its own code, which the client
     * recognises as worth waiting a beat and retrying rather than as a broken screen.
     *
     * The only honest fix on our side is to retry; the alternative would be to stop enforcing
     * row-level security on these reads, and a timing quirk is not worth trading that for.
     */
    if (isClockSkew(err)) {
        console.warn(
            'PostgREST rejected a just-issued token (clock skew); asking the client to retry.'
        );
        sendError(
            res,
            503,
            'TOKEN_NOT_YET_VALID',
            'Your session is still being set up. One moment.'
        );
        return;
    }

    // Unexpected: log the real error server-side, tell the client nothing useful.
    console.error('Unhandled error:', err);
    sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}

/** PostgREST's code for a JWT whose issued-at time is ahead of the database's clock. */
function isClockSkew(err: unknown): boolean {
    if (typeof err !== 'object' || err === null) return false;

    const candidate = err as { code?: unknown; message?: unknown };

    return (
        candidate.code === 'PGRST303' ||
        (typeof candidate.message === 'string' && /issued at future/i.test(candidate.message))
    );
}
