import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { AppError, errorHandler } from '@/utils/http.js';

/**
 * The single place every unhandled failure becomes a client response.
 *
 * These tests exist because the case that matters most is **intermittent**. PostgREST rejects a token
 * whose issued-at time is ahead of the database's clock, and whether that happens depends on a
 * fraction of a second of drift between two servers — so it cannot be reproduced on demand, and a fix
 * for it cannot be demonstrated by hitting the endpoint. A test is the only way to show the mapping is
 * right.
 */

/** A response object that records what the handler did to it. */
function fakeResponse() {
    const state: { status?: number; body?: unknown } = {};

    const res = {
        status(code: number) {
            state.status = code;
            return res;
        },
        json(body: unknown) {
            state.body = body;
            return res;
        },
    } as unknown as Response;

    return { res, state };
}

const req = {} as Request;
const next = (() => undefined) as NextFunction;

/** The error shape PostgREST actually returns. */
const clockSkew = {
    code: 'PGRST303',
    details: null,
    hint: null,
    message: 'JWT issued at future',
};

describe('errorHandler — a token the database thinks is from the future', () => {
    /**
     * The bug this fixes: unmapped, PGRST303 became a 500 on the learner's first request after signing
     * in. The dashboard is the first thing they see, and it showed a fault for something that fixes
     * itself within a second.
     */
    it('reports a just-issued token as retryable, not as a fault', () => {
        const { res, state } = fakeResponse();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        errorHandler(clockSkew, req, res, next);

        expect(state.status).toBe(503);
        expect(state.body).toMatchObject({
            success: false,
            error: { code: 'TOKEN_NOT_YET_VALID' },
        });

        warn.mockRestore();
    });

    it('says something a learner can read rather than quoting Postgres', () => {
        const { res, state } = fakeResponse();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        errorHandler(clockSkew, req, res, next);

        const message = (state.body as { error: { message: string } }).error.message;

        // "JWT issued at future" is accurate and means nothing to the person reading it.
        expect(message).not.toMatch(/jwt|pgrst/i);
        expect(message.length).toBeGreaterThan(10);

        warn.mockRestore();
    });

    it('recognises it by message as well as by code', () => {
        // Belt and braces: PostgREST has renumbered codes before, and the message is the more stable
        // half of this particular error.
        const { res, state } = fakeResponse();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        errorHandler({ message: 'JWT issued at future' }, req, res, next);

        expect(state.status).toBe(503);
        warn.mockRestore();
    });

    it('does not log it as an unhandled error', () => {
        // It is expected and self-correcting. Logging it at error level would train whoever reads the
        // logs to ignore real ones.
        const { res } = fakeResponse();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        errorHandler(clockSkew, req, res, next);

        expect(error).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalled();

        error.mockRestore();
        warn.mockRestore();
    });
});

describe('errorHandler — everything else', () => {
    it('passes an AppError through with its own status and code', () => {
        const { res, state } = fakeResponse();

        errorHandler(
            new AppError(404, 'GROUP_NOT_FOUND', 'That group does not exist.'),
            req,
            res,
            next
        );

        expect(state.status).toBe(404);
        expect(state.body).toMatchObject({
            error: { code: 'GROUP_NOT_FOUND', message: 'That group does not exist.' },
        });
    });

    it('tells the client nothing useful about an unexpected failure', () => {
        const { res, state } = fakeResponse();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        errorHandler(new Error('connection pool exhausted at 10.0.0.4:5432'), req, res, next);

        expect(state.status).toBe(500);

        const body = state.body as { error: { code: string; message: string } };
        expect(body.error.code).toBe('INTERNAL_ERROR');
        // Internals stay in the log. An error message is not a place to publish infrastructure.
        expect(body.error.message).not.toMatch(/pool|10\.0\.0\.4|5432/);
        expect(error).toHaveBeenCalled();

        error.mockRestore();
    });

    it('does not mistake an ordinary database error for clock skew', () => {
        const { res, state } = fakeResponse();
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        errorHandler({ code: '23505', message: 'duplicate key value' }, req, res, next);

        expect(state.status).toBe(500);
        error.mockRestore();
    });
});
