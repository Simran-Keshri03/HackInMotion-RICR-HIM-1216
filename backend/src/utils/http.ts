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

export function sendError(
    res: Response,
    status: number,
    code: string,
    message: string
) {
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
export function errorHandler(
    err: unknown,
    _req: Request,
    res: Response,
    _next: NextFunction
) {
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

    // Unexpected: log the real error server-side, tell the client nothing useful.
    console.error('Unhandled error:', err);
    sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}
