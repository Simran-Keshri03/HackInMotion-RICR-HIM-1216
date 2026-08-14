/**
 * Turns a goal and a mastery picture into a day-by-day study plan.
 *
 * Pure and deterministic, like the mastery and recommendation engines, and for a reason worth
 * stating plainly: **this does not ask the model.** Dividing a fixed number of minutes between
 * topics by how much they need and how much they are worth is arithmetic. A plan that came out of
 * a language model could not be reproduced, could not be unit tested, and could not be explained
 * to a learner who asks why Tuesday looks like that — and it would cost money and twenty seconds
 * every time the plan changed. The model is used where judgement is genuinely needed: writing
 * questions, reading free text, explaining an answer.
 *
 * The shape of the algorithm:
 *
 *   1. budget      days remaining x minutes per day
 *   2. need        per topic: how far from mastered, weighted by exam importance
 *   3. allocate    split the budget by need, then round to whole sessions with a floor
 *   4. lay out     fill day by day, worst-first, without splitting a topic too thin
 *
 * Step 3 is where the interesting constraint lives. Proportional allocation alone produces
 * sessions of four minutes, and four minutes on a topic is worse than not scheduling it: the
 * learner gets a plan that looks busy and teaches nothing. So a session has a floor, and topics
 * that cannot clear it do not appear at all — an honest plan covering eight topics beats a
 * dishonest one listing thirty.
 */

export interface PlanTopic {
    topicId: string;
    name: string;
    subjectName: string | null;
    /** Exam importance from the syllabus. Higher means more of the paper. */
    weight: number;
    /** 0-100, or null for a topic never attempted. */
    masteryScore: number | null;
    attempts: number;
}

/** A topic the spaced-repetition schedule says is owed a review. */
export interface DueRevision {
    topicId: string;
    name: string;
    subjectName: string | null;
    /** YYYY-MM-DD. Already past or equal to today, or it would not be due. */
    dueOn: string;
    /** Times this topic has collapsed back to a one-day interval. */
    lapses: number;
    lastReviewAccuracy: number | null;
}

export interface PlanInputs {
    /** YYYY-MM-DD. The first day the plan schedules work on. */
    startDate: string;
    /** Whole days from startDate up to and including the day before the exam. */
    daysRemaining: number;
    dailyMinutes: number;
    topics: PlanTopic[];
    /** From the learner's profile, so estimated question counts match how fast they actually work. */
    secondsPerQuestion: number | null;
    /**
     * Topics due for revision, longest overdue first.
     *
     * Scheduled before new learning rather than alongside it, because a topic past its due date is
     * being actively forgotten while a topic never started is merely unlearned — and losing something
     * already paid for is worse value than not gaining something new.
     */
    dueRevisions?: DueRevision[];
}

export interface PlannedSession {
    /** YYYY-MM-DD. */
    scheduledDate: string;
    topicId: string;
    topicName: string;
    sortOrder: number;
    plannedMinutes: number;
    plannedQuestions: number;
    kind: 'learn' | 'revise';
    reason: string;
}

export interface StudyPlan {
    sessions: PlannedSession[];
    totalMinutesPlanned: number;
    topicsCovered: number;
    /** Topics that did not fit, so the caller can say so instead of quietly dropping them. */
    omittedTopics: { name: string; reason: string }[];
}

