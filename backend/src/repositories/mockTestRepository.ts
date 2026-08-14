import type { SupabaseClient } from '@supabase/supabase-js';
import type { PracticeQuestion } from '@/repositories/questionRepository.js';

export interface MockTestRow {
    id: string;
    plan_id: string | null;
    title: string;
    source: string;
    status: string;
    total_questions: number;
    duration_minutes: number;
    correct_count: number | null;
    score_percent: number | null;
    seconds_taken: number | null;
    started_at: string;
    submitted_at: string | null;
}

/** A question inside a test, with what was answered. Never the correct answer. */
export interface MockTestQuestionRow {
    question_id: string;
    topic_id: string | null;
    sort_order: number;
    given_answer: unknown;
    is_correct: boolean | null;
}

/**
 * Mock tests and their questions.
 *
 * Writes need an elevated client: both tables grant learners SELECT and nothing else. That is
 * load-bearing rather than conventional — `is_correct` on a question row *is* the marking, so a
 * learner able to write it could mark their own paper.
 */
export class MockTestRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async findRecent(userId: string, limit = 10): Promise<MockTestRow[]> {
        const { data, error } = await this.db
            .from('mock_tests')
            .select(
                'id, plan_id, title, source, status, total_questions, duration_minutes, correct_count, score_percent, seconds_taken, started_at, submitted_at'
            )
            .eq('user_id', userId)
            .order('started_at', { ascending: false })
            .limit(limit);

