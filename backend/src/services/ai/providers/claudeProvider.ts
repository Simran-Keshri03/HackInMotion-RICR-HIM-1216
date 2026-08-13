import Anthropic from '@anthropic-ai/sdk';
import { env } from '@/config/environment.js';
import type {
    AIJsonRequest,
    AIJsonResponse,
    AITextRequest,
    AITextResponse,
    IAIProvider,
} from '@/services/ai/IAIProvider.js';
import { AIProviderError } from '@/utils/errors.js';

/**
 * The only file in Adigam that imports the Anthropic SDK.
 *
 * Everything Claude-specific is here: the model id, the token limits, the beta flags, the
 * shape of the response. Above this file the application only knows IAIProvider, so a
 * second provider is a new file rather than a refactor.
 *
 * Three details worth knowing:
 *
 * 1. Structured outputs. `output_config.format` constrains generation to our JSON Schema,
 *    so we very rarely get malformed JSON. We still validate afterwards -- a reply can
 *    match the schema perfectly and still be wrong about the subject.
 *
 * 2. Refusals arrive as a successful response. Claude's safety classifiers can decline a
 *    request and the API returns HTTP 200 with stop_reason "refusal" and empty content.
 *    Reading content[0] without checking stop_reason first is how that becomes a crash.
 *
 * 3. Server-side fallbacks. If a request is declined, the API re-runs it on a fallback
 *    model in the same call instead of handing us the refusal.
 */

const MODEL = 'claude-opus-5';

const DEFAULT_MAX_TOKENS = 8000;

// A question-generation call that has not answered in a minute is not going to.
const REQUEST_TIMEOUT_MS = 90_000;

export class ClaudeProvider implements IAIProvider {
    readonly name = MODEL;

    private readonly client: Anthropic;

    constructor(apiKey: string) {
        this.client = new Anthropic({
            apiKey,
            timeout: REQUEST_TIMEOUT_MS,
            // Transient failures (429, 5xx, connection drops) are retried by the SDK.
            maxRetries: 2,
        });
    }

    async generateJson(request: AIJsonRequest): Promise<AIJsonResponse> {
        const response = await this.send({
            system: request.system,
            prompt: request.prompt,
            maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            schema: request.schema,
        });

        const text = firstTextOf(response);

        if (!text) {
            throw new AIProviderError(
                'AI_MALFORMED',
                'The model returned no text to parse.'
            );
        }

        try {
            return {
                data: JSON.parse(text),
                usage: usageOf(response),
                model: response.model,
            };
        } catch {
            throw new AIProviderError(
                'AI_MALFORMED',
                'The model returned something that is not valid JSON.'
            );
        }
    }

    async generateText(request: AITextRequest): Promise<AITextResponse> {
        const response = await this.send({
            system: request.system,
            prompt: request.prompt,
            maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
        });

        const text = firstTextOf(response);

        if (!text) {
            throw new AIProviderError(
                'AI_MALFORMED',
                'The model returned an empty answer.'
            );
        }

        return { text, usage: usageOf(response), model: response.model };
    }

    /** One place where the request is built and provider errors are translated. */
    private async send(options: {
        system: string;
        prompt: string;
        maxTokens: number;
        schema?: Record<string, unknown>;
    }) {
        try {
            const response = await this.client.beta.messages.create({
                model: MODEL,
                max_tokens: options.maxTokens,
                // If a request is declined, let the API retry it on a fallback model
                // rather than returning us a refusal.
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default',
                system: options.system,
                messages: [{ role: 'user', content: options.prompt }],
                ...(options.schema
                    ? {
                          output_config: {
                              format: {
                                  type: 'json_schema' as const,
                                  schema: options.schema,
                              },
                          },
                      }
                    : {}),
            });

            // A refusal is a 200. Check it before touching content.
            if (response.stop_reason === 'refusal') {
                throw new AIProviderError(
                    'AI_REFUSED',
                    'The model declined this request.'
                );
            }

            // Truncated output is not usable output, and half a JSON document parses to
            // nothing useful.
            if (response.stop_reason === 'max_tokens') {
                throw new AIProviderError(
                    'AI_MALFORMED',
                    'The answer was cut off before it finished.'
                );
            }

            return response;
        } catch (error) {
            throw translate(error);
        }
    }
}

function firstTextOf(response: {
    content: Array<{ type: string }>;
}): string | null {
    // With thinking enabled the reply can contain more than one kind of block, so pick
    // the text one rather than assuming index 0.
    for (const block of response.content) {
        if (block.type === 'text') {
            const { text } = block as { text?: unknown };
            if (typeof text === 'string') return text;
        }
    }
    return null;
}

function usageOf(response: {
    usage: { input_tokens: number; output_tokens: number };
}) {
    return {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
    };
}

/** Turns SDK errors into our own, so callers never import Anthropic types to catch them. */
function translate(error: unknown): AIProviderError {
    if (error instanceof AIProviderError) return error;

    if (error instanceof Anthropic.APIConnectionTimeoutError) {
        return new AIProviderError('AI_TIMEOUT', 'The model took too long.', true);
    }

    if (error instanceof Anthropic.RateLimitError) {
        return new AIProviderError(
            'AI_RATE_LIMITED',
            'Too many AI requests right now. Try again shortly.',
            true
        );
    }

    if (error instanceof Anthropic.APIConnectionError) {
        return new AIProviderError(
            'AI_UNAVAILABLE',
            'Could not reach the model.',
            true
        );
    }

    if (error instanceof Anthropic.APIError) {
        // 5xx is worth retrying; a 400 from us is not.
        const retryable = (error.status ?? 500) >= 500;
        return new AIProviderError(
            'AI_UNAVAILABLE',
            `The model service returned an error (${error.status ?? 'unknown'}).`,
            retryable
        );
    }

    return new AIProviderError('AI_UNAVAILABLE', 'Unexpected AI failure.');
}

/**
 * Built lazily so the server still starts without an API key -- every other feature works
 * without AI, and only the AI routes should fail when the key is missing.
 */
let cached: ClaudeProvider | null = null;

export function claudeProvider(): ClaudeProvider {
    if (!env.ANTHROPIC_API_KEY) {
        throw new AIProviderError(
            'AI_UNAVAILABLE',
            'AI features are not configured on this server.'
        );
    }

    cached ??= new ClaudeProvider(env.ANTHROPIC_API_KEY);
    return cached;
}