export const PLAN_CONFIG = {
    /**
     * Shortest block worth scheduling.
     *
     * Below this a session is theatre. Fifteen minutes is roughly long enough to read a topic and
     * answer a few questions on it; ten would technically fit more topics into a plan and teach
     * less on each of them.
     */
    minSessionMinutes: 15,

    /**
     * Longest single block on one topic in one day.
     *
     * Not a productivity opinion — it is what stops a learner with 8 topics and 240 minutes a day
     * spending the first four days entirely on their weakest topic and never seeing the rest before
     * the exam. Spreading is the point of a plan.
     */
    maxSessionMinutes: 60,

    /** Most topics in one day, however long the day is. More than this is a list, not a plan. */
    maxTopicsPerDay: 4,

    /**
     * How many topics a day should try to hold, when the day is long enough for them.
     *
     * This exists because `maxSessionMinutes` alone does not achieve the spreading it was supposed
     * to. With a 60-minute day and a 60-minute session cap, the weakest topic takes the whole of
     * day one, and the whole of day two, until its allocation runs out — the learner spends their
     * first week on a single topic and meets the rest of the plan late. A unit test caught it; the
     * cap was doing nothing at the budget most learners actually set.
     *
     * Two rather than four: a day of two half-hour blocks teaches more than four fifteen-minute
     * ones, and still gets a four-topic plan fully seen inside two days.
     */
    topicsPerDayTarget: 2,

    /** Assumed pace when the learner has no measured average yet. */
    fallbackSecondsPerQuestion: 90,

    /**
     * Mastery a topic is treated as needing no further work at.
     *
     * Not 100: the last few points come from revision rather than fresh study, and reserving plan
     * time to push 85 to 100 takes it away from a topic sitting at 20.
     */
    masteryTarget: 85,

    /**
     * Share of the first day's capacity revision may take before new learning gets any.
     *
     * Not all of it: a learner who opens their plan and sees nothing but revision has been given a
     * plan that does not move them forward, and the exam is not made of things they have already
     * seen. Half is enough to clear a backlog within a few days while the plan still visibly
     * progresses.
     */
    maxRevisionShareOfDay: 0.5,

    /**
     * Length of a revision session.
     *
     * Shorter than a learning session on purpose — the point is to refresh something already known,
     * not to teach it again, and a short successful review is what moves the interval out.
     */
    revisionMinutes: 15,

    /**
     * Mastery assumed for a topic that has never been attempted.
     *
     * The same neutral prior the mastery formula shrinks toward, and using it here fixes a real
     * inversion that the diagnostic assessment exposed.
     *
     * `masteryScore ?? 0` used to stand in for "unknown", which quietly meant "the worst possible" —
     * so an unmeasured topic outranked one the learner had just been measured as weak at. Answering a
     * diagnostic question wrong *lowered* that topic's share of the plan, from 105 minutes to 75, while
     * a topic nobody had ever asked about held the top slot at 150. That is the opposite of
     * prioritising weak areas.
     *
     * Not knowing belongs between the two things you can know: an unmeasured topic (gap 0.59) now sits
     * below one measured as weak (0.66) and above one measured as solid (0.15), which is what "we have
     * no evidence" actually means.
     */
    unknownMastery: 35,

    /**
     * Floor on need, so a well-known topic still gets some time.
     *
     * A topic at the target is not worthless — it is worth keeping alive. Without this the plan
     * would abandon everything the learner is good at, which is how people walk into an exam
     * having forgotten what they knew a month ago.
     */
    minNeedFactor: 0.15,
} as const;

