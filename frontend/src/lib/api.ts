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
            // Something other than our API answered. In practice this is the host's edge:
            // when the free instance is briefly unreachable it returns its own plain-text
            // 404, not our JSON envelope. That reads as "route not found" if you only look
            // at the status, but it is infrastructure being unavailable and a repeat
            // usually succeeds. Measured at roughly 5% of requests on the deployed service,
            // so without this the learner sees a broken screen once every twenty clicks.
            this.code === 'BAD_RESPONSE' ||
            this.code === 'AI_TIMEOUT' ||
            this.code === 'AI_UNAVAILABLE' ||
            // A request that timed out may well succeed on a second try — the free host cold-starts.
            this.code === 'TIMEOUT' ||
            // A token a second too new for the database's clock. Always worth retrying: it becomes
            // valid on its own, and the wait is under a second.
            this.code === 'TOKEN_NOT_YET_VALID'
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

/** First gap when the database says a token is from the future. See the retry loop for why. */
const SKEW_RETRY_DELAY_MS = 1200;

/**
 * How long to wait for a response before giving up.
 *
 * `fetch` has no timeout of its own: a request the server never answers leaves the promise pending
 * for ever, which on screen is a spinner that never stops. That is the "broken screen" failure mode
 * in its purest form — nothing errored, so no error state renders, and the learner is left looking at
 * a loading state with no way forward but a reload.
 *
 * Generous on purpose. A recommendation for a topic with no questions writes them first, which was
 * measured at 23 seconds and four AI calls; a 10-second timeout would abort the very request the
 * feature depends on. Sixty seconds is longer than anything this app legitimately does and far
 * shorter than for ever.
 */
const TIMEOUT_MS = 60_000;

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
        response = await fetch(`${BASE_URL}${path}`, {
            ...init,
            headers,
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (cause) {
        // A timeout and a dropped connection both land here and need different messages: one says
        // "try again", the other says "check your connection", and telling somebody to check a
        // working connection is how an app loses trust.
        if (cause instanceof DOMException && cause.name === 'TimeoutError') {
            throw new ApiError(0, 'TIMEOUT', 'The server took too long to answer. Try again.');
        }

        // Being offline is worth naming separately, because there is nothing the server can do about
        // it and retrying immediately will not help.
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
            throw new ApiError(0, 'OFFLINE', 'You appear to be offline. Reconnect and try again.');
        }

        throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection.');
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
        /**
         * A dead session ends the session.
         *
         * Without this the app dead-ends: Supabase hands over a token it still believes in, the
         * server rejects it, and every screen shows "Invalid or expired token" for ever. Supabase's
         * own refresh covers an *expired* token, but not one whose refresh token is also gone — a
         * revoked session, a changed password, a project restart. The learner is then signed in as far
         * as the client is concerned and refused by the server, with no route out except noticing the
         * Sign out button.
         *
         * Signing out is the honest recovery: the session really is over, so the login screen is
         * where they should be. Fire-and-forget because this path is already throwing, and awaiting a
         * sign-out to report a different error would only delay the message.
         */
        if (response.status === 401) {
            void supabase.auth.signOut();
        }

        throw new ApiError(response.status, body.error.code, body.error.message);
    }

    return body.data;
}

export const api = {
    /**
     * Retried up to twice on a server-side or infrastructure failure, because a GET is safe
     * to repeat. Two attempts rather than one because the deployed host drops roughly one
     * request in twenty, and a single retry occasionally lands on the same gap.
     */
    async get<T>(path: string): Promise<T> {
        let lastError: unknown;

        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                return await request<T>(path);
            } catch (error) {
                lastError = error;

                if (!(error instanceof ApiError) || !error.retryable) throw error;

                if (attempt < 2) {
                    /**
                     * A token the database thinks is from the future needs a longer wait than a
                     * dropped request does.
                     *
                     * The ordinary backoff is 700ms then 1400ms — about two seconds in total, which
                     * turned out to be shorter than the clock skew between the auth server and the
                     * database. All three attempts failed inside the window and the learner met an
                     * error on the first screen after signing in. Waiting 1.2s then 2.4s covers it,
                     * and only applies to that one code, so nothing else is made slower.
                     */
                    const gap =
                        error.code === 'TOKEN_NOT_YET_VALID' ? SKEW_RETRY_DELAY_MS : RETRY_DELAY_MS;

                    await new Promise((resolve) => setTimeout(resolve, gap * (attempt + 1)));
                }
            }
        }

        throw lastError;
    },

    /**
     * Never retried. A POST here records an attempt, and the database numbers attempts from
     * the rows that already exist -- so a repeated submit would be logged as a second try at
     * the same question and quietly skew that topic's mastery. A learner pressing the button
     * again is a decision they can make; the client will not make it for them.
     */
    post: <T>(path: string, payload: unknown) =>
        request<T>(path, { method: 'POST', body: JSON.stringify(payload) }),

    /**
     * Also never retried, for a different reason than POST.
     *
     * A PATCH here is idempotent — sending the same name twice leaves the same name — so repeating it
     * would be harmless. It is not retried because a failed settings save should be *reported*: the
     * learner is sitting in front of the form and can press the button again, and silently succeeding
     * on the second attempt hides that the first one failed.
     */
    patch: <T>(path: string, payload: unknown) =>
        request<T>(path, { method: 'PATCH', body: JSON.stringify(payload) }),
};
