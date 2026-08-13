import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '@/utils/http.js';

export interface ConversationRow {
    id: string;
    topic_id: string | null;
    title: string;
    created_at: string;
    last_message_at: string;
}

export interface MessageRow {
    id: string;
    role: 'learner' | 'tutor';
    content: string;
    created_at: string;
}

/** What the tutor needs to know about where this learner is stuck on this topic. */
export interface TutorFacts {
    topicName: string | null;
    subjectName: string | null;
    masteryScore: number | null;
    attemptsOnTopic: number;
    recentAccuracyPercent: number | null;
    recentMistakes: string[];
}

/**
 * Tutor conversations, and the narrow slice of learner state a tutor reply is grounded in.
 *
 * Writes need an elevated client: these tables grant SELECT to learners and nothing else, so a
 * conversation only exists as the result of a request that actually called the model.
 */
export class AiRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async listConversations(userId: string, limit = 30): Promise<ConversationRow[]> {
        const { data, error } = await this.db
            .from('ai_conversations')
            .select('id, topic_id, title, created_at, last_message_at')
            .eq('user_id', userId)
            .order('last_message_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return (data ?? []) as ConversationRow[];
    }

    /**
     * Loads a conversation, checking ownership explicitly.
     *
     * The user id filter is load-bearing rather than decorative: this runs with the elevated
     * client, which bypasses RLS, so nothing below would stop one learner reading another's
     * questions if it were left off.
     */
    async findConversation(
        conversationId: string,
        userId: string
    ): Promise<ConversationRow> {
        const { data, error } = await this.db
            .from('ai_conversations')
            .select('id, topic_id, title, created_at, last_message_at')
            .eq('id', conversationId)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;

        if (!data) {
            // 404 rather than 403: telling somebody a conversation exists but is not theirs is
            // itself a leak.
            throw new AppError(
                404,
                'CONVERSATION_NOT_FOUND',
                'That conversation does not exist.'
            );
        }

        return data as ConversationRow;
    }

    /**
     * Which of these conversations have a tutor reply.
     *
     * One query for the whole list rather than one per conversation. It exists because a question
     * asked while the model was unavailable is deliberately kept — the learner's message is
     * written before the call, so nothing is lost during an outage — which leaves conversations
     * that hold a question and no answer. Without this the history list shows them as if they were
     * ordinary threads, and two attempts at the same question read as a duplicate.
     */
    async findAnsweredIds(conversationIds: string[]): Promise<Set<string>> {
        if (conversationIds.length === 0) return new Set();

        const { data, error } = await this.db
            .from('ai_messages')
            .select('conversation_id')
            .in('conversation_id', conversationIds)
            .eq('role', 'tutor');

        if (error) throw error;

        return new Set(
            ((data ?? []) as { conversation_id: string }[]).map(
                (row) => row.conversation_id
            )
        );
    }

    async listMessages(conversationId: string, limit = 50): Promise<MessageRow[]> {
        const { data, error } = await this.db
            .from('ai_messages')
            .select('id, role, content, created_at')
            .eq('conversation_id', conversationId)
            .order('created_at')
            .limit(limit);

        if (error) throw error;
        return (data ?? []) as MessageRow[];
    }

    async createConversation(
        userId: string,
        title: string,
        topicId: string | null
    ): Promise<ConversationRow> {
        const { data, error } = await this.db
            .from('ai_conversations')
            .insert({ user_id: userId, title, topic_id: topicId })
            .select('id, topic_id, title, created_at, last_message_at')
            .single();

        if (error) throw error;
        return data as ConversationRow;
    }

    async addMessage(message: {
        conversationId: string;
        role: 'learner' | 'tutor';
        content: string;
        inputTokens?: number;
        outputTokens?: number;
        model?: string;
    }): Promise<MessageRow> {
        const { data, error } = await this.db
            .from('ai_messages')
            .insert({
                conversation_id: message.conversationId,
                role: message.role,
                content: message.content,
                // The CHECK constraint requires these to be null on a learner message, so they
                // are sent as null rather than undefined.
                input_tokens: message.inputTokens ?? null,
                output_tokens: message.outputTokens ?? null,
                model: message.model ?? null,
            })
            .select('id, role, content, created_at')
            .single();

        if (error) throw error;
        return data as MessageRow;
    }

    /**
     * The learner's state on one topic, in one place.
     *
     * Four small reads rather than a join: each is indexed, and keeping them separate means the
     * tutor still gets useful context when a learner has mastery but no mistakes, or a topic but
     * no attempts at all.
     */
    async findTutorFacts(userId: string, topicId: string | null): Promise<TutorFacts> {
        const empty: TutorFacts = {
            topicName: null,
            subjectName: null,
            masteryScore: null,
            attemptsOnTopic: 0,
            recentAccuracyPercent: null,
            recentMistakes: [],
        };

        if (!topicId) return empty;

        const { data: topic, error: topicError } = await this.db
            .from('topics')
            .select('name, parent_id')
            .eq('id', topicId)
            .maybeSingle();

        if (topicError) throw topicError;
        if (!topic) return empty;

        let subjectName: string | null = null;

        if (topic.parent_id) {
            const { data: parent } = await this.db
                .from('topics')
                .select('name')
                .eq('id', topic.parent_id as string)
                .maybeSingle();

            subjectName = (parent?.name as string) ?? null;
        }

        const { data: mastery, error: masteryError } = await this.db
            .from('concept_mastery')
            .select('mastery_score, total_attempts, recent_accuracy')
            .eq('user_id', userId)
            .eq('topic_id', topicId)
            .maybeSingle();

        if (masteryError) throw masteryError;

        // Two plain queries rather than one embedded join. An embed on this project silently
        // returned nothing once already, and it did so without an error — the safe pattern here is
        // boring and explicit.
        const { data: wrongAttempts, error: mistakeError } = await this.db
            .from('question_attempts')
            .select('question_id')
            .eq('user_id', userId)
            .eq('topic_id', topicId)
            .eq('is_correct', false)
            .order('attempted_at', { ascending: false })
            .limit(3);

        if (mistakeError) throw mistakeError;

        const wrongIds = [
            ...new Set(
                ((wrongAttempts ?? []) as { question_id: string }[]).map(
                    (row) => row.question_id
                )
            ),
        ];

        let recentMistakes: string[] = [];

        if (wrongIds.length > 0) {
            // Question bodies only — never the answers. The tutor is meant to explain, and handing
            // it the answer key invites it to hand that straight back to the learner.
            const { data: bodies, error: bodyError } = await this.db
                .from('questions')
                .select('body')
                .in('id', wrongIds);

            if (bodyError) throw bodyError;

            recentMistakes = ((bodies ?? []) as { body: string }[]).map((row) => row.body);
        }

        return {
            topicName: topic.name as string,
            subjectName,
            masteryScore: mastery ? Number(mastery.mastery_score) : null,
            attemptsOnTopic: mastery ? Number(mastery.total_attempts) : 0,
            recentAccuracyPercent:
                mastery?.recent_accuracy === null || mastery?.recent_accuracy === undefined
                    ? null
                    : Math.round(Number(mastery.recent_accuracy)),
            recentMistakes,
        };
    }
}
