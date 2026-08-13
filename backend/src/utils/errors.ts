/**
 * Error types that more than one layer needs to know about.
 *
 * AIProviderError lives here rather than beside the provider so that the central error
 * handler can turn it into an HTTP response without utils importing from services. The
 * dependency points the right way: services depend on utils, never the reverse.
 */

export type AIErrorCode =
    | 'AI_TIMEOUT'
    | 'AI_RATE_LIMITED'
    | 'AI_REFUSED'
    | 'AI_MALFORMED'
    | 'AI_UNAVAILABLE';

/**
 * Thrown when the AI provider fails: timeout, network, rate limit, a declined request, or
 * a reply that is not what we asked for. Nothing in Adigam should break because the AI was
 * unavailable, so callers either degrade gracefully or let this reach the error handler,
 * which reports it honestly instead of as a generic 500.
 */
export class AIProviderError extends Error {
    readonly code: AIErrorCode;
    readonly retryable: boolean;

    constructor(code: AIErrorCode, message: string, retryable = false) {
        super(message);
        this.name = 'AIProviderError';
        this.code = code;
        this.retryable = retryable;
    }

    /** How this failure should look over HTTP. */
    get httpStatus(): number {
        switch (this.code) {
            case 'AI_RATE_LIMITED':
                return 429;
            case 'AI_TIMEOUT':
                return 504;
            default:
                // Unavailable, refused or malformed: the request was fine, the AI was not.
                return 503;
        }
    }
}
