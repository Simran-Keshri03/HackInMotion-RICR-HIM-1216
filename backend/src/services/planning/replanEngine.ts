/**
 * Decides whether a plan has stopped describing reality, and says which.
 *
 * Two things make a plan wrong. The learner did not do it — sessions came and went unanswered — or
 * they did do it and it is not working, because a topic the plan expected to be improving is not.
 * Both are visible in data the app already records; neither needs the model.
 *
 * Pure and separate from the writing, like every other engine here, because the interesting part is
 * the judgement and the judgement is what has to be argued with. Two decisions in particular are
 * opinions rather than facts, and both are here where they can be seen and changed:
 *
 *   how much missing is enough to rebuild
 *   how often a plan may be rebuilt at all
 *
 * The second matters more than it looks. Re-planning is triggered by opening the plan, so without a
 * limit a learner who checks their plan five times on a bad morning gets five new versions, each one
 * moving work they have not had a chance to do yet. A plan that changes every time you look at it is
 * not adaptive, it is unusable.
 */

/** A session, once it is old enough that whether it happened is settled. */
export interface ReconciledSession {
    scheduledDate: string;
    topicId: string;
    plannedQuestions: number;
    /** Answers actually recorded on this topic on this date. */
    questionsAnswered: number;
    questionsCorrect: number;
}

export type SessionStatus = 'completed' | 'partial' | 'missed';

export interface TopicPerformance {
    topicId: string;
    name: string;
    masteryScore: number | null;
    /** 0-100 over the learner's recent answers on this topic. */
    recentAccuracyPercent: number | null;
    recentAttempts: number;
}

export interface ReplanInputs {
    /** Today, YYYY-MM-DD. */
    today: string;
    /** When the current plan was built, as an ISO timestamp. */
    planCreatedAt: string;
    /** Now, as an ISO timestamp. Passed in so this stays pure and testable. */
    now: string;
    /** Sessions whose date has passed, newest first or oldest first — order does not matter. */
    pastSessions: (ReconciledSession & { status: SessionStatus })[];
    topics: TopicPerformance[];
}

export interface ReplanVerdict {
    replan: boolean;
    reason: 'missed_sessions' | 'poor_performance' | null;
    /** What to tell the learner. Empty when there is nothing to say. */
    explanation: string;
}

export const REPLAN_CONFIG = {
    /**
     * How many missed sessions before the plan is rebuilt.
     *
     * One is a bad day and rebuilding for it would be punishing somebody for having a life —
     * worse, it would move their remaining work earlier and make the plan harder the moment they
     * are already behind. Three inside a week is a pattern.
     */
    minMissedToReplan: 3,

    /** How far back to look for missed sessions. */
    missedWindowDays: 7,

    /**
     * Recent accuracy below this, on a topic with enough evidence, counts as the plan not working.
     *
     * Deliberately low. A learner getting half of a hard topic wrong is learning; one getting three
     * quarters wrong is stuck, and more of the same schedule will not fix it.
     */
    poorAccuracyPercent: 35,

    /** Answers needed on a topic before its accuracy is treated as a signal rather than noise. */
    minAttemptsForPoorSignal: 4,

    /** Topics that have to be struggling before the whole plan is rebuilt over it. */
    minStrugglingTopics: 2,

    /**
     * Shortest gap between two rebuilds.
     *
     * Twenty hours rather than twenty-four so that somebody who studies each morning is not blocked
     * by having replanned slightly earlier the previous day.
     */
    minHoursBetweenReplans: 20,
} as const;

/**
 * What actually happened in a session whose date has passed.
 *
 * Recorded from attempts rather than asked of the learner. A self-marked plan tells you what
 * somebody wishes they had done, and the whole re-planning signal would be built on it.
 *
 * `partial` exists because it is the common case and it is not a failure: somebody who answered
 * three of five questions turned up. Collapsing it into `missed` would trigger rebuilds at people
 * who are studying, which is the opposite of helping.
 */
export function reconcileStatus(session: ReconciledSession): SessionStatus {
    if (session.questionsAnswered <= 0) return 'missed';
    if (session.questionsAnswered >= session.plannedQuestions) return 'completed';

    return 'partial';
}

/** Whole days between two YYYY-MM-DD dates, in UTC. */
function daysBetween(from: string, to: string): number {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);

    if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;

    return Math.round((end - start) / 86_400_000);
}

function hoursBetween(from: string, to: string): number {
    const start = Date.parse(from);
    const end = Date.parse(to);

    if (Number.isNaN(start) || Number.isNaN(end)) return Number.POSITIVE_INFINITY;

    return (end - start) / 3_600_000;
}

/**
 * Whether this plan should be rebuilt, and why.
 *
 * Order is deliberate. The rate limit is checked first, before any signal, because a plan that has
 * just been rebuilt cannot be out of date — and the signals are still true immediately after a
 * rebuild, so checking them first would produce a rebuild on every read.
 *
 * Missed sessions are checked before poor performance because they are the more certain signal:
 * "you did not do this" is a fact, while "this is not working" is an inference from a handful of
 * answers.
 */
export function shouldReplan(inputs: ReplanInputs): ReplanVerdict {
    const nothing: ReplanVerdict = { replan: false, reason: null, explanation: '' };

    const {
        minMissedToReplan,
        missedWindowDays,
        poorAccuracyPercent,
        minAttemptsForPoorSignal,
        minStrugglingTopics,
        minHoursBetweenReplans,
    } = REPLAN_CONFIG;

    if (hoursBetween(inputs.planCreatedAt, inputs.now) < minHoursBetweenReplans) {
        return nothing;
    }

    // ---- missed sessions ----
    const recentlyMissed = inputs.pastSessions.filter((session) => {
        if (session.status !== 'missed') return false;

        const age = daysBetween(session.scheduledDate, inputs.today);
        return !Number.isNaN(age) && age >= 0 && age <= missedWindowDays;
    });

    if (recentlyMissed.length >= minMissedToReplan) {
        return {
            replan: true,
            reason: 'missed_sessions',
            explanation: `You missed ${recentlyMissed.length} sessions in the last ${missedWindowDays} days, so the remaining work has been spread over the time you have left.`,
        };
    }

    // ---- topics the plan is not fixing ----
    const struggling = inputs.topics.filter(
        (topic) =>
            topic.recentAttempts >= minAttemptsForPoorSignal &&
            topic.recentAccuracyPercent !== null &&
            topic.recentAccuracyPercent < poorAccuracyPercent
    );

    if (struggling.length >= minStrugglingTopics) {
        const named = struggling
            .slice(0, 3)
            .map((topic) => topic.name)
            .join(', ');

        return {
            replan: true,
            reason: 'poor_performance',
            explanation: `You are still getting most questions wrong on ${named}, so those topics have been given more of your remaining time.`,
        };
    }

    return nothing;
}
