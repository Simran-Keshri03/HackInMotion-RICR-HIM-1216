import type { LearnerRepository } from '@/repositories/learnerRepository.js';
import type { PlanRepository, SessionRow } from '@/repositories/planRepository.js';
import type { RevisionRepository } from '@/repositories/revisionRepository.js';
import { buildPlan } from '@/services/planning/planEngine.js';
import {
    type ReplanVerdict,
    reconcileStatus,
    shouldReplan,
} from '@/services/planning/replanEngine.js';
import { todayIn } from '@/utils/dates.js';
import { AppError } from '@/utils/http.js';

/** What changed about the plan, and why — the message the learner is owed when it moves. */
export interface PlanAdjustment {
    reason: 'missed_sessions' | 'poor_performance' | 'goal_changed' | 'requested';
    explanation: string;
}

export interface PlanReason {
    reason: 'initial' | 'missed_sessions' | 'poor_performance' | 'goal_changed' | 'requested';
}

export interface PlanView {
    id: string;
    version: number;
    examDate: string;
    dailyMinutes: number;
    daysRemaining: number;
    totalMinutesPlanned: number;
    topicsCovered: number;
    reason: string;
    createdAt: string;
    /** Grouped by date, because that is the only way a plan is ever read. */
    days: {
        date: string;
        totalMinutes: number;
        sessions: {
            id: string;
            topicId: string;
            topicName: string;
            plannedMinutes: number;
            plannedQuestions: number;
            kind: string;
            reason: string | null;
            status: string;
        }[];
    }[];
    omittedTopics?: { name: string; reason: string }[];
}

/** An active goal, as much of it as planning needs. */
interface ActiveGoal {
    id: string;
    examDate: string;
    dailyMinutes: number;
}

/**
 * Builds, stores and reads study plans.
 *
 * The engine decides what the plan is; this decides when a plan is written and makes sure only one
 * is ever current. Ordering matters in `generate`: the old plan is superseded before the new one is
 * inserted, because the database enforces one active plan per learner with a partial unique index —
 * getting that backwards produces a constraint violation rather than a second plan, which is the
 * right failure but a confusing one.
 */
export class PlanService {
    private readonly plans: PlanRepository;
    private readonly learners: LearnerRepository;
    private readonly revision: RevisionRepository;

    constructor(
        plans: PlanRepository,
        learners: LearnerRepository,
        revision: RevisionRepository
    ) {
        this.plans = plans;
        this.learners = learners;
        this.revision = revision;
    }

    /** The learner's timezone, or null to let the date helper fall back. */
    private async timezoneOf(userId: string): Promise<string | null> {
        try {
            return await this.learners.findTimezone(userId);
        } catch {
            return null;
        }
    }

    /** The learner's current plan, or null when they have never had one. */
    async getCurrent(userId: string): Promise<PlanView | null> {
        const plan = await this.plans.findActivePlan(userId);
        if (!plan) return null;

        return toView(plan, await this.plans.findSessions(plan.id));
    }

