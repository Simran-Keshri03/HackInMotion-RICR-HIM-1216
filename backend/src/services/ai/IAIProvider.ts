/**
 * What the rest of Adigam is allowed to know about AI.
 *
 * Nothing above this file imports the Anthropic SDK. Every service asks for an
 * IAIProvider, and something at the edge decides which implementation it gets. Swapping
 * to a different model, or to a fake one in tests, is a change in one place.
 *
 * The interface is deliberately small: two things we actually need. Structured JSON, for
 * anything the application will act on, and free text, for anything a person will read.
 */

export interface AIUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface AIJsonRequest {
    /** Who the model is being asked to be. Stable across calls, so it caches well. */
    system: string;
    /** The specific ask. */
    prompt: string;
    /**
     * JSON Schema the reply must satisfy. Given to the provider so the model is
     * constrained while generating -- but the reply is still validated on our side,
     * because a schema-shaped answer can still be a wrong answer.
     */
    schema: Record<string, unknown>;
    maxTokens?: number;
}

export interface AITextRequest {
    system: string;
    prompt: string;
    maxTokens?: number;
}

export interface AIJsonResponse {
    /** Parsed JSON, not yet trusted. */
    data: unknown;
    usage: AIUsage;
    model: string;
}

export interface AITextResponse {
    text: string;
    usage: AIUsage;
    model: string;
}

export interface IAIProvider {
    /** For logs and for telling a learner which model answered them. */
    readonly name: string;

    generateJson(request: AIJsonRequest): Promise<AIJsonResponse>;

    generateText(request: AITextRequest): Promise<AITextResponse>;
}

// The error type lives in utils so the central error handler can map it to HTTP without
// utils importing from services. Re-exported here so AI code has one import.
export { AIProviderError } from '@/utils/errors.js';
