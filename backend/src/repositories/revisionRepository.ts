import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReviewState, ScheduleUpdate } from '@/services/learner/srsEngine.js';

export interface DueTopic {
    topicId: string;
    name: string;
    subjectName: string | null;
    dueOn: string;
    intervalDays: number;
    lapses: number;
    reviewCount: number;
    lastReviewAccuracy: number | null;
    masteryScore: number | null;
}

/**
 * The revision schedule.
 *
 * Writes need an elevated client: the table grants learners SELECT and nothing else, because somebody
 * who could push their own due dates out could remove every topic they found hard from their
 * revision list — which is the exact topic the schedule exists to bring back.
 */
export class RevisionRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async findState(userId: string, topicId: string): Promise<ReviewState | null> {
        const { data, error } = await this.db
            .from('revision_schedule')
            .select('interval_days, ease_factor, review_count, lapses, last_reviewed_on')
            .eq('user_id', userId)
            .eq('topic_id', topicId)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;

        return {
            intervalDays: Number(data.interval_days),
            easeFactor: Number(data.ease_factor),
            reviewCount: Number(data.review_count),
            lapses: Number(data.lapses),
            lastReviewedOn: (data.last_reviewed_on as string | null) ?? null,
        };
    }

    /** Writes the schedule for a topic, creating the row on the first review. */
    async save(userId: string, topicId: string, update: ScheduleUpdate): Promise<void> {
        const { error } = await this.db.from('revision_schedule').upsert(
            {
                user_id: userId,
                topic_id: topicId,
                due_on: update.dueOn,
                interval_days: update.intervalDays,
                ease_factor: update.easeFactor,
                review_count: update.reviewCount,
                lapses: update.lapses,
                last_reviewed_on: update.lastReviewedOn,
                last_review_accuracy: update.lastReviewAccuracy,
            },
            { onConflict: 'user_id,topic_id' }
        );

        if (error) throw error;
    }

    /**
     * Topics owed a review, longest overdue first.
     *
     * That order is the whole premise of the schedule: the topic furthest past its due date is the
     * one closest to being forgotten, so it is the one worth the learner's next minutes.
     *
     * Two queries rather than an embed — an embed on this project has silently returned nothing once
     * already, with no error, and the plan quietly losing its revision slots is exactly the kind of
     * failure nobody would notice.
     */
    async findDue(
        userId: string,
        today: string,
        scopeIds: string[],
        limit = 20
    ): Promise<DueTopic[]> {
        const { data, error } = await this.db
            .from('revision_schedule')
            .select('topic_id, due_on, interval_days, lapses, review_count, last_review_accuracy')
            .eq('user_id', userId)
            .lte('due_on', today)
            .order('due_on')
            .limit(limit);

        if (error) throw error;

        const rows = (data ?? []) as {
            topic_id: string;
            due_on: string;
            interval_days: number;
            lapses: number;
            review_count: number;
            last_review_accuracy: number | null;
        }[];

        if (rows.length === 0) return [];

        const { data: topics, error: topicError } = await this.db
            .from('topics')
            .select('id, name, parent_id')
            .in(
                'id',
                rows.map((row) => row.topic_id)
            );

        if (topicError) throw topicError;

        const topicRows = (topics ?? []) as {
            id: string;
            name: string;
            parent_id: string | null;
        }[];

        // Subject names, for a revision list that says "Normalisation (Databases)" rather than a
        // bare topic somebody has to place from memory.
        const parentIds = [
            ...new Set(topicRows.map((row) => row.parent_id).filter(Boolean)),
        ] as string[];

        const subjectNames = new Map<string, string>();

        if (parentIds.length > 0) {
            const { data: parents } = await this.db
                .from('topics')
                .select('id, name')
                .in('id', parentIds);

            for (const parent of (parents ?? []) as { id: string; name: string }[]) {
                subjectNames.set(parent.id, parent.name);
            }
        }

        const { data: mastery, error: masteryError } = await this.db
            .from('concept_mastery')
            .select('topic_id, mastery_score')
            .eq('user_id', userId)
            .in(
                'topic_id',
                rows.map((row) => row.topic_id)
            );

        if (masteryError) throw masteryError;

        const scores = new Map(
            ((mastery ?? []) as { topic_id: string; mastery_score: number }[]).map((row) => [
                row.topic_id,
                Number(row.mastery_score),
            ])
        );

        const byId = new Map(topicRows.map((row) => [row.id, row]));

        /**
         * Restricted to what the current goal covers.
         *
         * A learner who switched from class 10 to GATE still has class 10 schedules, and putting
         * Trigonometry in a GATE revision list would be worse than useless. Filtered here rather
         * than deleting the old rows, because switching back should not have lost the history.
         */
        const inScope = (topic: { id: string; parent_id: string | null }) =>
            scopeIds.length === 0 ||
            scopeIds.includes(topic.id) ||
            (topic.parent_id !== null && scopeIds.includes(topic.parent_id));

        return rows
            .map((row) => {
                const topic = byId.get(row.topic_id);
                if (!topic || !inScope(topic)) return null;

                return {
                    topicId: row.topic_id,
                    name: topic.name,
                    subjectName: topic.parent_id
                        ? (subjectNames.get(topic.parent_id) ?? null)
                        : null,
                    dueOn: row.due_on,
                    intervalDays: Number(row.interval_days),
                    lapses: Number(row.lapses),
                    reviewCount: Number(row.review_count),
                    lastReviewAccuracy:
                        row.last_review_accuracy === null ? null : Number(row.last_review_accuracy),
                    masteryScore: scores.get(row.topic_id) ?? null,
                };
            })
            .filter((row): row is DueTopic => row !== null);
    }
}