    /**
     * Settles what happened to past sessions, then rebuilds the plan if it has stopped describing
     * reality. Returns the plan the learner should now see.
     *
     * This is what makes re-planning automatic rather than a button: it runs when the plan is read,
     * so a learner who comes back after a bad week sees a plan that already accounts for it instead
     * of a wall of things they failed to do.
     *
     * Reconciliation happens first and unconditionally. It is bookkeeping the app owes regardless of
     * whether anything gets rebuilt — and the re-planning decision reads exactly the rows it writes,
     * so doing it second would judge the plan on stale statuses.
     *
     * Never throws. A learner opening their plan must get their plan; if adjusting it fails, the
     * existing one is still correct enough to work from, and a plan screen that shows an error
     * because re-planning had a problem is worse than a plan that is a week out of date.
     */
    async refreshCurrent(
        userId: string,
        goal: ActiveGoal | null
    ): Promise<{ plan: PlanView | null; adjustment: PlanAdjustment | null }> {
        const plan = await this.plans.findActivePlan(userId);
        if (!plan) return { plan: null, adjustment: null };

        // The learner's day, not the server's. A session is only missed once *their* day has ended.
        const today = todayIn(await this.timezoneOf(userId));

        try {
            await this.settlePastSessions(userId, plan.id, today);

            const verdict = await this.judgePlan(userId, plan, today);

            if (verdict.replan && verdict.reason && goal) {
                const rebuilt = await this.generate(userId, goal, verdict.reason);

                return {
                    plan: rebuilt,
                    adjustment: {
                        reason: verdict.reason,
                        explanation: verdict.explanation,
                    },
                };
            }
        } catch (error) {
            console.warn(
                `could not adjust the plan for ${userId}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }

        return {
            plan: toView(plan, await this.plans.findSessions(plan.id)),
            adjustment: null,
        };
    }

    /**
     * Records the outcome of every session whose date has passed, from the answers actually given.
     *
     * `before: today` on purpose — today's session is still live, and marking it missed at breakfast
     * would be both wrong and the fastest way to make the feature look broken.
     */
    private async settlePastSessions(
        userId: string,
        planId: string,
        today: string
    ): Promise<void> {
        const pending = await this.plans.findUnreconciledSessions(planId, today);
        if (pending.length === 0) return;

        const dates = pending.map((session) => session.scheduled_date).sort();
        const attempts = await this.plans.findAttemptsByTopicAndDay(
            userId,
            dates[0]!,
            dates[dates.length - 1]!
        );

        await this.plans.settleSessions(
            pending.map((session) => {
                const actual = attempts.get(
                    `${session.topic_id}|${session.scheduled_date}`
                ) ?? { answered: 0, correct: 0 };

                const reconciled = {
                    scheduledDate: session.scheduled_date,
                    topicId: session.topic_id,
                    plannedQuestions: session.planned_questions,
                    questionsAnswered: actual.answered,
                    questionsCorrect: actual.correct,
                };

                return {
                    id: session.id,
                    status: reconcileStatus(reconciled),
                    answered: actual.answered,
                    correct: actual.correct,
                };
            })
        );
    }

    /** Whether this plan still describes reality. */
    private async judgePlan(
        userId: string,
        plan: { id: string; created_at: string },
        today: string
    ): Promise<ReplanVerdict> {
        const settled = await this.plans.findSettledSessions(plan.id, today);

        const topics = await this.plans.findTopicPerformance(
            userId,
            [...new Set(settled.map((session) => session.topic_id))]
        );

        return shouldReplan({
            today,
            planCreatedAt: plan.created_at,
            now: new Date().toISOString(),
            pastSessions: settled.map((session) => ({
                scheduledDate: session.scheduled_date,
                topicId: session.topic_id,
                plannedQuestions: session.planned_questions,
                questionsAnswered: session.questions_answered,
                questionsCorrect: session.questions_correct,
                status: session.status as 'completed' | 'partial' | 'missed',
            })),
            topics,
        });
    }

    /**
     * Builds a new plan and makes it the current one.
     *
     * `reason` is stored rather than derived, because it is the justification the learner is owed
     * when their plan changes under them — "you missed three sessions" is a different message from
     * "you asked for a new plan", and the row has to remember which it was.
     */
    async generate(
        userId: string,
        goal: ActiveGoal,
        reason: PlanReason['reason']
    ): Promise<PlanView> {
        const today = todayIn(await this.timezoneOf(userId));
        const daysRemaining = wholeDaysBetween(today, goal.examDate);

        if (daysRemaining <= 0) {
            throw new AppError(
                400,
                'EXAM_DATE_PASSED',
                'That exam date has passed. Set a new goal to plan again.'
            );
        }

        const scopeIds = await this.plans.findGoalScope(goal.id);
        const topics = await this.plans.findPlannableTopics(userId, scopeIds);

        if (topics.length === 0) {
            throw new AppError(
                400,
                'NOTHING_TO_PLAN',
                'There are no topics in the subjects you picked, so there is nothing to plan yet.'
            );
        }

        const profile = await this.learners.findProfile(userId);

        // Restricted to the goal's own subjects: a learner who moved from class 10 to GATE still has
        // class 10 schedules, and Trigonometry in a GATE plan would be worse than useless.
        const dueRevisions = await this.revision.findDue(userId, today, scopeIds);

        const built = buildPlan({
            startDate: today,
            daysRemaining,
            dailyMinutes: goal.dailyMinutes,
            topics,
            secondsPerQuestion: profile?.avg_seconds_per_question
                ? Number(profile.avg_seconds_per_question)
                : null,
            dueRevisions: dueRevisions.map((due) => ({
                topicId: due.topicId,
                name: due.name,
                subjectName: due.subjectName,
                dueOn: due.dueOn,
                lapses: due.lapses,
                lastReviewAccuracy: due.lastReviewAccuracy,
            })),
        });

        if (built.sessions.length === 0) {
            throw new AppError(
                400,
                'PLAN_EMPTY',
                'There is not enough time before the exam to plan a useful session. Try a later date or more minutes a day.'
            );
        }

        const version = (await this.plans.findLatestVersion(goal.id)) + 1;

        // Retire the old plan first: one active plan per learner is a database constraint, not a
        // convention this code is free to break.
        await this.plans.supersedeActive(userId);

        const stored = await this.plans.createPlan({
            userId,
            goalId: goal.id,
            version,
            examDate: goal.examDate,
            dailyMinutes: goal.dailyMinutes,
            daysRemaining,
            totalMinutesPlanned: built.totalMinutesPlanned,
            topicsCovered: built.topicsCovered,
            reason,
        });

        await this.plans.createSessions(stored.id, built.sessions);

        const view = toView(stored, await this.plans.findSessions(stored.id));

        // Passed through rather than dropped: a plan that could not fit four of the learner's
        // subjects should say so on the screen, not look complete.
        return built.omittedTopics.length > 0
            ? { ...view, omittedTopics: built.omittedTopics }
            : view;
    }
}

/** Whole days from one YYYY-MM-DD to another, counted in UTC. */
export function wholeDaysBetween(from: string, to: string): number {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);

    if (Number.isNaN(start) || Number.isNaN(end)) return 0;

    return Math.round((end - start) / 86_400_000);
}

function toView(
    plan: {
        id: string;
        version: number;
        exam_date: string;
        daily_minutes: number;
        days_remaining: number;
        total_minutes_planned: number;
        topics_covered: number;
        reason: string;
        created_at: string;
    },
    sessions: SessionRow[]
): PlanView {
    const days = new Map<string, PlanView['days'][number]>();

    for (const session of sessions) {
        const day = days.get(session.scheduled_date) ?? {
            date: session.scheduled_date,
            totalMinutes: 0,
            sessions: [],
        };

        day.totalMinutes += session.planned_minutes;
        day.sessions.push({
            id: session.id,
            topicId: session.topic_id,
            // The embed can come back empty; falling back to the id keeps the screen readable
            // instead of rendering "undefined".
            topicName: session.topics?.name ?? 'Topic',
            plannedMinutes: session.planned_minutes,
            plannedQuestions: session.planned_questions,
            kind: session.kind,
            reason: session.reason,
            status: session.status,
        });

        days.set(session.scheduled_date, day);
    }

    return {
        id: plan.id,
        version: plan.version,
        examDate: plan.exam_date,
        dailyMinutes: plan.daily_minutes,
        daysRemaining: plan.days_remaining,
        totalMinutesPlanned: plan.total_minutes_planned,
        topicsCovered: plan.topics_covered,
        reason: plan.reason,
        createdAt: plan.created_at,
        days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    };
}
