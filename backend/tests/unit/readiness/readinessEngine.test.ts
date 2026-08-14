import { describe, expect, it } from 'vitest';
import {
    READINESS_CONFIG,
    type ReadinessInput,
    type ReadinessTopic,
    scoreReadiness,
} from '@/services/readiness/readinessEngine.js';

/**
 * A readiness score is a claim about the future, so the properties worth pinning are the ones that
 * would make it a dishonest claim: rewarding an untouched syllabus, punishing somebody for not
 * having sat a mock, or moving the number when nothing was learned.
 */

function topic(overrides: Partial<ReadinessTopic> = {}): ReadinessTopic {
    return {
        topicId: 't1',
        name: 'Topic',
        subjectName: 'Subject',
        weight: 1,
        masteryScore: 50,
        attempts: 10,
        ...overrides,
    };
}

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
    return {
        topics: [topic()],
        mocks: [],
        daysRemaining: 60,
        dailyMinutes: 60,
        ...overrides,
    };
}

/** `count` topics, all identical apart from the id. */
function topics(count: number, overrides: Partial<ReadinessTopic> = {}): ReadinessTopic[] {
    return Array.from({ length: count }, (_, i) =>
        topic({ topicId: `t${i}`, name: `Topic ${i}`, ...overrides })
    );
}

describe('scoreReadiness — an untouched syllabus is not half ready', () => {
    it('scores a learner who has done nothing near the floor', () => {
        // The planner gives an unmeasured topic a neutral prior. Readiness must not: silence is not
        // evidence, and a dashboard that says 50% to somebody who has not started is lying.
        const result = scoreReadiness(
            input({ topics: topics(10, { masteryScore: null, attempts: 0 }) })
        );

        expect(result.score).toBeLessThan(READINESS_CONFIG.buildingAt);
        expect(result.band).toBe('not_ready');
    });

    it('rates a measured-weak learner above an unmeasured one', () => {
        // Same syllabus, same effort budget. The only difference is whether anything was answered.
        const measured = scoreReadiness(
            input({ topics: topics(10, { masteryScore: 30, attempts: 12 }) })
        );
        const unmeasured = scoreReadiness(
            input({ topics: topics(10, { masteryScore: null, attempts: 0 }) })
        );

        expect(measured.score).toBeGreaterThan(unmeasured.score);
    });

    it('reaches the ready band for a learner at the mastery target', () => {
        const result = scoreReadiness(
            input({
                topics: topics(10, { masteryScore: READINESS_CONFIG.masteryTarget, attempts: 30 }),
                mocks: [{ scorePercent: 88, submittedAt: '2026-08-10T10:00:00Z' }],
            })
        );

        expect(result.band).toBe('ready');
        expect(result.score).toBeGreaterThanOrEqual(READINESS_CONFIG.readyAt);
    });
});

describe('scoreReadiness — components that cannot be measured are dropped, not zeroed', () => {
    it('does not punish a learner for never having sat a mock', () => {
        // Scoring an absent mock as zero would make avoiding the measurement the winning move.
        const noMock = scoreReadiness(
            input({ topics: topics(5, { masteryScore: 80, attempts: 40 }) })
        );
        const failedMock = scoreReadiness(
            input({
                topics: topics(5, { masteryScore: 80, attempts: 40 }),
                mocks: [{ scorePercent: 20, submittedAt: '2026-08-10T10:00:00Z' }],
            })
        );

        expect(noMock.score).toBeGreaterThan(failedMock.score);
        expect(noMock.components.some((c) => c.key === 'mock')).toBe(false);
    });

    it('always reports weights that add up to one', () => {
        // The total is out of 100 whether or not every component is present, so the surviving
        // weights have to be renormalised. If they are not, dropping a component silently deflates
        // the score.
        for (const candidate of [
            input({ mocks: [] }),
            input({ mocks: [{ scorePercent: 60, submittedAt: '2026-08-01T00:00:00Z' }] }),
            input({ daysRemaining: 0 }),
            input({ dailyMinutes: 0 }),
        ]) {
            const result = scoreReadiness(candidate);
            const total = result.components.reduce((sum, c) => sum + c.weight, 0);

            expect(total).toBeCloseTo(1, 2);
        }
    });

    it('drops the time component once the exam has arrived', () => {
        // Somebody sitting the exam tomorrow is as ready as their answers say. Time has stopped
        // being something they can change, so it should not drag the number down.
        const result = scoreReadiness(input({ daysRemaining: 0 }));

        expect(result.components.some((c) => c.key === 'time')).toBe(false);
    });

    it('counts only the most recent mocks', () => {
        const stale = Array.from({ length: 6 }, (_, i) => ({
            scorePercent: 10,
            submittedAt: `2026-07-0${i + 1}T00:00:00Z`,
        }));
        const fresh = [{ scorePercent: 90, submittedAt: '2026-08-11T00:00:00Z' }];

        const result = scoreReadiness(input({ mocks: [...stale, ...fresh] }));
        const mock = result.components.find((c) => c.key === 'mock')!;

        // Three-deep window, one of which is the 90. A six-week-old paper is not current form.
        expect(mock.score).toBeCloseTo((90 + 10 + 10) / 3, 1);
    });

    it('orders mocks itself rather than trusting the caller', () => {
        // "Recent" has to mean recent, not whatever order the database happened to return.
        const ascending = [
            { scorePercent: 10, submittedAt: '2026-06-01T00:00:00Z' },
            { scorePercent: 20, submittedAt: '2026-07-01T00:00:00Z' },
            { scorePercent: 90, submittedAt: '2026-08-01T00:00:00Z' },
            { scorePercent: 95, submittedAt: '2026-08-10T00:00:00Z' },
        ];

        const forwards = scoreReadiness(input({ mocks: ascending }));
        const backwards = scoreReadiness(input({ mocks: [...ascending].reverse() }));

        expect(forwards.score).toBe(backwards.score);
        expect(forwards.components.find((c) => c.key === 'mock')!.score).toBeCloseTo(
            (95 + 90 + 20) / 3,
            1
        );
    });
});

