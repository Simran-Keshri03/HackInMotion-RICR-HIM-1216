import type { SupabaseClient } from '@supabase/supabase-js';
import { nextHabits } from '@/services/learner/habitEngine.js';

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

    /**
     * The learner's timezone, for working out what day it is for them.
     *
     * Lives on `profiles`, not `learner_profiles` — it is a setting they chose, not a computed cache.
     * `not null default 'Asia/Kolkata'`, so a null here means the row is missing rather than unset,
     * and the caller falls back rather than failing: a wrong-by-one-day streak is bad, an answer
     * rejected because of a timezone lookup is worse.
     */
    async findTimezone(userId: string): Promise<string | null> {
        const { data, error } = await this.db
            .from('profiles')
            .select('timezone')
            .eq('id', userId)
            .maybeSingle();

        if (error) throw error;
        return (data?.timezone as string | undefined) ?? null;
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
     * Bumps the learner-level counters after one answer, and moves their habits along with them.
     *
     * Streaks, speed and consistency used to be left out of here on the grounds that they need a
     * day-by-day pass over the history. Two of the three do not: a streak follows from the previous
     * streak and the date it was last touched, and an average follows from the previous average and
     * the count behind it. Both are O(1). Only consistency genuinely needs to look at the history,
     * and that is one indexed aggregate rather than a walk.
     *
     * They were worth going back for because the dashboard was already showing them. A learner
     * twenty-one questions in was being told their streak was zero — a wrong number, not a missing
     * one, which is the kind of thing that makes somebody stop trusting the rest of the screen.
     */
    async recordAttemptOnProfile(
        userId: string,
        wasCorrect: boolean,
        today: string,
        secondsTaken: number | null = null
    ): Promise<void> {
        const current = await this.findProfile(userId);

        const habits = nextHabits(
            {
                currentStreakDays: current?.current_streak_days ?? 0,
                longestStreakDays: current?.longest_streak_days ?? 0,
                lastActivityDate: current?.last_activity_date ?? null,
                avgSecondsPerQuestion:
                    current?.avg_seconds_per_question === null ||
                    current?.avg_seconds_per_question === undefined
                        ? null
                        : Number(current.avg_seconds_per_question),
                totalAttempts: current?.total_attempts ?? 0,
            },
            {
                today,
                secondsTaken,
                practice: await this.findPracticeDays(userId),
            }
        );

        const { error } = await this.db
            .from('learner_profiles')
            .update({
                total_attempts: (current?.total_attempts ?? 0) + 1,
                correct_attempts:
                    (current?.correct_attempts ?? 0) + (wasCorrect ? 1 : 0),
                last_activity_date: habits.lastActivityDate,
                current_streak_days: habits.currentStreakDays,
                longest_streak_days: habits.longestStreakDays,
                avg_seconds_per_question: habits.avgSecondsPerQuestion,
                // Left alone rather than nulled when it could not be worked out: a number that
                // was true yesterday beats blanking the dashboard.
                ...(habits.consistencyScore === null
                    ? {}
                    : { consistency_score: habits.consistencyScore }),
                computed_at: new Date().toISOString(),
            })
            .eq('user_id', userId);

        if (error) throw error;
    }

    /**
     * Distinct days this learner has practised on, and the first of them.
     *
     * The one thing about habits that cannot be kept incrementally: a streak knows how many days
     * are unbroken right now, and says nothing about the days that broke it. Consistency is about
     * exactly those days.
     *
     * Returns undefined rather than throwing. Consistency is the least important number on the
     * dashboard and this runs immediately after an answer was successfully recorded — failing the
     * whole submission over it would lose the answer to save a percentage.
     */
    private async findPracticeDays(
        userId: string
    ): Promise<{ distinctDays: number; firstDate: string } | undefined> {
        try {
            const { data, error } = await this.db
                .from('question_attempts')
                .select('attempted_at')
                .eq('user_id', userId)
                .order('attempted_at');

            if (error) throw error;

            const rows = (data ?? []) as { attempted_at: string }[];
            if (rows.length === 0) return undefined;

            // Distinct calendar days, counted here rather than in SQL: PostgREST cannot express
            // count(distinct date(...)) and a database function for it would be a migration to
            // maintain for one number.
            //
            // ponytail: reads one row per attempt. Fine at this size — a heavy user reaches a few
            // thousand — and the day to replace it with a stored day counter is the day that gets
            // slow, not before.
            const days = new Set(rows.map((row) => row.attempted_at.slice(0, 10)));

            return {
                distinctDays: days.size,
                firstDate: rows[0]!.attempted_at.slice(0, 10),
            };
        } catch {
            return undefined;
        }
    }

    /**
     * Answers per day over a window, grouped into the learner's own calendar days.
     *
     * The grouping happens here in JS rather than in SQL because a day boundary depends on the
     * learner's timezone, and PostgREST cannot express `date(attempted_at at time zone ...)`. Doing it
     * in UTC instead is exactly the bug that `utils/dates.ts` documents: at 00:56 in India the UTC
     * date is still yesterday, so a square would land on the wrong day and one morning would count as
     * two.
     *
     * ponytail: reads one row per attempt in the window. A year of heavy use is a few thousand rows of
     * two columns, which is nothing; the day to replace this with a stored per-day counter is the day
     * it measurably drags, not before.
     */
    async findDailyActivity(
        userId: string,
        fromDate: string,
        toDate: string,
        toLocalDate: (at: string) => string
    ): Promise<{ counts: Map<string, number>; correct: number; total: number }> {
        const { data, error } = await this.db
            .from('question_attempts')
            .select('attempted_at, is_correct')
            .eq('user_id', userId)
            // A day either side of the window, because a local day can start before the UTC day it
            // is named after: trimming exactly would drop the earliest and latest squares.
            .gte('attempted_at', `${fromDate}T00:00:00Z`)
            .lte('attempted_at', `${toDate}T23:59:59Z`);

        if (error) throw error;

        const rows = (data ?? []) as { attempted_at: string; is_correct: boolean }[];
        const counts = new Map<string, number>();
        let correct = 0;

        for (const row of rows) {
            const day = toLocalDate(row.attempted_at);
            counts.set(day, (counts.get(day) ?? 0) + 1);
            if (row.is_correct) correct += 1;
        }

        return { counts, correct, total: rows.length };
    }

    /**
     * The subjects in the learner's goal, each with how far through it they are.
     *
     * Only the subjects the goal actually selected — not everything in the syllabus. A practice screen
     * offering subjects the learner deliberately left out of their goal would undo the choice they
     * made on the goal screen, which is the one thing that screen exists for.
     *
     * Progress is *topics with any attempt*, not average mastery. Average mastery over a subject
     * whose topics are mostly untouched reads as a low score when the truth is "not started" — the
     * two look identical and mean opposite things. Coverage is the honest number for a progress bar;
     * mastery is reported separately, over the topics that have actually been attempted.
     */
    async findGoalSubjects(userId: string): Promise<
        {
            id: string;
            name: string;
            weight: number;
            topicCount: number;
            topicsStarted: number;
            topicsMastered: number;
            questionsAnswered: number;
            averageMastery: number | null;
        }[]
    > {
        const { data: goal, error: goalError } = await this.db
            .from('learning_goals')
            .select('id')
            .eq('user_id', userId)
            .eq('status', 'active')
            .maybeSingle();

        if (goalError) throw goalError;
        if (!goal) return [];

        const { data: scope, error: scopeError } = await this.db
            .from('learning_goal_topics')
            .select('topic_id')
            .eq('goal_id', goal.id);

        if (scopeError) throw scopeError;

        const subjectIds = ((scope ?? []) as { topic_id: string }[]).map((r) => r.topic_id);
        if (subjectIds.length === 0) return [];

        const { data: subjects, error: subjectError } = await this.db
            .from('topics')
            .select('id, name, weight, sort_order')
            .in('id', subjectIds);

        if (subjectError) throw subjectError;

        const { data: leaves, error: leafError } = await this.db
            .from('topics')
            .select('id, parent_id')
            .in('parent_id', subjectIds);

        if (leafError) throw leafError;

        const leafRows = (leaves ?? []) as { id: string; parent_id: string }[];
        const subjectOf = new Map(leafRows.map((row) => [row.id, row.parent_id]));

        const { data: mastery, error: masteryError } = await this.db
            .from('concept_mastery')
            .select('topic_id, mastery_score, total_attempts')
            .eq('user_id', userId)
            .in(
                'topic_id',
                leafRows.map((row) => row.id)
            );

        if (masteryError) throw masteryError;

        const stats = new Map<
            string,
            { started: number; mastered: number; answered: number; masterySum: number }
        >();

        for (const row of (mastery ?? []) as {
            topic_id: string;
            mastery_score: number;
            total_attempts: number;
        }[]) {
            const subjectId = subjectOf.get(row.topic_id);
            if (!subjectId) continue;

            const entry =
                stats.get(subjectId) ?? { started: 0, mastered: 0, answered: 0, masterySum: 0 };

            entry.started += 1;
            entry.answered += Number(row.total_attempts);
            entry.masterySum += Number(row.mastery_score);
            if (Number(row.mastery_score) >= 85) entry.mastered += 1;

            stats.set(subjectId, entry);
        }

        const topicCount = new Map<string, number>();
        for (const row of leafRows) {
            topicCount.set(row.parent_id, (topicCount.get(row.parent_id) ?? 0) + 1);
        }

        return ((subjects ?? []) as {
            id: string;
            name: string;
            weight: number;
            sort_order: number;
        }[])
            .sort((a, b) => a.sort_order - b.sort_order)
            .map((subject) => {
                const entry = stats.get(subject.id);

                return {
                    id: subject.id,
                    name: subject.name,
                    weight: Number(subject.weight),
                    topicCount: topicCount.get(subject.id) ?? 0,
                    topicsStarted: entry?.started ?? 0,
                    topicsMastered: entry?.mastered ?? 0,
                    questionsAnswered: entry?.answered ?? 0,
                    averageMastery:
                        entry && entry.started > 0
                            ? Math.round((entry.masterySum / entry.started) * 10) / 10
                            : null,
                };
            });
    }

    /** Topics at or above the mastery bar, and completed reviews — the badge inputs. */
    async findAchievementCounts(
        userId: string,
        masteryBar: number
    ): Promise<{ topicsMastered: number; reviewsCompleted: number }> {
        const [mastered, reviews] = await Promise.all([
            this.db
                .from('concept_mastery')
                .select('topic_id', { count: 'exact', head: true })
                .eq('user_id', userId)
                .gte('mastery_score', masteryBar),
            this.db
                .from('revision_schedule')
                .select('review_count')
                .eq('user_id', userId),
        ]);

        if (mastered.error) throw mastered.error;
        if (reviews.error) throw reviews.error;

        return {
            topicsMastered: mastered.count ?? 0,
            // Summed rather than counted: a topic reviewed six times is six reviews, and the badge
            // is about the habit rather than about how many topics happen to have a schedule.
            reviewsCompleted: ((reviews.data ?? []) as { review_count: number }[]).reduce(
                (total, row) => total + Number(row.review_count),
                0
            ),
        };
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
