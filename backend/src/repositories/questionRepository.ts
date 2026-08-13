import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A question as the learner is allowed to receive it.
 *
 * Note what is missing: correct_answer and explanation. This is not a choice made here --
 * the `authenticated` role has no privilege on those columns at all, so asking for them
 * would fail. Answers arrive only in the response to a submitted attempt.
 */
export interface PracticeQuestion {
    id: string;
    topic_id: string;
    question_type: 'mcq' | 'msq' | 'numeric';
    body: string;
    options: string[] | null;
    difficulty: 'easy' | 'medium' | 'hard';
    marks: number;
}

const LEARNER_VISIBLE_COLUMNS =
    'id, topic_id, question_type, body, options, difficulty, marks';

export class QuestionRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    /** Question ids this learner has already attempted on a topic. */
    async findAttemptedIds(userId: string, topicId: string): Promise<string[]> {
        const { data, error } = await this.db
            .from('question_attempts')
            .select('question_id')
            .eq('user_id', userId)
            .eq('topic_id', topicId);

        if (error) throw error;

        return [...new Set((data ?? []).map((row) => row.question_id as string))];
    }

    /**
     * Questions for a topic, newest ideas first excluded rather than reshuffled: `exclude`
     * carries the ids the learner has already seen, so a practice set does not hand back
     * the same questions every time.
     *
     * `difficulty` of null means any, which is what the caller falls back to when a topic
     * does not have enough questions at the level it wanted.
     */
    async findForPractice(options: {
        topicId: string;
        difficulty: 'easy' | 'medium' | 'hard' | null;
        exclude: string[];
        limit: number;
    }): Promise<PracticeQuestion[]> {
        let query = this.db
            .from('questions')
            .select(LEARNER_VISIBLE_COLUMNS)
            .eq('topic_id', options.topicId);

        if (options.difficulty) {
            query = query.eq('difficulty', options.difficulty);
        }

        if (options.exclude.length > 0) {
            query = query.not('id', 'in', `(${options.exclude.join(',')})`);
        }

        const { data, error } = await query.limit(options.limit);

        if (error) throw error;
        return (data ?? []) as PracticeQuestion[];
    }

    // ---------------------------------------------------------------------
    // Question generation. These need an elevated client: they write to a table no
    // learner may write to, and they read across the whole bank.
    // ---------------------------------------------------------------------

    /** A topic with its subject name, which the generator needs for context. */
    async findTopicWithSubject(topicId: string): Promise<{
        id: string;
        name: string;
        subjectName: string;
    } | null> {
        const { data, error } = await this.db
            .from('topics')
            .select('id, name, parent_id')
            .eq('id', topicId)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;

        // Two plain queries rather than one embedded join. The PostgREST embed form for a
        // self-referencing foreign key silently returned nothing here, which meant the
        // generator was told a topic's subject was the topic itself -- wrong context, and
        // no error to notice. Explicit and boring beats clever and quietly wrong.
        let subjectName = data.name as string;

        if (data.parent_id) {
            const { data: parent, error: parentError } = await this.db
                .from('topics')
                .select('name')
                .eq('id', data.parent_id as string)
                .maybeSingle();

            if (parentError) throw parentError;
            if (parent) subjectName = parent.name as string;
        }

        return {
            id: data.id as string,
            name: data.name as string,
            // A subject has no parent, so it is its own context.
            subjectName,
        };
    }

    /** Existing question texts on a topic, so the generator does not repeat them. */
    async findBodiesForTopic(topicId: string, limit = 50): Promise<string[]> {
        const { data, error } = await this.db
            .from('questions')
            .select('body')
            .eq('topic_id', topicId)
            .limit(limit);

        if (error) throw error;
        return (data ?? []).map((row) => row.body as string);
    }

    /**
     * Stores one generated question. `isVerified` decides whether a learner will ever see
     * it -- the RLS policy on this table hides everything unverified.
     *
     * Returns null when the question already exists: the unique index on
     * (topic_id, md5(body)) means a duplicate is refused by the database rather than
     * something this code has to check for.
     */
    async insertGenerated(question: {
        topicId: string;
        questionType: 'mcq' | 'msq';
        body: string;
        options: string[];
        correctOptionIndexes: number[];
        explanation: string;
        difficulty: 'easy' | 'medium' | 'hard';
        isVerified: boolean;
        createdBy: string | null;
    }): Promise<{ id: string } | null> {
        const { data, error } = await this.db
            .from('questions')
            .insert({
                topic_id: question.topicId,
                question_type: question.questionType,
                body: question.body,
                options: question.options,
                correct_answer: question.correctOptionIndexes,
                explanation: question.explanation,
                difficulty: question.difficulty,
                marks: question.difficulty === 'easy' ? 1 : 2,
                is_ai_generated: true,
                is_verified: question.isVerified,
                created_by: question.createdBy,
            })
            .select('id')
            .maybeSingle();

        // 23505 is a unique violation: this question already exists on this topic.
        if (error && error.code === '23505') return null;
        if (error) throw error;

        return data ? { id: data.id as string } : null;
    }
}