describe('scoreReadiness — coverage is a weaker claim than accuracy', () => {
    it('ranks a learner who answered everything well above one who touched everything once', () => {
        const shallow = scoreReadiness(
            input({ topics: topics(10, { masteryScore: 20, attempts: 1 }) })
        );
        const deep = scoreReadiness(
            input({ topics: topics(10, { masteryScore: 80, attempts: 25 }) })
        );

        expect(deep.score).toBeGreaterThan(shallow.score);
    });

    it('weights coverage by exam importance, not by topic count', () => {
        const heavyDone = scoreReadiness(
            input({
                topics: [
                    topic({ topicId: 'big', weight: 5, masteryScore: 70, attempts: 30 }),
                    topic({ topicId: 's1', weight: 0.5, masteryScore: null, attempts: 0 }),
                    topic({ topicId: 's2', weight: 0.5, masteryScore: null, attempts: 0 }),
                ],
            })
        );
        const heavyMissing = scoreReadiness(
            input({
                topics: [
                    topic({ topicId: 'big', weight: 5, masteryScore: null, attempts: 0 }),
                    topic({ topicId: 's1', weight: 0.5, masteryScore: 70, attempts: 15 }),
                    topic({ topicId: 's2', weight: 0.5, masteryScore: 70, attempts: 15 }),
                ],
            })
        );

        // Two topics done either way. Doing the one worth five times as much has to score higher.
        expect(heavyDone.score).toBeGreaterThan(heavyMissing.score);
    });
});

