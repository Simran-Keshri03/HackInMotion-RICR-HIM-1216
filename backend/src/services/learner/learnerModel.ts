import type { LearnerRepository } from '@/repositories/learnerRepository.js';

/** What the dashboard needs in one request. Small on purpose: it travels over 3G. */
export interface LearnerSummary {
    hasActivity: boolean;
    attempts: { total: number; correct: number; accuracyPercent: number | null };
    habits: {
        currentStreakDays: number;
        longestStreakDays: number;
        consistencyPercent: number | null;
        lastActiveDate: string | null;
        avgSecondsPerQuestion: number | null;
    };
    preferredDifficulty: 'easy' | 'medium' | 'hard' | null;
    weakestTopics: {
        topicId: string;
        name: string;
        masteryScore: number;
        attempts: number;
        accuracyPercent: number | null;
        recentAccuracyPercent: number | null;
    }[];
    /** When the cached numbers were last recalculated, so the UI can be honest about age. */
    computedAt: string | null;
}

/** How many weak topics the summary carries. Enough to act on, small enough to be cheap. */
const WEAK_TOPIC_LIMIT = 5;

/**
 * Reads the learner model and shapes it for the client.
 *
 * No scoring happens here -- mastery and consistency are computed by their own engines
 * and stored. This service's only job is to assemble a small, honest view of them, and
 * to answer sensibly when a learner has done nothing yet.
 */
export class LearnerModelService {
    private readonly learners: LearnerRepository;

    constructor(learners: LearnerRepository) {
        this.learners = learners;
    }

    async getSummary(userId: string): Promise<LearnerSummary> {
        const [profile, mastery] = await Promise.all([
            this.learners.findProfile(userId),
            this.learners.findMastery(userId, WEAK_TOPIC_LIMIT),
        ]);

        // A learner who has just signed up has a profile row full of zeros. That is a
        // real state, not an error, and the UI shows an empty state for it.
        return {
            hasActivity: (profile?.total_attempts ?? 0) > 0,
            attempts: {
                total: profile?.total_attempts ?? 0,
                correct: profile?.correct_attempts ?? 0,
                accuracyPercent: profile?.overall_accuracy ?? null,
            },
            habits: {
                currentStreakDays: profile?.current_streak_days ?? 0,
                longestStreakDays: profile?.longest_streak_days ?? 0,
                consistencyPercent: profile?.consistency_score ?? null,
                lastActiveDate: profile?.last_activity_date ?? null,
                avgSecondsPerQuestion: profile?.avg_seconds_per_question ?? null,
            },
            preferredDifficulty: profile?.preferred_difficulty ?? null,
            weakestTopics: mastery.map((row) => ({
                topicId: row.topic_id,
                name: row.topics?.name ?? 'Unknown topic',
                masteryScore: row.mastery_score,
                attempts: row.total_attempts,
                accuracyPercent: row.accuracy,
                recentAccuracyPercent: row.recent_accuracy,
            })),
            computedAt: profile?.computed_at ?? null,
        };
    }
}
