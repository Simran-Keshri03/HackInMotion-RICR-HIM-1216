import { describe, expect, it } from 'vitest';
import {
    CALENDAR_DAYS,
    addDays,
    buildCalendar,
    levelFor,
} from '@/services/learner/activityEngine.js';

/**
 * The activity calendar, and the streaks read off it.
 *
 * The streaks are computed here rather than read from `learner_profiles`, so these tests are what
 * stands behind the number a learner sees next to a year of squares. A max streak that disagrees with
 * the grid beside it is the kind of thing somebody notices immediately and cannot unsee.
 */

const TODAY = '2026-08-14';

/** Counts for a list of dates, all with the same number of answers. */
function counts(dates: string[], perDay = 3): Map<string, number> {
    return new Map(dates.map((date) => [date, perDay]));
}

/** `n` consecutive dates ending on `end`. */
function run(end: string, n: number): string[] {
    return Array.from({ length: n }, (_, i) => addDays(end, -(n - 1 - i)));
}

describe('levelFor', () => {
    it('gives an empty day no shade at all', () => {
        expect(levelFor(0)).toBe(0);
    });

    it('reaches the top shade on a genuinely good day, not an impossible one', () => {
        // Thresholds are set for this app's scale: a practice session is a handful of questions, not
        // the fifty a competitive-programming site expects. Ten has to be reachable.
        expect(levelFor(1)).toBe(1);
        expect(levelFor(5)).toBe(2);
        expect(levelFor(8)).toBe(3);
        expect(levelFor(10)).toBe(4);
        expect(levelFor(200)).toBe(4);
    });

    it('never returns a shade the client has no colour for', () => {
        for (const count of [0, 1, 2, 3, 6, 9, 10, 11, 1000]) {
            expect(levelFor(count)).toBeGreaterThanOrEqual(0);
            expect(levelFor(count)).toBeLessThanOrEqual(4);
        }
    });
});

describe('buildCalendar — the grid', () => {
    it('returns a fixed-size window ending today', () => {
        const calendar = buildCalendar(new Map(), TODAY);

        expect(calendar.days).toHaveLength(CALENDAR_DAYS);
        expect(calendar.to).toBe(TODAY);
        expect(calendar.days[calendar.days.length - 1]!.date).toBe(TODAY);
        expect(calendar.days[0]!.date).toBe(calendar.from);
    });

    it('includes empty days rather than leaving gaps for the client to fill', () => {
        // A client that had to fill gaps itself is a client that could get them wrong, and the grid
        // is fixed-size anyway.
        const calendar = buildCalendar(counts([TODAY]), TODAY);

        expect(calendar.days.filter((day) => day.count === 0)).toHaveLength(CALENDAR_DAYS - 1);
    });

    it('produces days in ascending date order', () => {
        const calendar = buildCalendar(counts(run(TODAY, 10)), TODAY);
        const dates = calendar.days.map((day) => day.date);

        expect(dates).toEqual([...dates].sort());
    });

    it('ignores activity older than the window', () => {
        const calendar = buildCalendar(counts(['2020-01-01', '2019-06-06', TODAY]), TODAY);

        expect(calendar.activeDays).toBe(1);
        expect(calendar.totalAnswered).toBe(3);
    });

    it('counts totals and active days separately', () => {
        // Twelve answers over three days is three squares, not twelve.
        const calendar = buildCalendar(counts(run(TODAY, 3), 4), TODAY);

        expect(calendar.activeDays).toBe(3);
        expect(calendar.totalAnswered).toBe(12);
    });
});

describe('buildCalendar — max streak', () => {
    it('finds the longest run anywhere in the year', () => {
        const dates = [...run('2026-03-20', 14), ...run('2026-05-10', 5), ...run(TODAY, 2)];

        expect(buildCalendar(counts(dates), TODAY).maxStreak).toBe(14);
    });

    it('is zero for a learner who has never answered anything', () => {
        expect(buildCalendar(new Map(), TODAY).maxStreak).toBe(0);
    });

    it('does not join two runs across a gap', () => {
        const dates = [...run('2026-07-01', 4), ...run('2026-07-10', 4)];

        expect(buildCalendar(counts(dates), TODAY).maxStreak).toBe(4);
    });

    it('handles an unbroken year without running past the window', () => {
        const calendar = buildCalendar(counts(run(TODAY, CALENDAR_DAYS)), TODAY);

        expect(calendar.maxStreak).toBe(CALENDAR_DAYS);
        expect(calendar.currentStreak).toBe(CALENDAR_DAYS);
    });
});

describe('buildCalendar — current streak', () => {
    it('counts a run ending today', () => {
        expect(buildCalendar(counts(run(TODAY, 6)), TODAY).currentStreak).toBe(6);
    });

    /**
     * The decision worth defending. Somebody opening the app at nine in the morning has not lost
     * their streak — they have not yet had the chance to keep it. Telling them it is gone is how an
     * app talks a learner into giving up, and it is why GitHub and LeetCode both count back from
     * yesterday when today is still empty.
     */
    it('does not break a streak just because today has not started yet', () => {
        const yesterdayBack = run(addDays(TODAY, -1), 5);

        expect(buildCalendar(counts(yesterdayBack), TODAY).currentStreak).toBe(5);
    });

    it('is zero once a day has actually been missed', () => {
        // Last active the day before yesterday: that gap is real and the streak is over.
        const dates = run(addDays(TODAY, -2), 9);

        expect(buildCalendar(counts(dates), TODAY).currentStreak).toBe(0);
    });

    it('is zero for a learner who has never answered anything', () => {
        expect(buildCalendar(new Map(), TODAY).currentStreak).toBe(0);
    });

    it('never exceeds the max streak', () => {
        // The current run is one of the runs, so this has to hold for every input — a screen showing
        // a current streak above the maximum is self-evidently broken.
        const cases: Map<string, number>[] = [
            counts(run(TODAY, 7)),
            counts([...run('2026-04-01', 20), ...run(TODAY, 3)]),
            counts(run(addDays(TODAY, -1), 4)),
            new Map(),
        ];

        for (const input of cases) {
            const calendar = buildCalendar(input, TODAY);
            expect(calendar.currentStreak).toBeLessThanOrEqual(calendar.maxStreak);
        }
    });
});

describe('addDays', () => {
    it('goes backwards across month and year boundaries', () => {
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
        expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    });
});
