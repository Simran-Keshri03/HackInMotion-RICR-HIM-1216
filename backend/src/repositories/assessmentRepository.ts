import type { SupabaseClient } from '@supabase/supabase-js';
import type { PracticeQuestion } from '@/repositories/questionRepository.js';

export interface AssessmentRow {
    id: string;
    goal_id: string;
    kind: string;
    status: string;
    question_count: number;
    correct_count: number;
    accuracy: number | null;
    started_at: string;
    completed_at: string | null;
}

export interface AssessmentQuestionRow {
    question_id: string;
    position: number;
    attempt_id: string | null;
}

/**
 * Diagnostic assessments.
 *
 * Writes need an elevated client: both tables grant learners SELECT and nothing else, and marking reads
 * `questions.correct_answer`, which the browser holds no privilege on.
 */
export class AssessmentRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    /**
     * The diagnostic for a goal, if one exists.
     *
     * One per goal, not one per learner: a new goal is a new syllabus, so a measurement taken against
     * the old one says nothing useful about it.
     */
    async findForGoal(userId: string, goalId: string): Promise<AssessmentRow | null> {
        const { data, error } = await this.db
            .from('assessments')
            .select(
                'id, goal_id, kind, status, question_count, correct_count, accuracy, started_at, completed_at'
            )
            .eq('user_id', userId)
            .eq('goal_id', goalId)
            .eq('kind', 'diagnostic')
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return data as AssessmentRow | null;
    }

    /** Ownership is checked here, because the elevated client bypasses row-level security. */
    async find(assessmentId: string, userId: string): Promise<AssessmentRow | null> {
        const { data, error } = await this.db
            .from('assessments')
            .select(
                'id, goal_id, kind, status, question_count, correct_count, accuracy, started_at, completed_at'
            )
            .eq('id', assessmentId)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        return data as AssessmentRow | null;
    }

    async findQuestions(assessmentId: string): Promise<AssessmentQuestionRow[]> {
        const { data, error } = await this.db
            .from('assessment_questions')
            .select('question_id, position, attempt_id')
            .eq('assessment_id', assessmentId)
            .order('position');

        if (error) throw error;
        return (data ?? []) as AssessmentQuestionRow[];
    }

    /**
     * Question bodies, in the paper's order.
     *
     * The same seven columns practice asks for, stopping at the same place: no `correct_answer`, no
     * `explanation`. A diagnostic is marked at the end, so sending the answers with the paper would
     * defeat the measurement.
     */
    async findQuestionBodies(questionIds: string[]): Promise<PracticeQuestion[]> {
        if (questionIds.length === 0) return [];

        const { data, error } = await this.db
            .from('questions')
            .select('id, topic_id, question_type, body, options, difficulty, marks')
            .in('id', questionIds);

        if (error) throw error;
        return (data ?? []) as PracticeQuestion[];
    }

    /**
     * The goal's topics, with their subject and how many verified questions each has.
     *
     * Two queries and a join in memory rather than an embed. An embed on this project has silently
     * returned nothing once already, and a diagnostic quietly built from no topics would look like an
     * empty question bank rather than a bug.
     */
    async findAssessableTopics(goalId: string): Promise<
        {
            topicId: string;
            name: string;
            subjectId: string;
            subjectName: string;
            subjectWeight: number;
            availableQuestions: number;
        }[]
    > {
        const { data: scope, error: scopeError } = await this.db
            .from('learning_goal_topics')
            .select('topic_id')
            .eq('goal_id', goalId);

        if (scopeError) throw scopeError;

        const subjectIds = ((scope ?? []) as { topic_id: string }[]).map((r) => r.topic_id);
        if (subjectIds.length === 0) return [];

        const { data: subjects, error: subjectError } = await this.db
            .from('topics')
            .select('id, name, weight')
            .in('id', subjectIds);

        if (subjectError) throw subjectError;

        const { data: leaves, error: leafError } = await this.db
            .from('topics')
            .select('id, name, parent_id')
            .in('parent_id', subjectIds);

        if (leafError) throw leafError;

        const leafRows = (leaves ?? []) as {
            id: string;
            name: string;
            parent_id: string;
        }[];

        if (leafRows.length === 0) return [];

        const { data: questions, error: questionError } = await this.db
            .from('questions')
            .select('topic_id')
            .in(
                'topic_id',
                leafRows.map((row) => row.id)
            )
            .eq('is_verified', true);

        if (questionError) throw questionError;

        const counts = new Map<string, number>();
        for (const row of (questions ?? []) as { topic_id: string }[]) {
            counts.set(row.topic_id, (counts.get(row.topic_id) ?? 0) + 1);
        }

        const subjectById = new Map(
            ((subjects ?? []) as { id: string; name: string; weight: number }[]).map((row) => [
                row.id,
                row,
            ])
        );

        return leafRows.flatMap((leaf) => {
            const parent = subjectById.get(leaf.parent_id);
            if (!parent) return [];

            return [
                {
                    topicId: leaf.id,
                    name: leaf.name,
                    subjectId: parent.id,
                    subjectName: parent.name,
                    subjectWeight: Number(parent.weight),
                    availableQuestions: counts.get(leaf.id) ?? 0,
                },
            ];
        });
    }

    /** One verified question on a topic. */
    async findOneQuestionForTopic(topicId: string): Promise<string | null> {
        const { data, error } = await this.db
            .from('questions')
            .select('id')
            .eq('topic_id', topicId)
            .eq('is_verified', true)
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return (data?.id as string | undefined) ?? null;
    }

    /** Subject and topic names for a set of topics, for the breakdown. */
    async findTopicSubjects(
        topicIds: string[]
    ): Promise<Map<string, { subjectId: string; subjectName: string }>> {
        const result = new Map<string, { subjectId: string; subjectName: string }>();
        if (topicIds.length === 0) return result;

        const { data: topics, error } = await this.db
            .from('topics')
            .select('id, parent_id')
            .in('id', topicIds);

        if (error) throw error;

        const rows = (topics ?? []) as { id: string; parent_id: string | null }[];
        const parentIds = [...new Set(rows.map((r) => r.parent_id).filter(Boolean))] as string[];

        const names = new Map<string, string>();

        if (parentIds.length > 0) {
            const { data: parents } = await this.db
                .from('topics')
                .select('id, name')
                .in('id', parentIds);

            for (const parent of (parents ?? []) as { id: string; name: string }[]) {
                names.set(parent.id, parent.name);
            }
        }

        for (const row of rows) {
            if (!row.parent_id) continue;

            result.set(row.id, {
                subjectId: row.parent_id,
                subjectName: names.get(row.parent_id) ?? 'Subject',
            });
        }

        return result;
    }

    async create(assessment: {
        userId: string;
        goalId: string;
        questionCount: number;
    }): Promise<AssessmentRow> {
        const { data, error } = await this.db
            .from('assessments')
            .insert({
                user_id: assessment.userId,
                goal_id: assessment.goalId,
                kind: 'diagnostic',
                question_count: assessment.questionCount,
            })
            .select(
                'id, goal_id, kind, status, question_count, correct_count, accuracy, started_at, completed_at'
            )
            .single();

        if (error) throw error;
        return data as AssessmentRow;
    }

    /** Every question of the paper in one request. */
    async addQuestions(assessmentId: string, questionIds: string[]): Promise<void> {
        if (questionIds.length === 0) return;

        const { error } = await this.db.from('assessment_questions').insert(
            questionIds.map((questionId, index) => ({
                assessment_id: assessmentId,
                question_id: questionId,
                position: index + 1,
            }))
        );

        if (error) throw error;
    }

    /** Links a question to the attempt that answered it. */
    async linkAttempt(assessmentId: string, questionId: string, attemptId: string): Promise<void> {
        const { error } = await this.db
            .from('assessment_questions')
            .update({ attempt_id: attemptId })
            .eq('assessment_id', assessmentId)
            .eq('question_id', questionId);

        if (error) throw error;
    }

    async complete(assessmentId: string, correctCount: number): Promise<AssessmentRow> {
        const { data, error } = await this.db
            .from('assessments')
            .update({
                status: 'completed',
                correct_count: correctCount,
                completed_at: new Date().toISOString(),
            })
            .eq('id', assessmentId)
            .select(
                'id, goal_id, kind, status, question_count, correct_count, accuracy, started_at, completed_at'
            )
            .single();

        if (error) throw error;
        return data as AssessmentRow;
    }

    /** Retires an unfinished diagnostic so a fresh one can be started. */
    async abandonOpen(userId: string, goalId: string): Promise<void> {
        const { error } = await this.db
            .from('assessments')
            .update({ status: 'abandoned' })
            .eq('user_id', userId)
            .eq('goal_id', goalId)
            .eq('status', 'in_progress');

        if (error) throw error;
    }
}
