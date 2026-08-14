/**
 * Badges: the milestones a learner has actually passed.
 *
 * Derived from the record rather than stored. There is no `badges` table and no "award" write, which
 * is a deliberate choice with a real consequence — it means a badge cannot be wrong. Storage would
 * introduce a second source of truth that could drift from the attempts behind it: a failed write and
 * the badge is missing, a replayed one and it is duplicated, a changed threshold and every stored row
 * is stale. Recomputing from the history costs one pass over data the activity calendar has already
 * loaded, and is always right by construction.
 *
 * What is given up: a "you just earned this!" moment at the instant it happens, and a permanent award
 * date if the criteria ever change. Both are worth less than the badges being true, and the earned
 * date is recoverable anyway — the day a 7-day streak was reached is the seventh day of that run.
 *
 * Pure. The thresholds are the interesting part and they are all in one table below, where they can
 * be argued with instead of hunted for.
 */

export type BadgeFamily = 'streak' | 'volume' | 'mastery' | 'accuracy' | 'revision';

export interface Badge {
    /** Stable across recomputes, so the client can key on it. */
    id: string;
    name: string;
    family: BadgeFamily;
    /** What it took, in words, for a learner reading their own shelf. */
    description: string;
    /** YYYY-MM-DD when the criteria were met, when that is recoverable. */
    earnedOn: string | null;
}

export interface BadgeProgress {
    /** The next badge in this family, and how far along they are. */
    id: string;
    name: string;
    family: BadgeFamily;
    current: number;
    target: number;
    /** What to show under the bar. */
    description: string;
}

/** Everything the badges are judged on. */
export interface BadgeInputs {
    /** Active days in order, oldest first. Used for streak dates. */
    activeDates: string[];
    maxStreak: number;
    totalAnswered: number;
    /** Topics at or above the mastery bar. */
    topicsMastered: number;
    /** Overall accuracy 0-100, or null with too little evidence. */
    accuracyPercent: number | null;
    /** Reviews completed through the spaced-repetition schedule. */
    reviewsCompleted: number;
}

/**
 * Mastery a topic counts as learned at.
 *
 * The same 85 the planner stops allocating fresh time at, on purpose: a learner should not be told a
 * topic is mastered by one screen while another is still scheduling work on it.
 */
export const MASTERY_BAR = 85;

/** Answers needed before an accuracy badge means anything. */
const MIN_ANSWERS_FOR_ACCURACY = 30;

/**
 * The tiers.
 *
 * Deliberately shallow at the bottom. The first badge is three days, not thirty: the point of the
 * first one is to be reachable by somebody who has not yet decided whether they are the sort of person
 * who keeps a streak. A ladder whose first rung is a month is a ladder that only rewards people who
 * were already going to persist.
 */
const TIERS: {
    family: BadgeFamily;
    target: number;
    id: string;
    name: string;
    describe: (target: number) => string;
}[] = [
    // ---- streak ----
    {
        family: 'streak',
        target: 3,
        id: 'streak-3',
        name: 'Getting Started',
        describe: (n) => `Studied ${n} days in a row.`,
    },
    {
        family: 'streak',
        target: 7,
        id: 'streak-7',
        name: 'One Week',
        describe: (n) => `Studied ${n} days in a row.`,
    },
    {
        family: 'streak',
        target: 30,
        id: 'streak-30',
        name: 'One Month',
        describe: (n) => `Studied ${n} days in a row.`,
    },
    {
        family: 'streak',
        target: 50,
        id: 'streak-50',
        name: '50 Days',
        describe: (n) => `Studied ${n} days in a row.`,
    },
    {
        family: 'streak',
        target: 100,
        id: 'streak-100',
        name: 'Century',
        describe: (n) => `Studied ${n} days in a row.`,
    },

    // ---- volume ----
    {
        family: 'volume',
        target: 25,
        id: 'volume-25',
        name: 'First 25',
        describe: (n) => `Answered ${n} questions.`,
    },
    {
        family: 'volume',
        target: 100,
        id: 'volume-100',
        name: 'Hundred Up',
        describe: (n) => `Answered ${n} questions.`,
    },
    {
        family: 'volume',
        target: 500,
        id: 'volume-500',
        name: 'Five Hundred',
        describe: (n) => `Answered ${n} questions.`,
    },
    {
        family: 'volume',
        target: 1000,
        id: 'volume-1000',
        name: 'Thousand Club',
        describe: (n) => `Answered ${n} questions.`,
    },

    // ---- mastery ----
    {
        family: 'mastery',
        target: 1,
        id: 'mastery-1',
        name: 'First Topic Mastered',
        describe: () => `Took a topic past ${MASTERY_BAR} mastery.`,
    },
    {
        family: 'mastery',
        target: 5,
        id: 'mastery-5',
        name: 'Five Mastered',
        describe: (n) => `Took ${n} topics past ${MASTERY_BAR} mastery.`,
    },
    {
        family: 'mastery',
        target: 15,
        id: 'mastery-15',
        name: 'Fifteen Mastered',
        describe: (n) => `Took ${n} topics past ${MASTERY_BAR} mastery.`,
    },

    // ---- accuracy ----
    {
        family: 'accuracy',
        target: 70,
        id: 'accuracy-70',
        name: 'Steady Hand',
        describe: (n) => `${n}% accuracy over ${MIN_ANSWERS_FOR_ACCURACY}+ questions.`,
    },
    {
        family: 'accuracy',
        target: 85,
        id: 'accuracy-85',
        name: 'Sharp',
        describe: (n) => `${n}% accuracy over ${MIN_ANSWERS_FOR_ACCURACY}+ questions.`,
    },

    // ---- revision ----
    {
        family: 'revision',
        target: 10,
        id: 'revision-10',
        name: 'Comes Back',
        describe: (n) => `Completed ${n} scheduled revisions.`,
    },
    {
        family: 'revision',
        target: 50,
        id: 'revision-50',
        name: 'Never Forgets',
        describe: (n) => `Completed ${n} scheduled revisions.`,
    },
];

