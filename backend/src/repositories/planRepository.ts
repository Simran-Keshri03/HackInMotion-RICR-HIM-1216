import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlannedSession } from '@/services/planning/planEngine.js';
import type { SessionStatus } from '@/services/planning/replanEngine.js';

export interface PlanRow {
    id: string;
    goal_id: string;
    version: number;
    status: string;
    exam_date: string;
    daily_minutes: number;
    days_remaining: number;
    total_minutes_planned: number;
    topics_covered: number;
    reason: string;
    created_at: string;
}

export interface SessionRow {
    id: string;
    topic_id: string;
    scheduled_date: string;
    sort_order: number;
    planned_minutes: number;
    planned_questions: number;
    kind: string;
    reason: string | null;
    status: string;
    questions_answered: number;
    questions_correct: number;
    topics: { name: string } | null;
}

/**
 * Plans and their sessions.
 *
 * Writes need an elevated client: both tables grant SELECT to learners and nothing else, so a plan
 * can only come from the planning service.
 */
export class PlanRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async findActivePlan(userId: string): Promise<PlanRow | null> {
        const { data, error } = await this.db
            .from('study_plans')
            .select(
                'id, goal_id, version, status, exam_date, daily_minutes, days_remaining, total_minutes_planned, topics_covered, reason, created_at'
            )
            .eq('user_id', userId)
            .eq('status', 'active')
            .maybeSingle();