/** Whole days between two YYYY-MM-DD dates, in UTC so a timezone cannot shift the answer. */
export function addDays(date: string, days: number): string {
    const base = Date.parse(`${date}T00:00:00Z`);
    return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * How much attention a topic needs, before the budget is known.
 *
 * Two multiplied factors, both meaning what they say:
 *   gap     how far below the target this topic sits, so 20 needs more than 70
 *   weight  how much of the exam it is, so a heavy topic outranks a light one at equal mastery
 *
 * A topic never attempted counts as a full gap rather than zero mastery, which are different
 * things: zero would be a measurement, and there is no measurement.
 */
export function topicNeed(topic: PlanTopic): number {
    const { masteryTarget, minNeedFactor } = PLAN_CONFIG;

    // Never attempted is not the same as scored zero — see `unknownMastery`.
    const mastery = topic.masteryScore ?? PLAN_CONFIG.unknownMastery;
    const rawGap = Math.max(0, masteryTarget - mastery) / masteryTarget;
    const gap = Math.max(minNeedFactor, rawGap);

    return gap * Math.max(0.1, topic.weight);
}

/**
 * Builds the plan.
 *
 * Returns an empty plan rather than throwing when there is nothing to plan — no topics in the
 * goal's scope, or an exam already in the past. Both are states a learner can genuinely be in, and
 * the screen should say so rather than showing an error.
 */
export function buildPlan(inputs: PlanInputs): StudyPlan {
    const empty: StudyPlan = {
        sessions: [],
        totalMinutesPlanned: 0,
        topicsCovered: 0,
        omittedTopics: [],
    };

    if (inputs.daysRemaining <= 0 || inputs.topics.length === 0) return empty;

    const { minSessionMinutes, maxSessionMinutes, maxTopicsPerDay } = PLAN_CONFIG;

    const secondsPerQuestion =
        inputs.secondsPerQuestion && inputs.secondsPerQuestion > 0
            ? inputs.secondsPerQuestion
            : PLAN_CONFIG.fallbackSecondsPerQuestion;

    // ---- 1. the budget, and the ceiling on how much of it a day can hold ----
    const perDayCapacity = Math.min(inputs.dailyMinutes, maxTopicsPerDay * maxSessionMinutes);
    const totalBudget = inputs.daysRemaining * perDayCapacity;

    /**
     * The shortest session this particular learner can be given.
     *
     * Normally the configured floor. But a goal may set as little as ten minutes a day — the
     * learning_goals CHECK allows it — and a fifteen-minute floor cannot fit inside a ten-minute
     * day. Left as a constant, every such learner got an empty plan and the message "there is not
     * enough time before the exam", which was both useless and untrue: they had a hundred and
     * eighty days. Found by generating a plan for a real goal, not by reading the code.
     *
     * Somebody who says ten minutes a day means it. Ten-minute sessions are what they asked for.
     */
    const sessionFloor = Math.min(minSessionMinutes, perDayCapacity);

    // ---- 2. need per topic, worst first ----
    const ranked = inputs.topics
        .map((topic) => ({ topic, need: topicNeed(topic) }))
        .sort((a, b) => b.need - a.need);

    const totalNeed = ranked.reduce((sum, entry) => sum + entry.need, 0);
    if (totalNeed <= 0) return empty;

    // ---- 3. allocate, and decide who does not fit ----
    const omittedTopics: { name: string; reason: string }[] = [];
    const allocations: { topic: PlanTopic; minutes: number }[] = [];

    let remainingBudget = totalBudget;

    for (const { topic, need } of ranked) {
        const share = Math.round((need / totalNeed) * totalBudget);

        // Rounded down to whole sessions so the layout never has to split a remainder of four
        // minutes across a day boundary.
        const sessions = Math.floor(Math.min(share, remainingBudget) / sessionFloor);

        if (sessions < 1) {
            omittedTopics.push({
                name: topic.name,
                reason: `not enough time before the exam to give it a useful ${sessionFloor} minutes`,
            });
            continue;
        }

        const minutes = sessions * sessionFloor;
        allocations.push({ topic, minutes });
        remainingBudget -= minutes;
    }

    if (allocations.length === 0) {
        return {
            ...empty,
            omittedTopics,
        };
    }

    // ---- 4. lay out across days ----
    // Round-robin rather than one topic at a time: a learner should meet their whole plan in the
    // first week, not spend it all on topic one. Interleaving is also what makes the spacing in
    // challenge 2 possible later.
    const queues = allocations.map(({ topic, minutes }) => ({
        topic,
        remaining: minutes,
    }));

    // The longest one topic may take in a day. Bounded by the absolute cap, but usually by the
    // day divided by how many topics it should hold — which is what actually makes the plan spread.
    const sessionCap = Math.min(
        maxSessionMinutes,
        Math.max(sessionFloor, Math.floor(perDayCapacity / PLAN_CONFIG.topicsPerDayTarget))
    );

    const sessions: PlannedSession[] = [];

    /**
     * Revision first, on the earliest days, before new learning is laid out.
     *
     * Order matters here and not only cosmetically: the learning layout below fills each day up to
     * its capacity, so anything not reserved in advance would be crowded out entirely. A backlog of
     * overdue topics would then never appear in a plan at all, which is the failure spaced repetition
     * exists to prevent.
     */
    const revisionByDay = new Map<string, number>();

    /**
     * Which (day, topic) slots revision has taken.
     *
     * A topic due for revision is also in the goal's scope, so the learning pass below would schedule
     * it again — twice on the same topic on the same day. That is pedagogically pointless and the
     * database refuses it outright: `study_sessions_unique_slot` is unique on
     * (plan_id, scheduled_date, topic_id), so the whole plan insert failed with a duplicate-key error.
     * Caught by generating a plan against real due topics; the unit tests had passed because none of
     * them had a topic in both lists.
     */
    const claimed = new Set<string>();

    for (const [index, due] of (inputs.dueRevisions ?? []).entries()) {
        const minutes = Math.min(PLAN_CONFIG.revisionMinutes, perDayCapacity);

        // Spread across days rather than stacked on day one: a backlog of ten topics is not a
        // ten-topic day, and clearing it over a few days is how the schedule intends it.
        const perDayBudget = Math.floor(perDayCapacity * PLAN_CONFIG.maxRevisionShareOfDay);

        if (perDayBudget < minutes) break;

        const slotsPerDay = Math.max(1, Math.floor(perDayBudget / minutes));
        const dayOffset = Math.floor(index / slotsPerDay);

        if (dayOffset >= inputs.daysRemaining) break;

        const date = addDays(inputs.startDate, dayOffset);
        const already = revisionByDay.get(date) ?? 0;

        sessions.push({
            scheduledDate: date,
            topicId: due.topicId,
            topicName: due.name,
            sortOrder: index % slotsPerDay,
            plannedMinutes: minutes,
            plannedQuestions: Math.max(1, Math.round((minutes * 60) / secondsPerQuestion)),
            kind: 'revise',
            reason: revisionReason(due),
        });

        revisionByDay.set(date, already + minutes);
        claimed.add(`${date}|${due.topicId}`);
    }

    let dayIndex = 0;

    while (dayIndex < inputs.daysRemaining && queues.some((q) => q.remaining > 0)) {
        const date = addDays(inputs.startDate, dayIndex);

        // What revision already claimed today. Subtracted rather than ignored, or the day would be
        // planned to twice its capacity and the promise on the screen would be a lie.
        const takenByRevision = revisionByDay.get(date) ?? 0;

        let dayLeft = perDayCapacity - takenByRevision;
        let placedToday = revisionByDay.has(date) ? 1 : 0;

        /**
         * Which topic today starts with, rotating by one each day.
         *
         * Without the rotation, a day that only has room for one topic always gives it to the same
         * queue until that queue is empty. A learner on ten minutes a day therefore spent their
         * first twenty-five days entirely on one topic and met the rest of their plan a month in —
         * the same failure the session cap was added to prevent, reappearing at a smaller budget
         * where the cap has no room to act. Seen in a generated plan for a real goal: four days,
         * one topic.
         *
         * Rotating changes only the order, never the totals: a weak topic still gets more days than
         * a strong one, it just does not get all of them first.
         */
        const start = queues.length > 0 ? dayIndex % queues.length : 0;

        for (let step = 0; step < queues.length; step += 1) {
            const queue = queues[(start + step) % queues.length]!;

            if (queue.remaining <= 0) continue;
            if (placedToday >= maxTopicsPerDay) break;
            if (dayLeft < sessionFloor) break;

            // Revision already covered this topic today. Skipped rather than merged: the remaining
            // minutes stay in the queue and land on a later day, so the topic keeps its full
            // allocation instead of quietly losing a session.
            if (claimed.has(`${date}|${queue.topic.topicId}`)) continue;

            const minutes = Math.min(queue.remaining, dayLeft, sessionCap);

            // Never leave a stub too small to be its own session: fold it into this one when the
            // day has room, otherwise it would come back tomorrow as a five-minute block.
            const stub = queue.remaining - minutes;
            const folded =
                stub > 0 && stub < sessionFloor && dayLeft - minutes >= stub
                    ? minutes + stub
                    : minutes;

            sessions.push({
                scheduledDate: date,
                topicId: queue.topic.topicId,
                topicName: queue.topic.name,
                sortOrder: placedToday,
                plannedMinutes: folded,
                plannedQuestions: Math.max(1, Math.round((folded * 60) / secondsPerQuestion)),
                kind: 'learn',
                reason: sessionReason(queue.topic),
            });

            queue.remaining -= folded;
            dayLeft -= folded;
            placedToday += 1;
        }

        dayIndex += 1;
    }

    // Anything still queued ran out of days rather than out of budget — worth saying, because it
    // means the goal's daily minutes do not add up to its exam date.
    for (const queue of queues) {
        if (queue.remaining > 0) {
            omittedTopics.push({
                name: queue.topic.name,
                reason: `${queue.remaining} minutes of this could not be fitted before the exam`,
            });
        }
    }

    return {
        sessions,
        totalMinutesPlanned: sessions.reduce((sum, session) => sum + session.plannedMinutes, 0),
        topicsCovered: new Set(sessions.map((session) => session.topicId)).size,
        omittedTopics,
    };
}

/** Why a revision is due, in words. */
function revisionReason(due: DueRevision): string {
    const subject = due.subjectName ? ` (${due.subjectName})` : '';

    if (due.lapses > 1) {
        return `${due.name}${subject} has slipped ${due.lapses} times — a short review to hold onto it.`;
    }

    if (due.lastReviewAccuracy !== null && due.lastReviewAccuracy < 60) {
        return `You scored ${Math.round(due.lastReviewAccuracy)}% on ${due.name}${subject} last time, so it is due again.`;
    }

    return `${due.name}${subject} is due for revision before you forget it.`;
}

/** Why this topic is in the plan, in words a learner can argue with. */
function sessionReason(topic: PlanTopic): string {
    const subject = topic.subjectName ? ` (${topic.subjectName})` : '';

    if (topic.attempts === 0) {
        return `${topic.name}${subject} has not been started yet.`;
    }

    const mastery = Math.round(topic.masteryScore ?? 0);

    if (mastery < 40) {
        return `${topic.name}${subject} is at mastery ${mastery} from ${topic.attempts} attempts, so it needs the most time.`;
    }

    if (mastery < PLAN_CONFIG.masteryTarget) {
        return `${topic.name}${subject} is at mastery ${mastery} and close to solid — this should finish it.`;
    }

    return `${topic.name}${subject} is at mastery ${mastery}; this is to keep it from fading.`;
}
