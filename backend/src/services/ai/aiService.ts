import type { AiRepository, MessageRow } from '@/repositories/aiRepository.js';
import type { IAIProvider } from '@/services/ai/IAIProvider.js';
import { TUTOR_SYSTEM, tutorPrompt } from '@/services/ai/prompts.js';

export interface AskTutorInput {
    userId: string;
    question: string;
    /** Continues an existing thread; a new one is started when absent. */
    conversationId?: string;
    /** The topic in view, so the reply is grounded in what they know about it. */
    topicId?: string;
    /** The question on screen, when they asked from the practice page. */
    currentQuestion?: string;
}

export interface TutorReply {
    conversationId: string;
    title: string;
    answer: string;
    /** Both messages, so the client can render the exchange without a second request. */
    messages: { role: 'learner' | 'tutor'; content: string; createdAt: string }[];
    /** So the cost of the feature is measurable rather than guessed at. */
    usage: { inputTokens: number; outputTokens: number; model: string };
}

/** How many earlier turns to replay. Enough to follow up; short enough to stay cheap. */
const HISTORY_TURNS = 8;

/** A learner's phone-typed question. Longer than this is an essay, not a doubt. */
const MAX_QUESTION = 2000;

export class TutorService {
    private readonly ai: IAIProvider;
    private readonly conversations: AiRepository;

    constructor(ai: IAIProvider, conversations: AiRepository) {
        this.ai = ai;
        this.conversations = conversations;
    }

    async listConversations(userId: string) {
        const rows = await this.conversations.listConversations(userId);
        const answered = await this.conversations.findAnsweredIds(
            rows.map((row) => row.id)
        );

        return rows.map((row) => ({
            id: row.id,
            title: row.title,
            topicId: row.topic_id,
            lastMessageAt: row.last_message_at,
            // False when the question was asked but the model never answered — an outage, or a
            // request that failed after the question was saved. The list says so rather than
            // showing it as an ordinary thread.
            answered: answered.has(row.id),
        }));
    }

    async getConversation(conversationId: string, userId: string) {
        const conversation = await this.conversations.findConversation(
            conversationId,
            userId
        );
        const messages = await this.conversations.listMessages(conversation.id);

        return {
            id: conversation.id,
            title: conversation.title,
            topicId: conversation.topic_id,
            messages: messages.map(toView),
        };
    }

    /**
     * One question, one answer, both stored.
     *
     * Order matters. The learner's message is written before the model is called, so a question
     * asked during an outage is not lost — they can reload and see it, and ask again. The reply is
     * written after, which means a failed call leaves a conversation whose last message is
     * unanswered rather than a conversation that pretends nothing was asked.
     */
    async ask(input: AskTutorInput): Promise<TutorReply> {
        const question = input.question.trim().slice(0, MAX_QUESTION);

        const conversation = input.conversationId
            ? await this.conversations.findConversation(input.conversationId, input.userId)
            : await this.conversations.createConversation(
                  input.userId,
                  titleFrom(question),
                  input.topicId ?? null
              );

        // Earlier turns before the new question is stored, so the model is not shown the question
        // twice.
        const earlier = input.conversationId
            ? await this.conversations.listMessages(conversation.id)
            : [];

        await this.conversations.addMessage({
            conversationId: conversation.id,
            role: 'learner',
            content: question,
        });

        // The topic comes from the conversation when continuing one, so a follow-up stays grounded
        // in the same topic without the client having to resend it.
        const topicId = input.topicId ?? conversation.topic_id;
        const facts = await this.conversations.findTutorFacts(input.userId, topicId);

        const response = await this.ai.generateText({
            system: TUTOR_SYSTEM,
            prompt: tutorPrompt(question, {
                ...facts,
                currentQuestion: input.currentQuestion ?? null,
            }),
            // Sonnet-tier: a person reads this and judges it themselves, and the tutor is asked
            // dozens of questions in a session.
            quality: 'standard',
            maxTokens: 2000,
            history: earlier.slice(-HISTORY_TURNS).map((message) => ({
                role: message.role === 'learner' ? ('user' as const) : ('assistant' as const),
                content: message.content,
            })),
        });

        const answer = await this.conversations.addMessage({
            conversationId: conversation.id,
            role: 'tutor',
            content: response.text,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            model: response.model,
        });

        return {
            conversationId: conversation.id,
            title: conversation.title,
            answer: response.text,
            messages: [
                { role: 'learner', content: question, createdAt: answer.created_at },
                toView(answer),
            ],
            usage: { ...response.usage, model: response.model },
        };
    }
}

function toView(message: MessageRow) {
    return {
        role: message.role,
        content: message.content,
        createdAt: message.created_at,
    };
}

/**
 * A readable title from the first question, so the history list means something at a glance.
 *
 * Cut at a word boundary rather than mid-word: a list of truncated questions is the only way a
 * learner finds the thread they want again.
 */
function titleFrom(question: string): string {
    const oneLine = question.replace(/\s+/g, ' ').trim();

    if (oneLine.length <= 60) return oneLine;

    const cut = oneLine.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');

    return `${lastSpace > 20 ? cut.slice(0, lastSpace) : cut}…`;
}
