/**
 * Streaks, consistency and answering speed — the numbers that describe *how* somebody studies
 * rather than how much they know.
 *
 * Pure, like the mastery engine, and for the same reason: these end up on the learner's dashboard
 * and inside the readiness score, so being able to test them against hand-worked examples matters
 * more than saving a file.
 *
 * The one design decision worth stating. A streak looks like it needs the whole history walked
 * day by day, and it does not — the previous streak and the date it was last touched are enough:
 *
 *     last active today      -> unchanged, they already practised today
 *     last active yesterday  -> one more
 *     anything older, or never -> back to one, today
 *
 * That is O(1) on the path that runs after every single answer. Walking the history there would
 * mean re-reading every attempt a learner has ever made in order to add one, which is the kind of
 * thing that is fine for a month and then is not.
 *
 * Consistency is the exception and cannot be done this way: "how many of the days available did
 * you study" needs a count of distinct days, which is not derivable from a streak. It is passed in
 * by the caller, which reads it from the attempts themselves.
 */

export interface HabitState {
    currentStreakDays: number;
    longestStreakDays: number;
    /** YYYY-MM-DD, or null for a learner who has never answered anything. */
    lastActivityDate: string | null;
    avgSecondsPerQuestion: number | null;
    /** Answers recorded before this one. */
    totalAttempts: number;
}

export interface HabitEvent {
    /** YYYY-MM-DD in the learner's own reckoning. */
    today: string;
    /** How long this answer took, when the client reported it. */
    secondsTaken: number | null;
    /**
     * Distinct days this learner has practised on, and the first of them. Counted from the
     * attempts table, because a streak cannot tell you about the days it was broken.
     *
     * Left out when it is not worth a query, in which case consistency is left as it was rather
     * than guessed at.
     */
    practice?: { distinctDays: number; firstDate: string };
}

export interface HabitUpdate {
    currentStreakDays: number;
    longestStreakDays: number;
    lastActivityDate: string;
    avgSecondsPerQuestion: number | null;
    consistencyScore: number | null;
}

/** Longest gap that still counts as keeping a streak: yesterday, and nothing further back. */
const STREAK_GAP_DAYS = 1;

/**
 * Speed is capped before it is averaged.
 *
 * A learner who opens practice, leaves the tab, and answers an hour later did not spend an hour
 * thinking. Left uncapped, one such answer drags the average far enough to make the adaptive
 * engine's time estimates useless — and those estimates are what a study plan's "20 minutes"
 * rests on. The cap is deliberately generous: a genuinely hard question can take minutes.
 */
const MAX_CREDITED_SECONDS = 600;

/** Whole days between two YYYY-MM-DD dates, counted in UTC so a timezone cannot shift the answer. */
export function daysBetween(from: string, to: string): number {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);

    if (Number.isNaN(start) || Number.isNaN(end)) return Number.NaN;

    return Math.round((end - start) / 86_400_000);
}

/**
 * The learner's habits after one more answer.
 *
 * Never lowers `longestStreakDays`: the database has a CHECK constraint requiring the current
 * streak to be no greater than the longest, so the two have to move together or a write is
 * rejected outright.
 */
export function nextHabits(previous: HabitState, event: HabitEvent): HabitUpdate {
    const currentStreakDays = nextStreak(
        previous.currentStreakDays,
        previous.lastActivityDate,
        event.today
    );

    return {
        currentStreakDays,
        longestStreakDays: Math.max(previous.longestStreakDays, currentStreakDays),
        lastActivityDate: event.today,
        avgSecondsPerQuestion: nextAverageSeconds(previous, event.secondsTaken),
        consistencyScore: event.practice
            ? consistencyPercent(event.practice, event.today)
            : null,
    };
}

function nextStreak(
    previousStreak: number,
    lastActivityDate: string | null,
    today: string
): number {
    if (!lastActivityDate) return 1;

    const gap = daysBetween(lastActivityDate, today);

    // A date in the future, or an unparseable one, means something is wrong with the clock rather
    // than with the learner. Leaving the streak alone is the conservative answer; resetting it
    // would punish them for it.
    if (Number.isNaN(gap) || gap < 0) return Math.max(previousStreak, 1);

    if (gap === 0) return Math.max(previousStreak, 1);
    if (gap <= STREAK_GAP_DAYS) return previousStreak + 1;

    return 1;
}

/**
 * Running mean, so the whole history does not have to be re-read to add one answer.
 *
 * The previous count is the number of answers behind the existing average. When there is no
 * average yet — an older profile, or a learner whose earlier answers arrived without timings —
 * this answer starts one, rather than being averaged into nothing.
 */
function nextAverageSeconds(
    previous: HabitState,
    secondsTaken: number | null
): number | null {
    if (secondsTaken === null || !Number.isFinite(secondsTaken) || secondsTaken < 0) {
        return previous.avgSecondsPerQuestion;
    }

    const credited = Math.min(secondsTaken, MAX_CREDITED_SECONDS);

    if (previous.avgSecondsPerQuestion === null || previous.totalAttempts <= 0) {
        return round2(credited);
    }

    const total =
        previous.avgSecondsPerQuestion * previous.totalAttempts + credited;

    return round2(total / (previous.totalAttempts + 1));
}

/**
 * Days practised as a percentage of days available, counting from the learner's first answer.
 *
 * Counted from the first answer rather than from sign-up on purpose: somebody who registered in
 * January and started in June is not 5% consistent, they are new. Their first day is day one.
 *
 * The span always includes today, so a learner on their first ever day scores 100 rather than
 * dividing by zero — which is both correct and the kinder answer at the moment somebody is most
 * likely to give up.
 */
export function consistencyPercent(
    practice: { distinctDays: number; firstDate: string },
    today: string
): number | null {
    const span = daysBetween(practice.firstDate, today) + 1;

    if (Number.isNaN(span) || span <= 0 || practice.distinctDays <= 0) return null;

    // Days practised cannot exceed days available; clamped rather than trusted, because a
    // timezone disagreement between client and server could otherwise produce 105%.
    return round2(Math.min(100, (practice.distinctDays / span) * 100));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}
