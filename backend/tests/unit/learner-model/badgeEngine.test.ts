import { describe, expect, it } from 'vitest';
import {
    type BadgeInputs,
    MASTERY_BAR,
    earnedBadges,
    nextBadges,
    streakReachedOn,
} from '@/services/learner/badgeEngine.js';

/**
 * Badges are recomputed from the record on every read rather than stored, so what these tests protect
 * is that the recomputation cannot award something unearned or lose something earned. A badge that
 * appears and then vanishes is worse than no badges at all — it makes the whole screen untrustworthy.
 */

function inputs(overrides: Partial<BadgeInputs> = {}): BadgeInputs {
    return {
        activeDates: [],
        maxStreak: 0,
        totalAnswered: 0,
        topicsMastered: 0,
        accuracyPercent: null,
        reviewsCompleted: 0,
        ...overrides,
    };
}

/** `n` consecutive dates ending on `end`. */
function run(end: string, n: number): string[] {
    const base = Date.parse(`${end}T00:00:00Z`);

    return Array.from({ length: n }, (_, i) =>
        new Date(base - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10)
    );
}

describe('earnedBadges — nothing unearned', () => {
    it('gives a brand new learner nothing', () => {
        expect(earnedBadges(inputs())).toEqual([]);
    });

    it('awards a tier only once its target is actually met', () => {
        const justUnder = earnedBadges(inputs({ maxStreak: 6, activeDates: run('2026-08-14', 6) }));
        const justOver = earnedBadges(inputs({ maxStreak: 7, activeDates: run('2026-08-14', 7) }));

        expect(justUnder.map((b) => b.id)).not.toContain('streak-7');
        expect(justOver.map((b) => b.id)).toContain('streak-7');
    });

    /**
     * The gate that matters most. Four right answers out of four is not accuracy, it is a small
     * sample — and a badge that can be won in a minute is a badge that means nothing.
     */
    it('refuses an accuracy badge on too little evidence', () => {
        const thin = earnedBadges(inputs({ totalAnswered: 4, accuracyPercent: 100 }));

        expect(thin.filter((b) => b.family === 'accuracy')).toEqual([]);
    });

    it('awards accuracy once there is enough behind it', () => {
        const solid = earnedBadges(inputs({ totalAnswered: 40, accuracyPercent: 88 }));
        const ids = solid.map((b) => b.id);

        expect(ids).toContain('accuracy-70');
        expect(ids).toContain('accuracy-85');
    });

    it('awards every lower tier along with the one just reached', () => {
        // Somebody arriving at 100 questions has passed 25 too. Showing only the highest would hide
        // the shelf they built.
        const ids = earnedBadges(inputs({ totalAnswered: 120 })).map((b) => b.id);

        expect(ids).toContain('volume-25');
        expect(ids).toContain('volume-100');
        expect(ids).not.toContain('volume-500');
    });

    it('describes the mastery bar as the same number the planner uses', () => {
        const badge = earnedBadges(inputs({ topicsMastered: 1 }))[0];

        // A learner must not be told a topic is mastered by one screen while another still schedules
        // fresh work on it.
        expect(MASTERY_BAR).toBe(85);
        expect(badge?.description).toContain('85');
    });

    it('is stable across repeated recomputes', () => {
        // No storage means this runs on every read; two reads a second apart must not differ.
        const state = inputs({
            maxStreak: 30,
            activeDates: run('2026-08-14', 30),
            totalAnswered: 300,
            topicsMastered: 6,
            accuracyPercent: 72,
            reviewsCompleted: 12,
        });

        expect(earnedBadges(state)).toEqual(earnedBadges(state));
    });

    it('puts the most recent badge first', () => {
        const badges = earnedBadges(
            inputs({ maxStreak: 30, activeDates: run('2026-08-14', 30), totalAnswered: 200 })
        );

        const dated = badges.filter((b) => b.earnedOn !== null);

        expect(dated.length).toBeGreaterThan(1);
        for (let i = 1; i < dated.length; i += 1) {
            expect(dated[i - 1]!.earnedOn! >= dated[i]!.earnedOn!).toBe(true);
        }
    });
});

describe('streakReachedOn', () => {
    it('returns the day the target was hit, not the day the run ended', () => {
        // A 30-day run contains the moment the 7-day badge was earned; that moment is day seven.
        const dates = run('2026-08-14', 30);

        expect(streakReachedOn(dates, 7)).toBe(dates[6]);
    });

    it('uses the earliest run that qualified', () => {
        const early = run('2026-03-10', 8);
        const late = run('2026-08-14', 20);

        expect(streakReachedOn([...early, ...late], 7)).toBe(early[6]);
    });

    it('does not count a run that spans a gap', () => {
        const broken = [...run('2026-07-01', 3), ...run('2026-07-20', 3)];

        expect(streakReachedOn(broken, 5)).toBe(null);
    });

    it('returns null rather than a guess when the run never happened', () => {
        expect(streakReachedOn(run('2026-08-14', 3), 30)).toBe(null);
        expect(streakReachedOn([], 3)).toBe(null);
    });

    it('does not care what order the dates arrive in', () => {
        const dates = run('2026-08-14', 10);
        const shuffled = [dates[5]!, dates[0]!, dates[9]!, ...dates.slice(1, 5), ...dates.slice(6, 9)];

        expect(streakReachedOn(shuffled, 7)).toBe(streakReachedOn(dates, 7));
    });
});

describe('nextBadges — the part that motivates', () => {
    it('offers a reachable first target to somebody with nothing', () => {
        const next = nextBadges(inputs());
        const streak = next.find((b) => b.family === 'streak');

        // Three days, not thirty. A ladder whose first rung is a month only rewards people who were
        // already going to persist.
        expect(streak?.target).toBe(3);
        expect(streak?.current).toBe(0);
    });

    it('moves to the next tier once one is passed', () => {
        const next = nextBadges(inputs({ maxStreak: 7, totalAnswered: 30 }));

        expect(next.find((b) => b.family === 'streak')?.target).toBe(30);
        expect(next.find((b) => b.family === 'volume')?.target).toBe(100);
    });

    it('puts the closest target first', () => {
        // The top of the list should be the one actually within reach, or the list is just a menu.
        const next = nextBadges(
            inputs({ maxStreak: 29, totalAnswered: 30, topicsMastered: 0 })
        );

        expect(next[0]?.family).toBe('streak');
    });

    it('drops a family that has nothing left to reach', () => {
        const next = nextBadges(
            inputs({ maxStreak: 500, activeDates: run('2026-08-14', 200) })
        );

        expect(next.find((b) => b.family === 'streak')).toBeUndefined();
    });

    it('never reports progress beyond its target', () => {
        for (const state of [
            inputs({ totalAnswered: 99 }),
            inputs({ maxStreak: 2 }),
            inputs({ totalAnswered: 40, accuracyPercent: 69 }),
        ]) {
            for (const progress of nextBadges(state)) {
                expect(progress.current).toBeLessThan(progress.target);
            }
        }
    });
});
