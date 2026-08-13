import type { NextFunction, Request, Response } from 'express';
import { adminDb } from '@/config/database.js';
import { AppError } from '@/utils/http.js';

/**
 * Turns a bearer token into a verified identity.
 *
 * The rule this file exists to enforce: the learner's id comes from the token and
 * nowhere else. A user_id in the request body, query string or a custom header is
 * ignored, because any of those can be typed by hand.
 */

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Present only after requireAuth has run. */
            auth?: { userId: string; accessToken: string };
        }
    }
}

// Long enough to be a real JWT, short enough to reject junk before calling out.
const MIN_TOKEN_LENGTH = 20;
const MAX_TOKEN_LENGTH = 4096;

export async function requireAuth(
    req: Request,
    _res: Response,
    next: NextFunction
) {
    try {
        const header = req.headers.authorization ?? '';

        if (!header.startsWith('Bearer ')) {
            throw new AppError(
                401,
                'UNAUTHENTICATED',
                'Missing bearer token.'
            );
        }

        const token = header.slice('Bearer '.length).trim();

        if (
            token.length < MIN_TOKEN_LENGTH ||
            token.length > MAX_TOKEN_LENGTH
        ) {
            throw new AppError(401, 'UNAUTHENTICATED', 'Malformed token.');
        }

        // ponytail: asks Supabase to validate the token, which costs one network call
        // per request. Verifying the signature locally against the project JWKS would
        // remove that hop; worth doing if latency becomes a problem.
        const { data, error } = await adminDb.auth.getUser(token);

        if (error || !data.user) {
            throw new AppError(
                401,
                'UNAUTHENTICATED',
                'Invalid or expired token.'
            );
        }

        req.auth = { userId: data.user.id, accessToken: token };
        next();
    } catch (err) {
        next(err);
    }
}

/**
 * Reads the identity that requireAuth established. Throwing rather than returning
 * undefined means a controller can never quietly run without an authenticated user
 * because somebody forgot to mount the middleware.
 */
export function authOf(req: Request): { userId: string; accessToken: string } {
    if (!req.auth) {
        throw new AppError(
            500,
            'INTERNAL_ERROR',
            'Route is missing the auth middleware.'
        );
    }
    return req.auth;
}
