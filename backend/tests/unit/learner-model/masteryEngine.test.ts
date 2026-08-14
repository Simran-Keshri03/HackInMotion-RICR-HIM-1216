import { describe, expect, it } from 'vitest';
import {
    type AttemptRecord,
    type TopicEvidence,
    computeMastery,
    summariseAttempts,
} from '@/services/learner/masteryEngine.js';

/**
 * These tests describe the behaviour we promise about mastery, not the exact numbers the
 * current weights happen to produce. Tuning the weights should not break them; changing
 * what mastery MEANS should.
 */

function evidence(overrides: Partial<TopicEvidence> = {}): TopicEvidence {
    return {
        totalAttempts: 0,
        correctAttempts: 0,
        recentAttempts: 0,
        recentCorrect: 0,
        easy: { attempts: 0, correct: 0 },
        medium: { attempts: 0, correct: 0 },
        hard: { attempts: 0, correct: 0 },
        correctStreak: 0,
        daysSinceLastAttempt: 0,
        ...overrides,
    };
}

/** A learner with `total` attempts, `correct` of them right, all at one difficulty. */
function solid(
    total: number,
    correct: number,
    difficulty: 'easy' | 'medium' | 'hard' = 'medium'
): TopicEvidence {
    return evidence({
        totalAttempts: total,
        correctAttempts: correct,
        recentAttempts: Math.min(total, 10),
        recentCorrect: Math.min(correct, 10),
        [difficulty]: { attempts: total, correct },
        correctStreak: correct === total ? Math.min(correct, 5) : 0,
    });
}

describe('computeMastery', () => {
    it('stays inside 0 to 100 at both extremes', () => {
        const perfect = computeMastery(solid(50, 50));
        const hopeless = computeMastery(solid(50, 0));

        expect(perfect.score).toBeLessThanOrEqual(100);
        expect(hopeless.score).toBeGreaterThanOrEqual(0);
        expect(perfect.score).toBeGreaterThan(hopeless.score);
    });

    it('does not treat three lucky answers as mastery', () => {
        const lucky = computeMastery(solid(3, 3));
        const proven = computeMastery(solid(40, 40));

        // Both are 100% accurate, so only the weight of evidence separates them.
        expect(lucky.score).toBeLessThan(proven.score);
        expect(lucky.score).toBeLessThan(75);
    });

    it('grows more confident as evidence accumulates', () => {
        const scores = [3, 10, 30, 80].map((n) => computeMastery(solid(n, n)).score);

        for (let i = 1; i < scores.length; i += 1) {
            expect(scores[i]!).toBeGreaterThan(scores[i - 1]!);
        }
    });

    it('rewards clearing hard questions over easy ones', () => {
        const easyOnly = computeMastery(solid(20, 20, 'easy'));
        const hardOnly = computeMastery(solid(20, 20, 'hard'));

        expect(hardOnly.score).toBeGreaterThan(easyOnly.score);
    });

    it('ignores a difficulty the learner has never attempted', () => {
        // Never trying a hard question must not look like failing every hard question.
        const untried = computeMastery(solid(20, 18, 'medium'));
        const failedHard = computeMastery(
            evidence({
                totalAttempts: 25,
                correctAttempts: 18,
                recentAttempts: 10,
                recentCorrect: 8,
                medium: { attempts: 20, correct: 18 },
                hard: { attempts: 5, correct: 0 },
            })
        );

        expect(untried.score).toBeGreaterThan(failedHard.score);
        expect(untried.breakdown.difficultyHandling).not.toBeNull();
    });

    it('weighs recent performance above old performance', () => {
        const base = {
            totalAttempts: 20,
            correctAttempts: 10,
            easy: { attempts: 0, correct: 0 },
            medium: { attempts: 20, correct: 10 },
            hard: { attempts: 0, correct: 0 },
        };

        const improving = computeMastery(
            evidence({ ...base, recentAttempts: 10, recentCorrect: 9 })
        );
        const slipping = computeMastery(
            evidence({ ...base, recentAttempts: 10, recentCorrect: 1 })
        );

        // Identical lifetime records, opposite recent form.
        expect(improving.score).toBeGreaterThan(slipping.score);
    });

    it('decays a topic left untouched, but never to nothing', () => {
        const fresh = computeMastery(solid(30, 27));
        const stale = computeMastery({
            ...solid(30, 27),
            daysSinceLastAttempt: 120,
        });

        expect(stale.score).toBeLessThan(fresh.score);
        // Decay is capped: a well-learned topic does not become unknown in a month.
        expect(stale.score).toBeGreaterThan(fresh.score * 0.8);
    });

    it('explains itself', () => {
        const { breakdown } = computeMastery(solid(20, 15));

        expect(breakdown.recentAccuracy).not.toBeNull();
        expect(breakdown.confidence).toBeGreaterThan(0);
        expect(breakdown.confidence).toBeLessThanOrEqual(1);
        expect(breakdown.decayFactor).toBeLessThanOrEqual(1);
    });
});

describe('summariseAttempts', () => {
    const now = new Date('2026-08-13T12:00:00Z');

    function attempt(
        isCorrect: boolean,
        difficulty: 'easy' | 'medium' | 'hard',
        daysAgo = 0
    ): AttemptRecord {
        return {
            isCorrect,
            difficulty,
            attemptedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
        };
    }

    it('returns empty evidence for a topic never attempted', () => {
        const result = summariseAttempts([], now);

        expect(result.totalAttempts).toBe(0);
        expect(result.daysSinceLastAttempt).toBeNull();
    });

    it('counts totals and fills the difficulty buckets', () => {
        const result = summariseAttempts(
            [
                attempt(true, 'hard'),
                attempt(false, 'medium'),
                attempt(true, 'easy'),
                attempt(true, 'easy'),
            ],
            now
        );

        expect(result.totalAttempts).toBe(4);
        expect(result.correctAttempts).toBe(3);
        expect(result.easy).toEqual({ attempts: 2, correct: 2 });
        expect(result.medium).toEqual({ attempts: 1, correct: 0 });
        expect(result.hard).toEqual({ attempts: 1, correct: 1 });
    });

    it('keeps the buckets adding up to the total, as the database demands', () => {
        const result = summariseAttempts(
            [attempt(true, 'easy'), attempt(false, 'hard'), attempt(true, 'medium')],
            now
        );

        expect(result.easy.attempts + result.medium.attempts + result.hard.attempts).toBe(
            result.totalAttempts
        );
    });

    it('counts the streak from the newest attempt and stops at the first miss', () => {
        const result = summariseAttempts(
            [
                attempt(true, 'medium'),
                attempt(true, 'medium'),
                attempt(false, 'medium'),
                attempt(true, 'medium'),
            ],
            now
        );

        expect(result.correctStreak).toBe(2);
    });

    it('limits the recent window and measures idle days from the newest attempt', () => {
        const attempts = [
            attempt(true, 'medium', 3),
            ...Array.from({ length: 14 }, () => attempt(false, 'medium', 20)),
        ];

        const result = summariseAttempts(attempts, now);

        expect(result.totalAttempts).toBe(15);
        expect(result.recentAttempts).toBe(10);
        expect(result.recentCorrect).toBe(1);
        expect(result.daysSinceLastAttempt).toBeCloseTo(3, 5);
    });
});
