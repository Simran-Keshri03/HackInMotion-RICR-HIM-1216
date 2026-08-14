import { describe, expect, it } from 'vitest';
import {
    INVITE_CODE_LENGTH,
    type SharedProgress,
    makeInviteCode,
    normaliseInviteCode,
    rankMembers,
} from '@/services/groups/groupEngine.js';

/**
 * The group leaderboard, and the codes people type to join.
 *
 * The ranking rules are opinions with consequences — rank on the wrong number and the app starts
 * rewarding the wrong behaviour — so they are pinned here rather than left to be rediscovered.
 */

function member(overrides: Partial<SharedProgress> = {}): SharedProgress {
    return {
        userId: 'u1',
        displayName: 'Learner',
        questionsAnswered: 10,
        currentStreakDays: 1,
        topicsMastered: 0,
        isYou: false,
        ...overrides,
    };
}

describe('rankMembers', () => {
    it('ranks by questions answered, most first', () => {
        const comparison = rankMembers([
            member({ userId: 'a', displayName: 'Asha', questionsAnswered: 40 }),
            member({ userId: 'b', displayName: 'Bilal', questionsAnswered: 90 }),
            member({ userId: 'c', displayName: 'Chetan', questionsAnswered: 60 }),
        ]);

        expect(comparison.members.map((m) => m.displayName)).toEqual(['Bilal', 'Chetan', 'Asha']);
        expect(comparison.members.map((m) => m.rank)).toEqual([1, 2, 3]);
    });

    /**
     * Effort, not accuracy — and this is the test that stops somebody "improving" it later.
     *
     * Ranking on accuracy would reward answering only easy questions and punish the learner grinding
     * through the topic they find hardest, which is the exact behaviour the rest of the app exists to
     * encourage. Accuracy is not even in the shared type, so this asserts the ordering ignores it.
     */
    it('does not reward the learner who only answered easy questions', () => {
        const grinder = member({
            userId: 'a',
            displayName: 'Asha',
            questionsAnswered: 200,
            topicsMastered: 1,
        });
        const cherryPicker = member({
            userId: 'b',
            displayName: 'Bilal',
            questionsAnswered: 20,
            topicsMastered: 1,
        });

        const comparison = rankMembers([cherryPicker, grinder]);

        expect(comparison.members[0]!.displayName).toBe('Asha');
    });

    it('lets tied learners share a rank', () => {
        const comparison = rankMembers([
            member({ userId: 'a', displayName: 'Asha', questionsAnswered: 50 }),
            member({ userId: 'b', displayName: 'Bilal', questionsAnswered: 50 }),
            member({ userId: 'c', displayName: 'Chetan', questionsAnswered: 10 }),
        ]);

        // Inventing an order between identical numbers would be arbitrary, and on a screen people
        // compare themselves on it would be unkind for no reason.
        expect(comparison.members[0]!.rank).toBe(1);
        expect(comparison.members[1]!.rank).toBe(1);
        expect(comparison.members[2]!.rank).toBe(3);
    });

    it('orders identical members the same way on every read', () => {
        const people = [
            member({ userId: 'b', displayName: 'Bilal' }),
            member({ userId: 'a', displayName: 'Asha' }),
            member({ userId: 'c', displayName: 'Chetan' }),
        ];

        // A leaderboard that reshuffles between refreshes looks broken even when the numbers are
        // right, so the final tiebreak is the name rather than whatever the database returned.
        const first = rankMembers(people).members.map((m) => m.userId);
        const again = rankMembers([...people].reverse()).members.map((m) => m.userId);

        expect(first).toEqual(again);
    });

    it('reports where the reader sits', () => {
        const comparison = rankMembers([
            member({ userId: 'a', displayName: 'Asha', questionsAnswered: 90 }),
            member({ userId: 'b', displayName: 'You', questionsAnswered: 30, isYou: true }),
            member({ userId: 'c', displayName: 'Chetan', questionsAnswered: 60 }),
        ]);

        expect(comparison.yourRank).toBe(3);
        expect(comparison.memberCount).toBe(3);
    });

    it('has no rank for a reader who is not a member', () => {
        const comparison = rankMembers([member({ userId: 'a' })]);

        expect(comparison.yourRank).toBe(null);
    });

    it('adds up group totals, so the screen is collaborative and not only competitive', () => {
        const comparison = rankMembers([
            member({ userId: 'a', questionsAnswered: 40, topicsMastered: 2 }),
            member({ userId: 'b', questionsAnswered: 60, topicsMastered: 3 }),
        ]);

        expect(comparison.totals.questionsAnswered).toBe(100);
        expect(comparison.totals.topicsMastered).toBe(5);
    });

    it('names the longest current streak', () => {
        const comparison = rankMembers([
            member({ userId: 'a', displayName: 'Asha', currentStreakDays: 4 }),
            member({ userId: 'b', displayName: 'Bilal', currentStreakDays: 12 }),
        ]);

        expect(comparison.topStreak).toEqual({ displayName: 'Bilal', days: 12 });
    });

    it('reports no top streak when nobody has one going', () => {
        const comparison = rankMembers([
            member({ userId: 'a', currentStreakDays: 0 }),
            member({ userId: 'b', currentStreakDays: 0 }),
        ]);

        // Naming somebody as the streak leader on zero days would be a lie dressed as encouragement.
        expect(comparison.topStreak).toBe(null);
    });

    it('handles an empty group without inventing anything', () => {
        const comparison = rankMembers([]);

        expect(comparison.members).toEqual([]);
        expect(comparison.memberCount).toBe(0);
        expect(comparison.yourRank).toBe(null);
        expect(comparison.topStreak).toBe(null);
        expect(comparison.totals.questionsAnswered).toBe(0);
    });
});