describe('scoreReadiness — gaps name what to do', () => {
    it('ranks the heaviest, weakest topic first', () => {
        const result = scoreReadiness(
            input({
                topics: [
                    topic({ topicId: 'a', name: 'Light and weak', weight: 0.5, masteryScore: 10 }),
                    topic({ topicId: 'b', name: 'Heavy and weak', weight: 3, masteryScore: 10 }),
                    topic({ topicId: 'c', name: 'Heavy and strong', weight: 3, masteryScore: 84 }),
                ],
            })
        );

        expect(result.gaps[0]!.name).toBe('Heavy and weak');
    });

    it('leaves out topics already at the target', () => {
        const result = scoreReadiness(
            input({
                topics: [
                    topic({ topicId: 'done', masteryScore: READINESS_CONFIG.masteryTarget }),
                    topic({ topicId: 'todo', name: 'Not done', masteryScore: 40 }),
                ],
            })
        );

        expect(result.gaps).toHaveLength(1);
        expect(result.gaps[0]!.name).toBe('Not done');
    });

    it('caps the list rather than listing the whole syllabus', () => {
        const result = scoreReadiness(input({ topics: topics(40, { masteryScore: 10 }) }));

        expect(result.gaps.length).toBeLessThanOrEqual(READINESS_CONFIG.maxGaps);
    });

    it('keeps measured weakness apart from what was never started', () => {
        // These are different kinds of claim. A measured gap is evidence; an untouched topic's cost
        // assumes a mastery of zero that was never checked. Ranked together the assumptions win,
        // because zero is further from the target than any real score — and since every untouched
        // topic of one exam weight then costs exactly the same, the order among them came down to
        // spelling. On a real 90-topic goal the list read as the alphabet rather than as a finding.
        const result = scoreReadiness(
            input({
                topics: [
                    topic({
                        topicId: 'a',
                        name: 'Alpha, untouched',
                        masteryScore: null,
                        attempts: 0,
                    }),
                    topic({
                        topicId: 'b',
                        name: 'Bravo, untouched',
                        masteryScore: null,
                        attempts: 0,
                    }),
                    topic({
                        topicId: 'z',
                        name: 'Zulu, measured badly',
                        masteryScore: 20,
                        attempts: 14,
                    }),
                ],
            })
        );

        expect(result.gaps.map((g) => g.name)).toEqual(['Zulu, measured badly']);
        expect(result.notStarted.map((g) => g.name)).toEqual([
            'Alpha, untouched',
            'Bravo, untouched',
        ]);
    });

    it('leaves a topic out of the measured list once it reaches the target', () => {
        const result = scoreReadiness(
            input({
                topics: [
                    topic({ topicId: 'done', masteryScore: 90, attempts: 30 }),
                    topic({ topicId: 'todo', name: 'Still short', masteryScore: 40, attempts: 12 }),
                ],
            })
        );

        expect(result.gaps.map((g) => g.name)).toEqual(['Still short']);
    });

    it('ranks what was never started by exam weight', () => {
        const result = scoreReadiness(
            input({
                topics: [
                    topic({
                        topicId: 'l',
                        name: 'Light',
                        weight: 0.5,
                        masteryScore: null,
                        attempts: 0,
                    }),
                    topic({
                        topicId: 'h',
                        name: 'Heavy',
                        weight: 4,
                        masteryScore: null,
                        attempts: 0,
                    }),
                ],
            })
        );

        expect(result.notStarted.map((g) => g.name)).toEqual(['Heavy', 'Light']);
    });

    it('breaks ties by name so the order is stable between reads', () => {
        // A list that reshuffles on refresh reads as the app changing its mind.
        const scope = [
            topic({ topicId: 'b', name: 'Beta', masteryScore: 40 }),
            topic({ topicId: 'a', name: 'Alpha', masteryScore: 40 }),
        ];

        expect(scoreReadiness(input({ topics: scope })).gaps.map((g) => g.name)).toEqual([
            'Alpha',
            'Beta',
        ]);
        expect(
            scoreReadiness(input({ topics: [...scope].reverse() })).gaps.map((g) => g.name)
        ).toEqual(['Alpha', 'Beta']);
    });
});

describe('scoreReadiness — confidence is a separate question from the score', () => {
    it('calls a score from a handful of answers low confidence', () => {
        const result = scoreReadiness(
            input({ topics: [topic({ masteryScore: 90, attempts: 3 })] })
        );

        expect(result.confidence).toBe('low');
        // And says so instead of leading with the number.
        expect(result.verdict).toMatch(/too early/i);
    });

    it('reaches high confidence only with a mock behind it', () => {
        const heavy = topics(10, { masteryScore: 80, attempts: 30 });

        expect(scoreReadiness(input({ topics: heavy })).confidence).toBe('medium');
        expect(
            scoreReadiness(
                input({
                    topics: heavy,
                    mocks: [{ scorePercent: 80, submittedAt: '2026-08-10T00:00:00Z' }],
                })
            ).confidence
        ).toBe('high');
    });
});

describe('scoreReadiness — it never invents a result', () => {
    it('handles an empty scope without producing a number to worry about', () => {
        const result = scoreReadiness(input({ topics: [], mocks: [] }));

        expect(result.score).toBe(0);
        expect(result.components).toEqual([]);
        expect(result.gaps).toEqual([]);
        expect(result.verdict).toMatch(/set a goal/i);
    });

    it('survives a syllabus with no weight at all', () => {
        const result = scoreReadiness(input({ topics: topics(3, { weight: 0 }) }));

        expect(Number.isFinite(result.score)).toBe(true);
        expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it('keeps the score inside 0-100 for absurd inputs', () => {
        const result = scoreReadiness(
            input({
                topics: topics(3, { masteryScore: 100, attempts: 9999 }),
                mocks: [{ scorePercent: 100, submittedAt: '2026-08-10T00:00:00Z' }],
                daysRemaining: 5000,
                dailyMinutes: 1440,
            })
        );

        expect(result.score).toBeLessThanOrEqual(100);
        expect(result.components.every((c) => c.score >= 0 && c.score <= 100)).toBe(true);
    });

    it('reports the counts it used, so the number can be checked', () => {
        const result = scoreReadiness(
            input({
                topics: [
                    topic({ topicId: 'a', masteryScore: 90, attempts: 20 }),
                    topic({ topicId: 'b', masteryScore: 40, attempts: 5 }),
                    topic({ topicId: 'c', masteryScore: null, attempts: 0 }),
                ],
                mocks: [{ scorePercent: 70, submittedAt: '2026-08-10T00:00:00Z' }],
            })
        );

        expect(result.topicsInScope).toBe(3);
        expect(result.topicsAttempted).toBe(2);
        expect(result.topicsMastered).toBe(1);
        expect(result.mocksTaken).toBe(1);
    });
});
