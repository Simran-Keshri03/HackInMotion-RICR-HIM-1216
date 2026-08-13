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

/**
 * How much capability a call needs, said in terms of the work rather than a model name.
 *
 *   high     the answer becomes data other things depend on, so being wrong is expensive
 *   standard the answer is read by a person who can judge it, and the call happens often
 *
 * Deliberately not a model id: the whole point of this interface is that nothing above it knows
 * which model exists. The provider maps these to whatever it runs.
 */
export type AIQuality = 'standard' | 'high';

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
    /** Defaults to `high`: structured output usually becomes stored data. */
    quality?: AIQuality;
}

export interface AITextRequest {
    system: string;
    prompt: string;
    maxTokens?: number;
    /** Defaults to `standard`: free text is read by a person, not consumed by code. */
    quality?: AIQuality;
    /**
     * Earlier turns, oldest first, for a conversation that should remember itself. Left out for
     * one-shot requests so nothing extra is sent or paid for.
     */
    history?: { role: 'user' | 'assistant'; content: string }[];
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
