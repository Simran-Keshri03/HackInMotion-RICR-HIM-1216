/**
 * Spaced repetition: when a topic should be seen again.
 *
 * The interval arithmetic is the SM-2 family — SuperMemo's algorithm, the one Anki and Mnemosyne
 * use, and the "proven memory-retention technique" the brief asks for. A review that goes well
 * multiplies the gap by an ease factor; one that goes badly collapses it back to a day. Ease itself
 * drifts, so a topic this particular learner finds hard returns sooner than one they find easy, even
 * at the same mastery score.
 *
 * Pure, like every other engine here. Two adaptations from the flashcard version, and both are the
 * reason an off-the-shelf scheduler would have been wrong:
 *
 * **The unit is a topic, not a card.** A card is recalled or it is not, and SM-2 takes a 0-5 grade
 * from the learner about their own memory. A topic is a set of questions with an accuracy, and the
 * app already knows that accuracy — so the grade is measured rather than self-reported. That is
 * strictly better evidence: people are famously bad at judging what they know, and this is the same
 * reason session completion is read from attempts instead of a checkbox.
 *
 * **The exam caps the interval.** Anki assumes you want to remember something forever, so its
 * intervals grow without limit. Here there is a date after which none of it matters. Scheduling a
 * topic 60 days out when the exam is in 30 is not a scheduling decision, it is quietly dropping the
 * topic — so intervals are clamped to land before the exam, and a topic that cannot fit another
 * review is said to be finished rather than scheduled into the void.
 */

/** What the schedule currently says about a topic. Null for one never reviewed. */
export interface ReviewState {
    intervalDays: number;
    easeFactor: number;
    reviewCount: number;
    lapses: number;
    /** YYYY-MM-DD, or null before the first review. */
    lastReviewedOn: string | null;
}

export interface ReviewOutcome {
    /** YYYY-MM-DD the review happened on. */
    reviewedOn: string;
    /** 0-100 across the questions answered in this review. */
    accuracyPercent: number;
    /** How many questions that accuracy is based on. */
    questionsAnswered: number;
    /**
     * Whole days from `reviewedOn` to the exam, so the next interval cannot land after it.
     * Null when there is no goal, in which case the ordinary ceiling applies.
     */
    daysUntilExam: number | null;
}

export interface ScheduleUpdate {
    /** YYYY-MM-DD. */
    dueOn: string;
    intervalDays: number;
    easeFactor: number;
    reviewCount: number;
    lapses: number;
    lastReviewedOn: string;
    lastReviewAccuracy: number;
    /** True when this review was a failure and the interval collapsed. */
    lapsed: boolean;
    /** True when no further review fits before the exam. */
    finishedForThisGoal: boolean;
}

export const SRS_CONFIG = {
    /**
     * Accuracy at or above which a review counts as a pass and the interval grows.
     *
     * 80 rather than 100 because a topic is many questions: insisting on perfection would keep
     * competent topics in daily rotation and crowd out the ones actually at risk.
     */
    passAccuracyPercent: 80,

    /**
     * Below this the review is a failure and the interval collapses to one day.
     *
     * Between this and the pass mark is the shaky middle, where the interval grows a little but not
     * by the full ease — the learner knows some of it, and neither resetting nor a full step is
     * honest about that.
     */
    lapseAccuracyPercent: 50,

    /** Growth applied in the shaky middle, instead of the ease factor. */
    shakyMultiplier: 1.2,

    /** Ease moves by this much on a pass or a lapse. SM-2 uses steps of roughly this size. */
    easeStep: 0.15,

    /** SM-2's floor. Below it the interval barely grows and the schedule is the wrong tool. */
    minEase: 1.3,
    maxEase: 3.0,

    /** First gap after learning a topic. Short on purpose: the first forgetting happens fastest. */
    firstIntervalDays: 1,

    /** Second gap, before ease starts multiplying. The standard SM-2 opening. */
    secondIntervalDays: 3,

    /** Longest gap regardless of exam date. Past this, a topic is not being revised, it is parked. */
    maxIntervalDays: 60,

    /**
     * Answers needed before a review's accuracy is trusted to move the schedule.
     *
     * One answer is a coin flip. Below this the review still counts as done — the topic was seen —
     * but the interval takes the cautious path rather than a full step.
     */
    minQuestionsForFullCredit: 3,

    /**
     * Days before the exam within which no new review is scheduled.
     *
     * The last day or two belong to whatever the learner wants to do with them, and a review due the
     * morning of the exam is not a plan.
     */
    examBufferDays: 1,
} as const;

