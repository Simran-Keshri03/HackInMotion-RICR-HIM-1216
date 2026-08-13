import type { SupabaseClient } from '@supabase/supabase-js';

/** The learner-level cache row from 007_learner_profiles. */
export interface LearnerProfileRow {
    total_attempts: number;
    correct_attempts: number;
    overall_accuracy: number | null;
    avg_seconds_per_question: number | null;
    consistency_score: number | null;
    current_streak_days: number;
    longest_streak_days: number;
    last_activity_date: string | null;
    preferred_difficulty: 'easy' | 'medium' | 'hard' | null;
    computed_at: string;
}

/** One per-topic mastery row from 008_concept_mastery, with the topic's name joined in. */
export interface MasteryRow {
    topic_id: string;
    mastery_score: number;
    total_attempts: number;
    accuracy: number | null;
    recent_accuracy: number | null;
    last_attempt_at: string | null;
    topics: { name: string; weight: number } | null;
}

/**
 * All database access for the learner model lives here. Controllers never touch the
 * database directly, so if a query needs changing there is exactly one place to look.
 *
 * The client is injected rather than imported, which is what lets a caller decide
 * whether this repository runs as the learner (RLS enforced) or with elevated rights.
 */
export class LearnerRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async findProfile(userId: string): Promise<LearnerProfileRow | null> {
        const { data, error } = await this.db
            .from('learner_profiles')
            .select(
                'total_attempts, correct_attempts, overall_accuracy, avg_seconds_per_question, consistency_score, current_streak_days, longest_streak_days, last_activity_date, preferred_difficulty, computed_at'
            )
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        return data as LearnerProfileRow | null;
    }

    /**
     * Bumps the learner-level counters after one answer. Needs an elevated client.
     *
     * ponytail: counters and last-active date only. Streaks, consistency and average
     * answer time need a day-by-day pass over the history, which belongs with the
     * retention work rather than on the hot path of every submitted answer.
     */
    async recordAttemptOnProfile(
        userId: string,
        wasCorrect: boolean,
        today: string
    ): Promise<void> {
        const current = await this.findProfile(userId);

        const { error } = await this.db
            .from('learner_profiles')
            .update({
                total_attempts: (current?.total_attempts ?? 0) + 1,
                correct_attempts:
                    (current?.correct_attempts ?? 0) + (wasCorrect ? 1 : 0),
                last_activity_date: today,
                computed_at: new Date().toISOString(),
            })
            .eq('user_id', userId);

        if (error) throw error;
    }

    /** Weakest topics first, because that is what every caller actually wants. */
    async findMastery(userId: string, limit: number): Promise<MasteryRow[]> {
        const { data, error } = await this.db
            .from('concept_mastery')
            .select(
                'topic_id, mastery_score, total_attempts, accuracy, recent_accuracy, last_attempt_at, topics(name, weight)'
            )
            .eq('user_id', userId)
            .order('mastery_score', { ascending: true })
            .limit(limit);

        if (error) throw error;
        return (data ?? []) as unknown as MasteryRow[];
    }
}
