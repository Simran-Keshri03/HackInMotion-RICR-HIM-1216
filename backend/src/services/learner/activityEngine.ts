/**
 * The activity calendar: how much was answered on each of the last 365 days.
 *
 * The same shape as the contribution grid on GitHub or LeetCode, and for the same reason — a year of
 * effort as one glance is a stronger motivator than any number, because it shows the gaps as well as
 * the work. A learner who sees three weeks of green does not want to be the one to break it.
 *
 * Pure, and it computes the streaks itself rather than reading the stored ones. That is deliberate:
 * `learner_profiles.current_streak_days` is maintained forward one answer at a time, so it knows
 * nothing about history written before it existed and cannot be checked. Deriving both streaks from
 * the day list here means the number on the screen is always consistent with the squares next to it,
 * and a learner whose profile counter was never populated still sees the truth.
 *
 * Timezone matters throughout. A day is a day in the learner's own reckoning, so the caller converts
 * timestamps before they arrive here — see utils/dates.ts for the bug that taught us that.
 */

/** One square. */
export interface ActivityDay {
    /** YYYY-MM-DD. */
    date: string;
    count: number;
    /** 0 to 4, for the colour ramp. 0 means nothing was answered. */
    level: 0 | 1 | 2 | 3 | 4;
}

export interface ActivityCalendar {
    days: ActivityDay[];
    /** Questions answered across the window. */
    totalAnswered: number;
    /** Days with at least one answer. */
    activeDays: number;
    /** Longest unbroken run of active days in the window. */
    maxStreak: number;
    /** Unbroken run ending today, or yesterday if today has no answers yet. */
    currentStreak: number;
    /** The window, so the client does not have to guess what it is looking at. */
    from: string;
    to: string;
}

/** A year, as LeetCode and GitHub show it. */
export const CALENDAR_DAYS = 365;

/**
 * Answer counts that map to each shade.
 *
 * Chosen for this app's scale rather than copied: a practice session here is a handful of questions,
 * not the fifty a competitive-programming site expects, so the top shade has to be reachable by
 * somebody having a genuinely good day. Ten questions is that.
 */
const LEVEL_THRESHOLDS = [1, 3, 6, 10] as const;

export function levelFor(count: number): 0 | 1 | 2 | 3 | 4 {
    if (count <= 0) return 0;
    if (count < LEVEL_THRESHOLDS[1]) return 1;
    if (count < LEVEL_THRESHOLDS[2]) return 2;
    if (count < LEVEL_THRESHOLDS[3]) return 3;

    return 4;
}

/** YYYY-MM-DD, `days` after `date`, in UTC so a timezone cannot shift a date already settled. */
export function addDays(date: string, days: number): string {
    const base = Date.parse(`${date}T00:00:00Z`);
    return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Builds the calendar from a count per active day.
 *
 * Takes a map rather than raw timestamps because grouping into the learner's local days needs their
 * timezone, which is I/O the caller already has and this function should not.
 *
 * Every day in the window appears, including empty ones — the grid is fixed-size, and a client that
 * had to fill gaps itself would be a client that could get the gaps wrong.
 */
export function buildCalendar(
    countsByDate: Map<string, number>,
    today: string,
    windowDays = CALENDAR_DAYS
): ActivityCalendar {
    const from = addDays(today, -(windowDays - 1));

    const days: ActivityDay[] = [];
    let totalAnswered = 0;
    let activeDays = 0;

    let maxStreak = 0;
    let running = 0;

    for (let offset = 0; offset < windowDays; offset += 1) {
        const date = addDays(from, offset);
        const count = countsByDate.get(date) ?? 0;

        days.push({ date, count, level: levelFor(count) });

        totalAnswered += count;

        if (count > 0) {
            activeDays += 1;
            running += 1;
            maxStreak = Math.max(maxStreak, running);
        } else {
            running = 0;
        }
    }

    return {
        days,
        totalAnswered,
        activeDays,
        maxStreak,
        currentStreak: currentStreakFrom(countsByDate, today),
        from,
        to: today,
    };
}

/**
 * The run ending now.
 *
 * Counted back from today, but a day with nothing answered *yet* does not break it. Somebody opening
 * the app at nine in the morning has not lost their streak — they have not had the chance to keep it,
 * and telling them it is gone is how an app talks somebody into giving up. So the walk starts at
 * yesterday when today is still empty, which is what LeetCode and GitHub both do.
 */
function currentStreakFrom(countsByDate: Map<string, number>, today: string): number {
    const startedToday = (countsByDate.get(today) ?? 0) > 0;

    let streak = 0;
    let cursor = startedToday ? today : addDays(today, -1);

    // Bounded by the window: an unbroken year is a real possibility and the loop must still end.
    for (let step = 0; step < CALENDAR_DAYS + 1; step += 1) {
        if ((countsByDate.get(cursor) ?? 0) <= 0) break;

        streak += 1;
        cursor = addDays(cursor, -1);
    }

    return streak;
}
