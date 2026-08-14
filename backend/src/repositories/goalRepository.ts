import type { SupabaseClient } from '@supabase/supabase-js';

export interface GoalRow {
    id: string;
    title: string;
    exam_date: string;
    daily_minutes: number;
    status: 'active' | 'archived';
    created_at: string;
    /** Null on goals created before curricula existed; their scope is still explicit topic ids. */
    curriculum_id: string | null;
}

export interface SubjectWithTopics {
    id: string;
    name: string;
    weight: number;
    topicCount: number;
}

/**
 * Learning goals and the slice of syllabus each one covers.
 *
 * Writes need an elevated client: the tables grant SELECT to learners and nothing else, so
 * creating a goal goes through the API where the interesting validation lives.
 */
export class GoalRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    /**
     * Subjects a learner can pick from, within one curriculum.
     *
     * Scoped rather than global: since curricula are shared, listing every subject in the table
     * would offer a class 10 learner somebody else's GATE subjects.
     */
    async findSubjects(curriculumId: string): Promise<SubjectWithTopics[]> {
        const { data, error } = await this.db
            .from('topics')
            .select('id, name, weight, parent_id')
            .eq('curriculum_id', curriculumId)
            .order('sort_order');

        if (error) throw error;

        const rows = (data ?? []) as {
            id: string;
            name: string;
            weight: number;
            parent_id: string | null;
        }[];

        const childCount = new Map<string, number>();
        for (const row of rows) {
            if (row.parent_id) {
                childCount.set(row.parent_id, (childCount.get(row.parent_id) ?? 0) + 1);
            }
        }

        return rows
            .filter((row) => row.parent_id === null)
            .map((row) => ({
                id: row.id,
                name: row.name,
                weight: Number(row.weight),
                topicCount: childCount.get(row.id) ?? 0,
            }));
    }

    async findActive(userId: string): Promise<GoalRow | null> {
        const { data, error } = await this.db
            .from('learning_goals')
            .select('id, title, exam_date, daily_minutes, status, created_at, curriculum_id')
            .eq('user_id', userId)
            .eq('status', 'active')
            .maybeSingle();

        if (error) throw error;
        return data as GoalRow | null;
    }

    /** Subject ids a goal covers, so the UI can show what was chosen. */
    async findScope(goalId: string): Promise<string[]> {
        const { data, error } = await this.db
            .from('learning_goal_topics')
            .select('topic_id')
            .eq('goal_id', goalId);

        if (error) throw error;
        return (data ?? []).map((row) => row.topic_id as string);
    }

    /**
     * Archives any existing active goal, then creates the new one.
     *
     * Archive rather than delete: the old goal's assessments and plans still point at it, and
     * a learner who changes their exam date has not erased what they did before. The database
     * enforces one active goal per learner with a partial unique index, so archiving first is
     * required, not a courtesy.
     */
    async replaceActive(
        userId: string,
        goal: {
            title: string;
            examDate: string;
            dailyMinutes: number;
            subjectIds: string[];
            curriculumId: string;
        }
    ): Promise<GoalRow> {
        const { error: archiveError } = await this.db
            .from('learning_goals')
            .update({ status: 'archived' })
            .eq('user_id', userId)
            .eq('status', 'active');

        if (archiveError) throw archiveError;

        const { data, error } = await this.db
            .from('learning_goals')
            .insert({
                user_id: userId,
                title: goal.title,
                exam_date: goal.examDate,
                daily_minutes: goal.dailyMinutes,
                curriculum_id: goal.curriculumId,
            })
            .select('id, title, exam_date, daily_minutes, status, created_at, curriculum_id')
            .single();

        if (error) throw error;

        const created = data as GoalRow;

        const { error: scopeError } = await this.db.from('learning_goal_topics').insert(
            goal.subjectIds.map((topicId) => ({
                goal_id: created.id,
                topic_id: topicId,
            }))
        );

        if (scopeError) throw scopeError;

        return created;
    }
}
