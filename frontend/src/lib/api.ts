import { supabase } from '@/lib/supabase';
import type { ApiResponse } from '@/types/api';

/**
 * The only way this app talks to the backend.
 *
 * Three jobs, all in one place so no screen has to remember them:
 *   - attach the signed-in learner's token
 *   - unwrap the { success, data, error } envelope
 *   - turn a failure into one error type the UI can render
 *
 * Note what is never sent: a user id. The backend derives identity from the token, so
 * passing one would be ignored -- and passing one would be the beginning of a bug.
 */

const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4000/api/v1';

/** A failed request, with the backend's own code and message when it gave one. */
export class ApiError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.name = 'ApiError';
        this.code = code;
        this.status = status;
    }

    /** True for failures where trying again is a reasonable offer to the learner. */
    get retryable(): boolean {
        return (
            this.status >= 500 ||
            this.status === 0 ||
            this.code === 'AI_TIMEOUT' ||
            this.code === 'AI_UNAVAILABLE'
        );
    }
}

/**
 * How long to wait before the single retry a GET is allowed.
 *
 * There is a specific failure this exists for. Straight after signing in, the dashboard fires
 * its first request with a token that is a second old, and the database occasionally rejects it
 * as "issued in the future" because its clock is fractionally behind the auth server's. The
 * learner's very first screen would show an error for something that fixes itself. One short
 * retry turns that into a slightly slower load.
 */
const RETRY_DELAY_MS = 700;

async function request<T>(
    path: string,
    init: RequestInit & { authenticated?: boolean } = {}
): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');

    if (init.authenticated !== false) {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;

        if (!token) {
            throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
        }

        headers.set('Authorization', `Bearer ${token}`);
    }

    let response: Response;

    try {
        response = await fetch(`${BASE_URL}${path}`, { ...init, headers });
    } catch {
        // A dropped connection is the single most likely failure on a slow network, and it
        // deserves a message that says so rather than "failed to fetch".
        throw new ApiError(
            0,
            'NETWORK',
            'Could not reach the server. Check your connection.'
        );
    }

    let body: ApiResponse<T>;

    try {
        body = (await response.json()) as ApiResponse<T>;
    } catch {
        throw new ApiError(
            response.status,
            'BAD_RESPONSE',
            'The server sent something unexpected.'
        );
    }

    if (!body.success) {
        throw new ApiError(response.status, body.error.code, body.error.message);
    }

    return body.data;
}

export const api = {
    /**
     * Retried once on a server-side or network failure, because a GET is safe to repeat.
     */
    async get<T>(path: string): Promise<T> {
        try {
            return await request<T>(path);
        } catch (error) {
            if (error instanceof ApiError && error.retryable) {
                await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
                return request<T>(path);
            }
            throw error;
        }
    },

    /**
     * Never retried. A POST here records an attempt, and the database numbers attempts from
     * the rows that already exist -- so a repeated submit would be logged as a second try at
     * the same question and quietly skew that topic's mastery. A learner pressing the button
     * again is a decision they can make; the client will not make it for them.
     */
    post: <T>(path: string, payload: unknown) =>
        request<T>(path, { method: 'POST', body: JSON.stringify(payload) }),
};