function valueFor(family: BadgeFamily, inputs: BadgeInputs): number {
    switch (family) {
        case 'streak':
            return inputs.maxStreak;
        case 'volume':
            return inputs.totalAnswered;
        case 'mastery':
            return inputs.topicsMastered;
        case 'accuracy':
            // Gated on evidence: 100% from four questions is not accuracy, it is a small sample.
            return inputs.totalAnswered >= MIN_ANSWERS_FOR_ACCURACY
                ? (inputs.accuracyPercent ?? 0)
                : 0;
        case 'revision':
            return inputs.reviewsCompleted;
    }
}

/**
 * The date a streak of `length` was first reached, from the list of active days.
 *
 * The only badge family whose date is recoverable, and it is worth recovering because a streak badge
 * without a date is just a number the learner already has on their dashboard. Walks the runs and
 * returns the day the target was hit — for the *earliest* such run, since that is when they earned it.
 */
export function streakReachedOn(activeDates: string[], length: number): string | null {
    if (length <= 0 || activeDates.length < length) return null;

    const sorted = [...activeDates].sort();
    let run = 0;

    for (let i = 0; i < sorted.length; i += 1) {
        const previous = i > 0 ? sorted[i - 1]! : null;
        const consecutive =
            previous !== null &&
            Date.parse(`${sorted[i]!}T00:00:00Z`) - Date.parse(`${previous}T00:00:00Z`) ===
                86_400_000;

        run = consecutive ? run + 1 : 1;

        if (run >= length) return sorted[i]!;
    }

    return null;
}

/** Every badge the record supports, newest first. */
export function earnedBadges(inputs: BadgeInputs): Badge[] {
    const earned: Badge[] = [];

    for (const tier of TIERS) {
        if (valueFor(tier.family, inputs) < tier.target) continue;

        earned.push({
            id: tier.id,
            name: tier.name,
            family: tier.family,
            description: tier.describe(tier.target),
            // Only streaks can say when. Claiming a date for the others would mean inventing one.
            earnedOn:
                tier.family === 'streak' ? streakReachedOn(inputs.activeDates, tier.target) : null,
        });
    }

    // Newest first, matching how a learner reads their own shelf. Undated badges sort after dated
    // ones rather than being dropped.
    return earned.sort((a, b) => (b.earnedOn ?? '').localeCompare(a.earnedOn ?? ''));
}

/**
 * The next badge in each family, with progress.
 *
 * The part that does the motivating. A shelf of what somebody already has is a record; "two more days"
 * is a reason to open the app tomorrow, and it is the same reason a progress bar beats a locked icon.
 * Families already complete are left out — there is nothing to work toward.
 */
export function nextBadges(inputs: BadgeInputs): BadgeProgress[] {
    const families: BadgeFamily[] = ['streak', 'volume', 'mastery', 'accuracy', 'revision'];
    const upcoming: BadgeProgress[] = [];

    for (const family of families) {
        const current = valueFor(family, inputs);
        const next = TIERS.find((tier) => tier.family === family && current < tier.target);

        if (!next) continue;

        upcoming.push({
            id: next.id,
            name: next.name,
            family,
            current: Math.round(current),
            target: next.target,
            description: next.describe(next.target),
        });
    }

    // Closest to completion first, so the top of the list is the one actually within reach.
    return upcoming.sort((a, b) => b.current / b.target - a.current / a.target);
}
