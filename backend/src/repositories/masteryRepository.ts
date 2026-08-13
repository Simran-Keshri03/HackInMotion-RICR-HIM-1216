import type { SupabaseClient } from '@supabase/supabase-js';
import type { MasteryResult } from '@/services/learner/masteryEngine.js';
import type { TopicEvidence } from '@/services/learner/masteryEngine.js';

/** Which version of the formula produced the stored numbers. Bump when weights change. */
export const MASTERY_FORMULA_VERSION = 1;

/**
 * Writes the per-topic mastery cache.
 *
 * The row is written whole rather than incremented, which is what keeps the database's
 * "difficulty buckets must add up to total_attempts" constraint satisfied by construction.
 * Needs an elevated client: learners may read this table but never write it.
 */
export class MasteryRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async findScore(userId: string, topicId: string): Promise<number | null> {
        const { data, error } = await this.db
            .from('concept_mastery')
            .select('mastery_score')
            .eq('user_id', userId)
            .eq('topic_id', topicId)
            .maybeSingle();

        if (error) throw error;
        return data ? Number(data.mastery_score) : null;
    }

    async save(
        userId: string,
        topicId: string,
        evidence: TopicEvidence,
        mastery: MasteryResult,
        lastAttemptAt: string,
        lastCorrectAt: string | null
    ): Promise<void> {
        const { error } = await this.db.from('concept_mastery').upsert(
            {
                user_id: userId,
                topic_id: topicId,
                mastery_score: mastery.score,
                total_attempts: evidence.totalAttempts,
                correct_attempts: evidence.correctAttempts,
                recent_attempts: evidence.recentAttempts,
                recent_correct: evidence.recentCorrect,
                easy_attempts: evidence.easy.attempts,
                easy_correct: evidence.easy.correct,
                medium_attempts: evidence.medium.attempts,
                medium_correct: evidence.medium.correct,
                hard_attempts: evidence.hard.attempts,
                hard_correct: evidence.hard.correct,
                correct_streak: evidence.correctStreak,
                last_attempt_at: lastAttemptAt,
                last_correct_at: lastCorrectAt,
                computed_at: new Date().toISOString(),
                computed_version: MASTERY_FORMULA_VERSION,
            },
            { onConflict: 'user_id,topic_id' }
        );

        if (error) throw error;
    }
}
