import type { SupabaseClient } from '@supabase/supabase-js';
import type { TopicCandidate } from '@/services/adaptive/recommendationEngine.js';

interface TopicRow {
    id: string;
    name: string;
    weight: number;
    parent_id: string | null;
}

interface MasteryRow {
    topic_id: string;
    mastery_score: number;
    recent_accuracy: number | null;
    recent_attempts: number;
    total_attempts: number;
    last_attempt_at: string | null;
}

/**
 * Builds the candidate list the adaptive engine ranks.
 *
 * Scope comes from the learner's active goal: a goal row may name a subject, which stands
 * for every topic beneath it, or a single topic. Only leaf topics are candidates, because
 * "practise Database Systems" is not an instruction anybody can act on.
 *
 * With no goal yet the whole syllabus is offered, so a learner can start practising before
 * they have set one up.
 */
export class TopicRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async findCandidatesForLearner(
        userId: string,
        now: Date,
        /**
         * Narrows the ranking to one subject the learner picked.
         *
         * Intersected with the goal's scope rather than replacing it: a subject id arrives from the
         * client, and without the intersection somebody could pass any subject in the database and
         * practise outside their own goal. Not a security hole — no answers leak either way — but it
         * would quietly make the goal meaningless, which is the whole basis of the ranking.
         */
        subjectId?: string | null
    ): Promise<TopicCandidate[]> {
        const goalScope = await this.findActiveGoalScope(userId);

        const scopeIds = subjectId ? goalScope.filter((id) => id === subjectId) : goalScope;

        // A subject that is not in the goal narrows the scope to nothing, which the caller reports as
        // an empty state rather than silently falling back to the whole syllabus.
        if (subjectId && scopeIds.length === 0) return [];
        const topics = await this.findLeafTopics(scopeIds);

        if (topics.length === 0) return [];

        const mastery = await this.findMastery(userId);

        return topics.map((topic) => {
            const row = mastery.get(topic.id);

            return {
                topicId: topic.id,
                name: topic.name,
                weight: Number(topic.weight),
                masteryScore: row ? Number(row.mastery_score) : null,
                // Stored as a percentage; the engine works in 0 to 1.
                recentAccuracy:
                    row?.recent_accuracy === null || row?.recent_accuracy === undefined
                        ? null
                        : Number(row.recent_accuracy) / 100,
                recentAttempts: row?.recent_attempts ?? 0,
                totalAttempts: row?.total_attempts ?? 0,
                daysSinceLastAttempt: daysSince(row?.last_attempt_at ?? null, now),
            };
        });
    }

    /** Topic ids named by the active goal. Empty means "no goal, use everything". */
    private async findActiveGoalScope(userId: string): Promise<string[]> {
        const { data: goal, error: goalError } = await this.db
            .from('learning_goals')
            .select('id')
            .eq('user_id', userId)
            .eq('status', 'active')
            .maybeSingle();

        if (goalError) throw goalError;
        if (!goal) return [];

        const { data, error } = await this.db
            .from('learning_goal_topics')
            .select('topic_id')
            .eq('goal_id', goal.id);

        if (error) throw error;
        return (data ?? []).map((row) => row.topic_id as string);
    }

    private async findLeafTopics(scopeIds: string[]): Promise<TopicRow[]> {
        let query = this.db.from('topics').select('id, name, weight, parent_id');

        if (scopeIds.length > 0) {
            // A scope entry matches either the topic itself or its parent subject.
            const list = scopeIds.join(',');
            query = query.or(`id.in.(${list}),parent_id.in.(${list})`);
        }

        const { data, error } = await query;
        if (error) throw error;

        // Subjects are containers, not something to practise.
        return ((data ?? []) as TopicRow[]).filter((row) => row.parent_id !== null);
    }

    private async findMastery(userId: string): Promise<Map<string, MasteryRow>> {
        const { data, error } = await this.db
            .from('concept_mastery')
            .select(
                'topic_id, mastery_score, recent_accuracy, recent_attempts, total_attempts, last_attempt_at'
            )
            .eq('user_id', userId);

        if (error) throw error;

        return new Map(((data ?? []) as MasteryRow[]).map((row) => [row.topic_id, row]));
    }
}

function daysSince(timestamp: string | null, now: Date): number | null {
    if (!timestamp) return null;

    const millisecondsPerDay = 86_400_000;
    return Math.max(0, (now.getTime() - new Date(timestamp).getTime()) / millisecondsPerDay);
}
