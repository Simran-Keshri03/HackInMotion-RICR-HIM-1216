import { describe, expect, it } from 'vitest';
import { consistencyPercent, daysBetween, nextHabits } from '@/services/learner/habitEngine.js';

/**
 * Streaks are the one number on the dashboard a learner checks every single day, which makes being
 * wrong about them expensive in a way that a mastery score being two points off is not. Somebody
 * who practised yesterday and today and is told their streak is one will not report it as a bug —
 * they will stop believing the screen.
 *
 * So the cases here are the boundaries: the same day twice, exactly one day's gap, two days' gap,
 * and a clock that disagrees with itself.
 */

const base = {
    currentStreakDays: 0,
    longestStreakDays: 0,
    lastActivityDate: null,
    avgSecondsPerQuestion: null,
    totalAttempts: 0,
};

const noTiming = { today: '2026-08-13', secondsTaken: null };

describe('daysBetween', () => {
    it('counts whole days regardless of month or year boundaries', () => {
        expect(daysBetween('2026-08-12', '2026-08-13')).toBe(1);
        expect(daysBetween('2026-07-31', '2026-08-01')).toBe(1);
        expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
        expect(daysBetween('2026-08-13', '2026-08-13')).toBe(0);
    });

    it('goes negative when the dates are the wrong way round', () => {
        expect(daysBetween('2026-08-13', '2026-08-12')).toBe(-1);
    });
});

describe('nextHabits — streaks', () => {
    it('starts a streak at one on the first ever answer', () => {
        const habits = nextHabits(base, noTiming);

        expect(habits.currentStreakDays).toBe(1);
        expect(habits.longestStreakDays).toBe(1);
        expect(habits.lastActivityDate).toBe('2026-08-13');
    });

    it('extends the streak when yesterday was the last active day', () => {
        const habits = nextHabits(
            { ...base, currentStreakDays: 4, longestStreakDays: 9, lastActivityDate: '2026-08-12' },
            noTiming
        );

        expect(habits.currentStreakDays).toBe(5);
        // The record stands until it is actually beaten.
        expect(habits.longestStreakDays).toBe(9);
    });

    it('does not count the same day twice', () => {
        const habits = nextHabits(
            { ...base, currentStreakDays: 4, longestStreakDays: 4, lastActivityDate: '2026-08-13' },
            noTiming
        );

        // Twenty questions in one day is one day. Otherwise the streak measures answers, not days,
        // and a learner could sit at 40 by never coming back.
        expect(habits.currentStreakDays).toBe(4);
    });

    it('breaks the streak after a missed day', () => {
        const habits = nextHabits(
            {
                ...base,
                currentStreakDays: 12,
                longestStreakDays: 12,
                lastActivityDate: '2026-08-11',
            },
            noTiming
        );

        expect(habits.currentStreakDays).toBe(1);
        // Broken, not erased — the twelve days happened.
        expect(habits.longestStreakDays).toBe(12);
    });

    it('raises the record as soon as the current streak passes it', () => {
        const habits = nextHabits(
            { ...base, currentStreakDays: 9, longestStreakDays: 9, lastActivityDate: '2026-08-12' },
            noTiming
        );

        expect(habits.currentStreakDays).toBe(10);
        expect(habits.longestStreakDays).toBe(10);
    });

    /**
     * The database has a CHECK requiring current <= longest, so any pair this produces has to
     * satisfy it or the write is rejected and the answer's counters are silently lost.
     */
    it('never returns a current streak above the longest', () => {
        const cases = [
            { currentStreakDays: 0, longestStreakDays: 0, lastActivityDate: null },
            { currentStreakDays: 3, longestStreakDays: 3, lastActivityDate: '2026-08-12' },
            { currentStreakDays: 7, longestStreakDays: 2, lastActivityDate: '2026-08-12' },
            { currentStreakDays: 1, longestStreakDays: 40, lastActivityDate: '2026-01-01' },
        ];

        for (const state of cases) {
            const habits = nextHabits({ ...base, ...state }, noTiming);
            expect(habits.currentStreakDays).toBeLessThanOrEqual(habits.longestStreakDays);
        }
    });

    it('leaves the streak alone when the last active date is in the future', () => {
        // A device with a wrong clock, or a row written from a different timezone. Resetting a
        // long streak because of it would be the app's mistake charged to the learner.
        const habits = nextHabits(
            { ...base, currentStreakDays: 6, longestStreakDays: 6, lastActivityDate: '2026-08-20' },
            noTiming
        );

        expect(habits.currentStreakDays).toBe(6);
    });
});

describe('nextHabits — answering speed', () => {
    it('starts the average from the first timed answer', () => {
        const habits = nextHabits(base, { today: '2026-08-13', secondsTaken: 30 });

        expect(habits.avgSecondsPerQuestion).toBe(30);
    });

    it('keeps a running mean instead of re-reading the history', () => {
        // 20 answers averaging 30s, then one at 60s: (600 + 60) / 21
        const habits = nextHabits(
            { ...base, avgSecondsPerQuestion: 30, totalAttempts: 20 },
            { today: '2026-08-13', secondsTaken: 60 }
        );

        expect(habits.avgSecondsPerQuestion).toBeCloseTo(31.43, 2);
    });

    it('caps an answer that was really a learner walking away', () => {
        // Opened the tab, came back an hour later. Credited at the 600s cap, not 3600.
        const habits = nextHabits(
            { ...base, avgSecondsPerQuestion: 30, totalAttempts: 9 },
            { today: '2026-08-13', secondsTaken: 3600 }
        );

        expect(habits.avgSecondsPerQuestion).toBe(87);
        // Whatever it is, the database's 0-3600 CHECK has to accept it.
        expect(habits.avgSecondsPerQuestion!).toBeLessThanOrEqual(3600);
    });

    it('leaves the average untouched when no timing was reported', () => {
        const habits = nextHabits(
            { ...base, avgSecondsPerQuestion: 42, totalAttempts: 5 },
            { today: '2026-08-13', secondsTaken: null }
        );

        expect(habits.avgSecondsPerQuestion).toBe(42);
    });
});

describe('consistencyPercent', () => {
    it('scores a learner on their first day at 100, not zero', () => {
        // The span includes today, so this is 1/1 rather than a division by zero — and it is the
        // moment somebody is most likely to give up.
        expect(consistencyPercent({ distinctDays: 1, firstDate: '2026-08-13' }, '2026-08-13')).toBe(
            100
        );
    });

    it('measures days studied against days available', () => {
        // Started 9 days ago, studied 5 of the 10 days including today.
        expect(consistencyPercent({ distinctDays: 5, firstDate: '2026-08-04' }, '2026-08-13')).toBe(
            50
        );
    });

    it('never exceeds 100 even when the counts disagree', () => {
        // A client and server in different timezones can record two calendar days for one day.
        expect(consistencyPercent({ distinctDays: 5, firstDate: '2026-08-12' }, '2026-08-13')).toBe(
            100
        );
    });

    it('returns null rather than a made-up number when there is nothing to measure', () => {
        expect(consistencyPercent({ distinctDays: 0, firstDate: '2026-08-13' }, '2026-08-13')).toBe(
            null
        );
    });
});