        if (error) throw error;
        return (data ?? []) as MockTestRow[];
    }

    /**
     * A test, checking ownership explicitly.
     *
     * The user id filter is load-bearing, not decorative: this runs with the elevated client, which
     * bypasses row-level security, so nothing else would stop one learner reading another's paper.
     */
    async findTest(testId: string, userId: string): Promise<MockTestRow | null> {
        const { data, error } = await this.db
            .from('mock_tests')
            .select(
                'id, plan_id, title, source, status, total_questions, duration_minutes, correct_count, score_percent, seconds_taken, started_at, submitted_at'
            )
            .eq('id', testId)
            .eq('user_id', userId)
            .maybeSingle();

        if (error) throw error;
        return data as MockTestRow | null;
    }

    /** An unfinished test, so a learner is offered the one they left rather than a new one. */
    async findOpenTest(userId: string): Promise<MockTestRow | null> {
        const { data, error } = await this.db
            .from('mock_tests')
            .select(
                'id, plan_id, title, source, status, total_questions, duration_minutes, correct_count, score_percent, seconds_taken, started_at, submitted_at'
            )
            .eq('user_id', userId)
            .eq('status', 'in_progress')
            .order('started_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return data as MockTestRow | null;
    }

    async findTestQuestions(testId: string): Promise<MockTestQuestionRow[]> {
        const { data, error } = await this.db
            .from('mock_test_questions')
            .select('question_id, topic_id, sort_order, given_answer, is_correct')
            .eq('test_id', testId)
            .order('sort_order');

        if (error) throw error;
        return (data ?? []) as MockTestQuestionRow[];
    }

    /**
     * The question bodies for a test, in the test's own order.
     *
     * The `select` list is the same one practice uses and stops at the same place: no
     * `correct_answer`, no `explanation`. Withholding the answer is the entire reason mock tests are
     * not just practice with a timer, and the safest way to not leak a column is to not select it.
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
     * Verified questions on a topic the learner has not already been asked in an open test.
     *
     * Unseen-in-*this-test* rather than unseen-ever: a mock test is meant to measure, and refusing to
     * reuse a question somebody answered a month ago would empty the bank and make repeat tests
     * impossible.
     */
    async findQuestionsForTopic(topicId: string, limit: number): Promise<{ id: string }[]> {
        const { data, error } = await this.db
            .from('questions')
            .select('id')
            .eq('topic_id', topicId)
            .eq('is_verified', true)
            .limit(limit);

        if (error) throw error;
        return (data ?? []) as { id: string }[];
    }

    /** How many verified questions a topic has, for the allocation. */
    async countQuestionsByTopic(topicIds: string[]): Promise<Map<string, number>> {
        const counts = new Map<string, number>();
        if (topicIds.length === 0) return counts;

        const { data, error } = await this.db
            .from('questions')
            .select('topic_id')
            .in('topic_id', topicIds)
            .eq('is_verified', true);

        if (error) throw error;

        for (const row of (data ?? []) as { topic_id: string }[]) {
            counts.set(row.topic_id, (counts.get(row.topic_id) ?? 0) + 1);
        }

        return counts;
    }

    /**
     * Topics the learner's plan has scheduled, with how many sessions each.
     *
     * Pending and past sessions both count. A test is about whether the studying is working, and a
     * topic scheduled for tomorrow is as much part of the plan being tested as one from last week.
     */
    async findPlanTopics(planId: string): Promise<{ topicId: string; plannedSessions: number }[]> {
        const { data, error } = await this.db
            .from('study_sessions')
            .select('topic_id')
            .eq('plan_id', planId);

        if (error) throw error;

        const counts = new Map<string, number>();
        for (const row of (data ?? []) as { topic_id: string }[]) {
            counts.set(row.topic_id, (counts.get(row.topic_id) ?? 0) + 1);
        }

        return [...counts.entries()].map(([topicId, plannedSessions]) => ({
            topicId,
            plannedSessions,
        }));
    }

    /** Names, subjects and weights for a set of topics. */
    async findTopicDetails(
        topicIds: string[]
    ): Promise<Map<string, { name: string; subjectName: string | null; weight: number }>> {
        const details = new Map<
            string,
            { name: string; subjectName: string | null; weight: number }
        >();

        if (topicIds.length === 0) return details;

        const { data, error } = await this.db
            .from('topics')
            .select('id, name, weight, parent_id')
            .in('id', topicIds);

        if (error) throw error;

        const rows = (data ?? []) as {
            id: string;
            name: string;
            weight: number;
            parent_id: string | null;
        }[];

        const parentIds = [
            ...new Set(rows.map((row) => row.parent_id).filter(Boolean)),
        ] as string[];

        const subjects = new Map<string, string>();

        if (parentIds.length > 0) {
            const { data: parents } = await this.db
                .from('topics')
                .select('id, name')
                .in('id', parentIds);

            for (const parent of (parents ?? []) as { id: string; name: string }[]) {
                subjects.set(parent.id, parent.name);
            }
        }

        for (const row of rows) {
            details.set(row.id, {
                name: row.name,
                subjectName: row.parent_id ? (subjects.get(row.parent_id) ?? null) : null,
                weight: Number(row.weight),
            });
        }

        return details;
    }

    async createTest(test: {
        userId: string;
        planId: string | null;
        title: string;
        source: 'plan' | 'goal';
        totalQuestions: number;
        durationMinutes: number;
    }): Promise<MockTestRow> {
        const { data, error } = await this.db
            .from('mock_tests')
            .insert({
                user_id: test.userId,
                plan_id: test.planId,
                title: test.title,
                source: test.source,
                total_questions: test.totalQuestions,
                duration_minutes: test.durationMinutes,
            })
            .select(
                'id, plan_id, title, source, status, total_questions, duration_minutes, correct_count, score_percent, seconds_taken, started_at, submitted_at'
            )
            .single();

        if (error) throw error;
        return data as MockTestRow;
    }

    /** All the test's questions in one request — a paper is fifteen rows, not fifteen round trips. */
    async addQuestions(testId: string, questionIds: string[]): Promise<void> {
        if (questionIds.length === 0) return;

        const { error } = await this.db.from('mock_test_questions').insert(
            questionIds.map((questionId, index) => ({
                test_id: testId,
                question_id: questionId,
                sort_order: index,
            }))
        );

        if (error) throw error;
    }

    /**
     * Writes the marking for every question, grouped so identical updates share a request.
     *
     * Grouped by (is_correct, answered) rather than one update per question: a fifteen-question paper
     * settles in at most three requests instead of fifteen.
     */
    async markQuestions(
        testId: string,
        marks: { questionId: string; givenAnswer: unknown; isCorrect: boolean }[]
    ): Promise<void> {
        for (const mark of marks) {
            const { error } = await this.db
                .from('mock_test_questions')
                .update({ given_answer: mark.givenAnswer, is_correct: mark.isCorrect })
                .eq('test_id', testId)
                .eq('question_id', mark.questionId);

            if (error) throw error;
        }
    }

    async submitTest(
        testId: string,
        result: { correctCount: number; scorePercent: number; secondsTaken: number }
    ): Promise<MockTestRow> {
        const { data, error } = await this.db
            .from('mock_tests')
            .update({
                status: 'submitted',
                submitted_at: new Date().toISOString(),
                correct_count: result.correctCount,
                score_percent: result.scorePercent,
                seconds_taken: result.secondsTaken,
            })
            .eq('id', testId)
            .select(
                'id, plan_id, title, source, status, total_questions, duration_minutes, correct_count, score_percent, seconds_taken, started_at, submitted_at'
            )
            .single();

        if (error) throw error;
        return data as MockTestRow;
    }

    /** Retires an unfinished test so a fresh one can be generated. */
    async abandonOpenTests(userId: string): Promise<void> {
        const { error } = await this.db
            .from('mock_tests')
            .update({ status: 'abandoned' })
            .eq('user_id', userId)
            .eq('status', 'in_progress');

        if (error) throw error;
    }
}