describe('makeInviteCode', () => {
    /** Bytes 0,1,2,... so the mapping is checkable rather than merely plausible. */
    function sequential(): (n: number) => Uint8Array {
        let next = 0;
        return (n) => Uint8Array.from({ length: n }, () => next++);
    }

    it('produces a code the database constraint accepts', () => {
        // The column CHECK is ^[A-HJ-NP-Z2-9]{6}$; a generator that can produce anything else would
        // fail the insert rather than merely look wrong.
        for (let i = 0; i < 40; i += 1) {
            const code = makeInviteCode((n) =>
                Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256))
            );

            expect(code).toHaveLength(INVITE_CODE_LENGTH);
            expect(code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
        }
    });

    it('never emits a character somebody could misread', () => {
        // No O/0, I/1 or L. These codes are read aloud across a room; an ambiguous character means a
        // learner who cannot join and has no idea why.
        for (let i = 0; i < 60; i += 1) {
            const code = makeInviteCode((n) =>
                Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256))
            );

            expect(code).not.toMatch(/[O0I1L]/);
        }
    });

    it('is deterministic for a given byte stream', () => {
        expect(makeInviteCode(sequential())).toBe(makeInviteCode(sequential()));
    });

    it('rejects biased bytes rather than folding them in', () => {
        // 248 and above would skew the first symbols of a 31-letter alphabet if taken modulo. Feeding
        // only those forces every byte to be rejected on the first pass, so the loop must ask again
        // instead of hanging or emitting nothing.
        let calls = 0;
        const code = makeInviteCode((n) => {
            calls += 1;
            return Uint8Array.from({ length: n }, () => (calls > 3 ? 5 : 250));
        });

        expect(code).toHaveLength(INVITE_CODE_LENGTH);
        expect(calls).toBeGreaterThan(1);
    });
});

describe('normaliseInviteCode', () => {
    it('accepts what people actually type', () => {
        expect(normaliseInviteCode('  a b7k2m9 ')).toBe('AB7K2M9');
        expect(normaliseInviteCode('xk4p2q')).toBe('XK4P2Q');
    });
});