        if (error) throw error;
        return data as PlanRow | null;
    }

    /**
     * Sessions in a plan, in the order they should be done.
     *
     * The topic name is embedded rather than fetched separately here because the plan screen is
     * useless without it — but the result is checked by the caller, since an embed returning
     * nothing silently has bitten this project before.
     */
    async findSessions(planId: string): Promise<SessionRow[]> {
        const { data, error } = await this.db
            .from('study_sessions')
            .select(
                'id, topic_id, scheduled_date, sort_order, planned_minutes, planned_questions, kind, reason, status, questions_answered, questions_correct, topics(name)'
            )
            .eq('plan_id', planId)
            .order('scheduled_date')
            .order('sort_order');

        if (error) throw error;
        return (data ?? []) as unknown as SessionRow[];
    }

    /** The highest version number used against a goal, so the next one follows it. */
    async findLatestVersion(goalId: string): Promise<number> {
        const { data, error } = await this.db
            .from('study_plans')
            .select('version')
            .eq('goal_id', goalId)
            .order('version', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return (data?.version as number | undefined) ?? 0;
    }

    /**
     * Retires the learner's current plan.
     *
     * Called before inserting a new one, because a partial unique index enforces one active plan
     * per learner — without this the insert is refused by the database rather than by this code.
     */
    async supersedeActive(userId: string): Promise<void> {
        const { error } = await this.db
            .from('study_plans')
            .update({ status: 'superseded' })
            .eq('user_id', userId)
            .eq('status', 'active');

        if (error) throw error;
    }

    async createPlan(plan: {
        userId: string;
        goalId: string;
        version: number;
        examDate: string;
        dailyMinutes: number;
        daysRemaining: number;
        totalMinutesPlanned: number;
        topicsCovered: number;
        reason: string;
    }): Promise<PlanRow> {
        const { data, error } = await this.db
            .from('study_plans')
            .insert({
                user_id: plan.userId,
                goal_id: plan.goalId,
                version: plan.version,
                exam_date: plan.examDate,
                daily_minutes: plan.dailyMinutes,
                days_remaining: plan.daysRemaining,
                total_minutes_planned: plan.totalMinutesPlanned,
                topics_covered: plan.topicsCovered,
                reason: plan.reason,
            })
            .select(
                'id, goal_id, version, status, exam_date, daily_minutes, days_remaining, total_minutes_planned, topics_covered, reason, created_at'
            )
            .single();

        if (error) throw error;
        return data as PlanRow;
    }

    /**
     * Writes every session of a plan in one request.
     *
     * One insert rather than a loop: a 45-day plan is well over a hundred rows, and a hundred round
     * trips to Mumbai is the difference between a plan appearing at once and a progress bar. The
     * rows carry no user_id — a trigger takes it from the plan, so a caller cannot attach sessions
     * to somebody else's plan by passing a different one.
     */
    async createSessions(planId: string, sessions: PlannedSession[]): Promise<number> {
        if (sessions.length === 0) return 0;

        const { error, count } = await this.db.from('study_sessions').insert(
            sessions.map((session) => ({
                plan_id: planId,
                topic_id: session.topicId,
                scheduled_date: session.scheduledDate,
                sort_order: session.sortOrder,
                planned_minutes: session.plannedMinutes,
                planned_questions: session.plannedQuestions,
                kind: session.kind,
                reason: session.reason,
            })),
            { count: 'exact' }
        );

        if (error) throw error;
        return count ?? sessions.length;
    }

    /**
     * Topics in the goal's scope, with the learner's mastery on each.
     *
     * Two queries rather than one embed. The mastery table has a row only for topics that have been
     * attempted, so an inner join would silently hide exactly the topics that need the most plan
     * time — the ones never started.
     */
    async findPlannableTopics(
        userId: string,
        scopeIds: string[]
    ): Promise<
        {
            topicId: string;
            name: string;
            subjectName: string | null;
            weight: number;
            masteryScore: number | null;
            attempts: number;
        }[]
    > {
        if (scopeIds.length === 0) return [];

        const list = scopeIds.join(',');

        const { data: topics, error: topicError } = await this.db
            .from('topics')
            .select('id, name, weight, parent_id')
            .or(`id.in.(${list}),parent_id.in.(${list})`);

        if (topicError) throw topicError;

        const rows = (topics ?? []) as {
            id: string;
            name: string;
            weight: number;
            parent_id: string | null;
        }[];

        // Subjects are containers; the plan schedules the leaves inside them.
        const leaves = rows.filter((row) => row.parent_id !== null);
        if (leaves.length === 0) return [];

        const subjectNames = new Map(
            rows.filter((row) => row.parent_id === null).map((row) => [row.id, row.name])
        );

        const { data: mastery, error: masteryError } = await this.db
            .from('concept_mastery')
            .select('topic_id, mastery_score, total_attempts')
            .eq('user_id', userId)
            .in(
                'topic_id',
                leaves.map((leaf) => leaf.id)
            );

        if (masteryError) throw masteryError;

        const byTopic = new Map(
            ((mastery ?? []) as {
                topic_id: string;
                mastery_score: number;
                total_attempts: number;
            }[]).map((row) => [row.topic_id, row])
        );

        return leaves.map((leaf) => {
            const row = byTopic.get(leaf.id);

            return {
                topicId: leaf.id,
                name: leaf.name,
                subjectName: leaf.parent_id
                    ? (subjectNames.get(leaf.parent_id) ?? null)
                    : null,
                weight: Number(leaf.weight),
                masteryScore: row ? Number(row.mastery_score) : null,
                attempts: row ? Number(row.total_attempts) : 0,
            };
        });
    }

    /**
     * Sessions in a plan whose date has passed and whose outcome is still unrecorded.
     *
     * Only `pending` rows: a session already settled as completed, partial or missed is history, and
     * rewriting history on every read would make the missed-session count depend on when the learner
     * happened to open the app.
     */
    async findUnreconciledSessions(
        planId: string,
        before: string
    ): Promise<
        {
            id: string;
            topic_id: string;
            scheduled_date: string;
            planned_questions: number;
        }[]
    > {
        const { data, error } = await this.db
            .from('study_sessions')
            .select('id, topic_id, scheduled_date, planned_questions')
            .eq('plan_id', planId)
            .eq('status', 'pending')
            .lt('scheduled_date', before);

        if (error) throw error;
        return (data ?? []) as {
            id: string;
            topic_id: string;
            scheduled_date: string;
            planned_questions: number;
        }[];
    }

    /**
     * Answers the learner actually recorded, per topic per day, over a date range.
     *
     * This is what settles whether a session happened. Deliberately not "did they practise at all
     * that day": somebody who spent an hour on a different topic was active and still did not do the
     * session, and re-planning has to be able to tell those apart — the whole signal depends on it.
     */
    async findAttemptsByTopicAndDay(
        userId: string,
        fromDate: string,
        toDate: string
    ): Promise<Map<string, { answered: number; correct: number }>> {
        const { data, error } = await this.db
            .from('question_attempts')
            .select('topic_id, is_correct, attempted_at')
            .eq('user_id', userId)
            .gte('attempted_at', `${fromDate}T00:00:00Z`)
            .lte('attempted_at', `${toDate}T23:59:59Z`);

        if (error) throw error;

        const byKey = new Map<string, { answered: number; correct: number }>();

        for (const row of (data ?? []) as {
            topic_id: string;
            is_correct: boolean;
            attempted_at: string;
        }[]) {
            const key = `${row.topic_id}|${row.attempted_at.slice(0, 10)}`;
            const entry = byKey.get(key) ?? { answered: 0, correct: 0 };

            entry.answered += 1;
            if (row.is_correct) entry.correct += 1;

            byKey.set(key, entry);
        }

        return byKey;
    }

    /**
     * Writes the settled outcome of past sessions.
     *
     * One request per distinct status rather than one per session: a learner returning after two
     * weeks away has a fortnight of sessions to settle, and thirty round trips to Mumbai on a page
     * load is a page that feels broken.
     */
    async settleSessions(
        settlements: {
            id: string;
            status: SessionStatus;
            answered: number;
            correct: number;
        }[]
    ): Promise<void> {
        if (settlements.length === 0) return;

        // Grouped by (status, answered, correct) so identical updates share one request. Missed
        // sessions all look the same, which is the common case after a gap.
        const groups = new Map<string, string[]>();

        for (const settlement of settlements) {
            const key = `${settlement.status}|${settlement.answered}|${settlement.correct}`;
            groups.set(key, [...(groups.get(key) ?? []), settlement.id]);
        }

        for (const [key, ids] of groups) {
            const [status, answered, correct] = key.split('|');

            const { error } = await this.db
                .from('study_sessions')
                .update({
                    status,
                    questions_answered: Number(answered),
                    questions_correct: Number(correct),
                    // The CHECK constraint requires a timestamp when the status is 'completed', and
                    // refuses one that claims completion without it.
                    completed_at:
                        status === 'completed' ? new Date().toISOString() : null,
                })
                .in('id', ids);

            if (error) throw error;
        }
    }

    /** Past sessions of a plan with their settled outcome, for the re-planning decision. */
    async findSettledSessions(
        planId: string,
        before: string
    ): Promise<
        {
            scheduled_date: string;
            topic_id: string;
            planned_questions: number;
            questions_answered: number;
            questions_correct: number;
            status: string;
        }[]
    > {
        const { data, error } = await this.db
            .from('study_sessions')
            .select(
                'scheduled_date, topic_id, planned_questions, questions_answered, questions_correct, status'
            )
            .eq('plan_id', planId)
            .neq('status', 'pending')
            .lt('scheduled_date', before);

        if (error) throw error;
        return (data ?? []) as {
            scheduled_date: string;
            topic_id: string;
            planned_questions: number;
            questions_answered: number;
            questions_correct: number;
            status: string;
        }[];
    }

    /** Recent form per topic, for judging whether the plan is working. */
    async findTopicPerformance(
        userId: string,
        topicIds: string[]
    ): Promise<
        {
            topicId: string;
            name: string;
            masteryScore: number | null;
            recentAccuracyPercent: number | null;
            recentAttempts: number;
        }[]
    > {
        if (topicIds.length === 0) return [];

        const { data, error } = await this.db
            .from('concept_mastery')
            .select('topic_id, mastery_score, recent_accuracy, recent_attempts')
            .eq('user_id', userId)
            .in('topic_id', topicIds);

        if (error) throw error;

        const rows = (data ?? []) as {
            topic_id: string;
            mastery_score: number;
            recent_accuracy: number | null;
            recent_attempts: number;
        }[];

        if (rows.length === 0) return [];

        const { data: names, error: nameError } = await this.db
            .from('topics')
            .select('id, name')
            .in(
                'id',
                rows.map((row) => row.topic_id)
            );

        if (nameError) throw nameError;

        const byId = new Map(
            ((names ?? []) as { id: string; name: string }[]).map((row) => [
                row.id,
                row.name,
            ])
        );

        return rows.map((row) => ({
            topicId: row.topic_id,
            name: byId.get(row.topic_id) ?? 'Topic',
            masteryScore: row.mastery_score === null ? null : Number(row.mastery_score),
            recentAccuracyPercent:
                row.recent_accuracy === null ? null : Number(row.recent_accuracy),
            recentAttempts: Number(row.recent_attempts ?? 0),
        }));
    }

    /** Subject ids the active goal covers. */
    async findGoalScope(goalId: string): Promise<string[]> {
        const { data, error } = await this.db
            .from('learning_goal_topics')
            .select('topic_id')
            .eq('goal_id', goalId);

        if (error) throw error;
        return (data ?? []).map((row) => row.topic_id as string);
    }
}