/** YYYY-MM-DD, `days` after `date`, in UTC so a timezone cannot shift it. */
export function addDays(date: string, days: number): string {
    const base = Date.parse(`${date}T00:00:00Z`);
    return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

function clamp(value: number, low: number, high: number): number {
    return Math.min(high, Math.max(low, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * The schedule for a topic that has just been studied for the first time.
 *
 * Separate from `nextReview` because a first sighting is not a review: there is no interval to grow
 * and no ease to adjust, and pretending otherwise would apply a multiplier to nothing.
 */
export function firstSchedule(studiedOn: string, daysUntilExam: number | null): ScheduleUpdate {
    const { firstIntervalDays, examBufferDays } = SRS_CONFIG;

    const room = daysUntilExam === null ? Number.POSITIVE_INFINITY : daysUntilExam - examBufferDays;

    if (room < firstIntervalDays) {
        return {
            dueOn: studiedOn,
            intervalDays: firstIntervalDays,
            easeFactor: 2.5,
            reviewCount: 0,
            lapses: 0,
            lastReviewedOn: studiedOn,
            lastReviewAccuracy: 0,
            lapsed: false,
            finishedForThisGoal: true,
        };
    }

    return {
        dueOn: addDays(studiedOn, firstIntervalDays),
        intervalDays: firstIntervalDays,
        easeFactor: 2.5,
        reviewCount: 0,
        lapses: 0,
        lastReviewedOn: studiedOn,
        lastReviewAccuracy: 0,
        lapsed: false,
        finishedForThisGoal: false,
    };
}

/**
 * The schedule after a review.
 *
 * `state` is null for a topic being reviewed without a schedule yet — which happens for every topic
 * practised before this feature existed, so it is a normal path rather than an edge case.
 */
export function nextReview(state: ReviewState | null, outcome: ReviewOutcome): ScheduleUpdate {
    const {
        passAccuracyPercent,
        lapseAccuracyPercent,
        shakyMultiplier,
        easeStep,
        minEase,
        maxEase,
        firstIntervalDays,
        secondIntervalDays,
        maxIntervalDays,
        minQuestionsForFullCredit,
        examBufferDays,
    } = SRS_CONFIG;

    const current: ReviewState = state ?? {
        intervalDays: firstIntervalDays,
        easeFactor: 2.5,
        reviewCount: 0,
        lapses: 0,
        lastReviewedOn: null,
    };

    const accuracy = clamp(outcome.accuracyPercent, 0, 100);
    const thinEvidence = outcome.questionsAnswered < minQuestionsForFullCredit;

    const reviewCount = current.reviewCount + 1;
    let easeFactor = current.easeFactor;
    let lapses = current.lapses;
    let lapsed = false;
    let intervalDays: number;

    if (accuracy < lapseAccuracyPercent) {
        // Failure: back to tomorrow, and this topic is now known to be harder than assumed. Ease
        // falls even on thin evidence — getting one of two wrong is still getting it wrong.
        intervalDays = firstIntervalDays;
        easeFactor = clamp(current.easeFactor - easeStep, minEase, maxEase);
        lapses += 1;
        lapsed = true;
    } else if (accuracy >= passAccuracyPercent) {
        // Pass. The standard SM-2 opening: fixed first and second gaps, ease only from the third
        // review, by which point there is enough evidence for a multiplier to mean something.
        if (thinEvidence) {
            // Two right out of two is encouraging, not proof. Step, but do not compound.
            intervalDays = Math.round(current.intervalDays * shakyMultiplier);
        } else if (reviewCount === 1) {
            intervalDays = secondIntervalDays;
        } else {
            intervalDays = Math.round(current.intervalDays * current.easeFactor);
            easeFactor = clamp(current.easeFactor + easeStep, minEase, maxEase);
        }
    } else {
        // The shaky middle: some of it stuck. Grow a little, leave ease alone.
        intervalDays = Math.round(current.intervalDays * shakyMultiplier);
    }

    intervalDays = clamp(Math.max(1, intervalDays), 1, maxIntervalDays);

    // ---- the exam ceiling ----
    // Everything above is Anki's arithmetic, which assumes remembering forever. This is the part
    // that knows about the exam.
    const room =
        outcome.daysUntilExam === null
            ? Number.POSITIVE_INFINITY
            : outcome.daysUntilExam - examBufferDays;

    if (room < 1) {
        // No time for another review. Reported as finished rather than scheduled past the exam,
        // where it would sit in the list forever looking overdue.
        return {
            dueOn: outcome.reviewedOn,
            intervalDays,
            easeFactor: round2(easeFactor),
            reviewCount,
            lapses,
            lastReviewedOn: outcome.reviewedOn,
            lastReviewAccuracy: round2(accuracy),
            lapsed,
            finishedForThisGoal: true,
        };
    }

    // Pulled in to fit rather than dropped: a shortened final review beats none.
    const scheduled = Math.min(intervalDays, Math.floor(room));

    return {
        dueOn: addDays(outcome.reviewedOn, scheduled),
        intervalDays: scheduled,
        easeFactor: round2(easeFactor),
        reviewCount,
        lapses,
        lastReviewedOn: outcome.reviewedOn,
        lastReviewAccuracy: round2(accuracy),
        lapsed,
        finishedForThisGoal: false,
    };
}

/**
 * How overdue a topic is, in days. Negative means not yet due.
 *
 * Used to order the revision list: the longest overdue is the closest to being forgotten, which is
 * the whole premise of the schedule.
 */
export function daysOverdue(dueOn: string, today: string): number {
    const due = Date.parse(`${dueOn}T00:00:00Z`);
    const now = Date.parse(`${today}T00:00:00Z`);

    if (Number.isNaN(due) || Number.isNaN(now)) return 0;

    return Math.round((now - due) / 86_400_000);
}

/** Whether this topic is owed a review as of `today`. */
export function isDue(dueOn: string, today: string): boolean {
    return daysOverdue(dueOn, today) >= 0;
}
