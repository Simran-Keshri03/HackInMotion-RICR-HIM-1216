import type { SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '@/utils/http.js';

/** A question with the parts only the server may see. */
export interface QuestionForGrading {
    id: string;
    topic_id: string;
    question_type: 'mcq' | 'msq' | 'numeric';
    correct_answer: unknown;
    explanation: string | null;
    difficulty: 'easy' | 'medium' | 'hard';
    is_verified: boolean;
}

export interface AttemptRow {
    is_correct: boolean;
    attempted_at: string;
    questions: { difficulty: 'easy' | 'medium' | 'hard' } | null;
}

export interface NewAttempt {
    userId: string;
    questionId: string;
    isCorrect: boolean;
    givenAnswer: unknown;
    timeTakenSeconds: number | null;
    source: 'practice' | 'assessment' | 'topic_test' | 'mock_test' | 'revision';
}

/**
 * Attempt storage and the privileged question read that grading needs.
 *
 * Every method here expects an elevated client, because reading correct_answer and writing
 * to an append-only log are both things a learner is deliberately not allowed to do.
 * That makes the user id argument load-bearing: nothing below will filter for us.
 */
export class AttemptRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    /** The question plus its answer. Unverified questions are treated as not existing. */
    async findForGrading(questionId: string): Promise<QuestionForGrading> {
        const { data, error } = await this.db
            .from('questions')
            .select(
                'id, topic_id, question_type, correct_answer, explanation, difficulty, is_verified'
            )
            .eq('id', questionId)
            .maybeSingle();

        if (error) throw error;

        if (!data || !data.is_verified) {
            throw new AppError(
                404,
                'QUESTION_NOT_FOUND',
                'That question does not exist or is not available yet.'
            );
        }

        return data as QuestionForGrading;
    }

    /** topic_id and attempt_number are filled in by a database trigger, not by us. */
    /**
     * Attempts by id, for a paper that recorded which attempt answered which question.
     *
     * An assessment stores only the link — `assessment_questions.attempt_id` — rather than copying the
     * outcome, so the breakdown afterwards has to come back through here. That is the right way round:
     * two copies of "was this correct" is two things that can disagree.
     */
    async findByIds(
        attemptIds: string[]
    ): Promise<{ id: string; topic_id: string; is_correct: boolean }[]> {
        if (attemptIds.length === 0) return [];

        const { data, error } = await this.db
            .from('question_attempts')
            .select('id, topic_id, is_correct')
            .in('id', attemptIds);

        if (error) throw error;
        return (data ?? []) as { id: string; topic_id: string; is_correct: boolean }[];
    }

    async insert(attempt: NewAttempt): Promise<{ id: string; topicId: string }> {
        const { data, error } = await this.db
            .from('question_attempts')
            .insert({
                user_id: attempt.userId,
                question_id: attempt.questionId,
                is_correct: attempt.isCorrect,
                given_answer: attempt.givenAnswer,
                time_taken_seconds: attempt.timeTakenSeconds,
                source: attempt.source,
            })
            .select('id, topic_id')
            .single();

        if (error) throw error;
        return { id: data.id as string, topicId: data.topic_id as string };
    }

    /**
     * Every attempt on one topic, newest first, with the difficulty joined in from the
     * question. Mastery is recomputed from this rather than nudged, so the cache can never
     * drift from the history it summarises.
     */
    async findTopicAttempts(userId: string, topicId: string): Promise<AttemptRow[]> {
        const { data, error } = await this.db
            .from('question_attempts')
            .select('is_correct, attempted_at, questions(difficulty)')
            .eq('user_id', userId)
            .eq('topic_id', topicId)
            .order('attempted_at', { ascending: false })
            // ponytail: a safety ceiling, not a real limit. Nobody answers a thousand
            // questions on one topic during a hackathon demo. If that changes, aggregate
            // in SQL instead of reading the rows.
            .limit(1000);

        if (error) throw error;
        return (data ?? []) as unknown as AttemptRow[];
    }
}
