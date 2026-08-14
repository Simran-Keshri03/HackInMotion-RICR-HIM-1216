import { describe, expect, it } from 'vitest';
import {
    MOCK_TEST_CONFIG,
    type MockTestTopic,
    markMockTest,
    planMockTest,
    topicShare,
} from '@/services/assessment/mockTestEngine.js';

/**
 * Building a mock test, and marking it.
 *
 * The allocation is where this can quietly go wrong: a test that asks for fifteen questions and
 * serves nine, or spreads them one per topic, or picks a topic the bank cannot fill, all look fine on
 * a screen and make the breakdown meaningless. So the tests here are mostly arithmetic invariants —
 * the promises a test paper has to keep to be worth sitting.
 */

function topic(overrides: Partial<MockTestTopic> = {}): MockTestTopic {
    return {
        topicId: `t-${overrides.name ?? 'x'}`,
        name: 'Topic',
        subjectName: 'Subject',
        weight: 1,
        masteryScore: 50,
        plannedSessions: 1,
        availableQuestions: 20,
        ...overrides,
    };
}

const many = (n: number) =>
    Array.from({ length: n }, (_, i) =>
        topic({ name: `Topic ${i}`, topicId: `t-${i}` })
    );

describe('topicShare', () => {
    it('gives a weak topic more room than a strong one', () => {
        expect(topicShare(topic({ masteryScore: 15 }))).toBeGreaterThan(
            topicShare(topic({ masteryScore: 80 }))
        );
    });

    it('gives a heavily scheduled topic more room than a barely scheduled one', () => {
        // This is what makes it a test *of the plan* rather than of the syllabus.
        expect(topicShare(topic({ plannedSessions: 4 }))).toBeGreaterThan(
            topicShare(topic({ plannedSessions: 0 }))
        );
    });

    it('gives a heavier topic more room at equal mastery', () => {
        expect(topicShare(topic({ weight: 2 }))).toBeGreaterThan(
            topicShare(topic({ weight: 1 }))
        );
    });

    it('treats a topic never attempted as needing the most, not the least', () => {
        // null mastery is the absence of a measurement. Reading it as zero would be a measurement.
        expect(topicShare(topic({ masteryScore: null }))).toBeGreaterThan(
            topicShare(topic({ masteryScore: 60 }))
        );
    });
});

describe('planMockTest — the promises a paper must keep', () => {
    const topics = [
        topic({ name: 'Arrays', topicId: 't-a', masteryScore: 20, weight: 1.5 }),
        topic({ name: 'Trees', topicId: 't-b', masteryScore: 45 }),
        topic({ name: 'Sorting', topicId: 't-c', masteryScore: 75 }),
        topic({ name: 'Graphs', topicId: 't-d', masteryScore: null }),
    ];

    it('serves the number of questions it was asked for', () => {
        // A test that promises fifteen and serves nine makes every score incomparable with the last.
        const plan = planMockTest(topics, 15, 90);

        expect(plan.totalQuestions).toBe(15);
        expect(
            plan.allocations.reduce((sum, a) => sum + a.questionCount, 0)
        ).toBe(15);
    });

    it('never spreads the test so thin that a topic score means nothing', () => {
        const plan = planMockTest(topics, 15, 90);

        for (const allocation of plan.allocations) {
            expect(allocation.questionCount).toBeGreaterThanOrEqual(
                MOCK_TEST_CONFIG.minPerTopic
            );
        }
    });

    it('caps how many topics one sitting covers', () => {
        // Fifteen topics is one question each: a breakdown of pure noise.
        const plan = planMockTest(many(15), 20, 90);

        expect(plan.allocations.length).toBeLessThanOrEqual(MOCK_TEST_CONFIG.maxTopics);
    });

    it('gives the weakest topic more questions than the strongest', () => {
        const plan = planMockTest(topics, 20, 90);

        const arrays = plan.allocations.find((a) => a.name === 'Arrays');
        const sorting = plan.allocations.find((a) => a.name === 'Sorting');

        expect(arrays!.questionCount).toBeGreaterThan(sorting!.questionCount);
    });

    it('never asks a topic for more questions than the bank holds', () => {
        // Asking for eight from a topic with three would leave the test short at serve time, after the
        // learner had already been told how long it was.
        const thin = [
            topic({ name: 'Thin', topicId: 't-thin', availableQuestions: 3, masteryScore: 10 }),
            topic({ name: 'Deep', topicId: 't-deep', availableQuestions: 40 }),
        ];

        const plan = planMockTest(thin, 20, 90);

        for (const allocation of plan.allocations) {
            const source = thin.find((t) => t.topicId === allocation.topicId)!;
            expect(allocation.questionCount).toBeLessThanOrEqual(source.availableQuestions);
        }
    });

    it('returns a shorter test rather than a wrong one when the bank cannot fill it', () => {
        const plan = planMockTest(
            [topic({ name: 'Only', topicId: 't-o', availableQuestions: 4 })],
            20,
            90
        );

        expect(plan.totalQuestions).toBe(4);
        expect(plan.allocations).toHaveLength(1);
    });

    it('clamps a silly requested length instead of honouring it', () => {
        expect(planMockTest(topics, 500, 90).totalQuestions).toBeLessThanOrEqual(
            MOCK_TEST_CONFIG.maxQuestions
        );
        expect(planMockTest(topics, 1, 90).totalQuestions).toBeGreaterThanOrEqual(
            MOCK_TEST_CONFIG.minQuestions
        );
    });

    it('names every topic it could not include', () => {
        const mixed = [
            ...many(10),
            topic({ name: 'Empty', topicId: 't-empty', availableQuestions: 0 }),
        ];

        const plan = planMockTest(mixed, 15, 90);

        expect(plan.omitted.length).toBeGreaterThan(0);
        for (const omitted of plan.omitted) {
            expect(omitted.name).toBeTruthy();
            expect(omitted.reason.length).toBeGreaterThan(8);
        }
        // A breakdown missing the topic somebody most wanted to check reads as a bug, so the ones
        // with no questions are called out by name.
        expect(plan.omitted.some((o) => o.name === 'Empty')).toBe(true);
    });

    it('returns an empty plan when nothing can be tested', () => {
        expect(planMockTest([], 15, 90).allocations).toEqual([]);
        expect(
            planMockTest([topic({ availableQuestions: 0 })], 15, 90).allocations
        ).toEqual([]);
    });

    it('sets a duration from how fast the learner actually works', () => {
        const fast = planMockTest(topics, 15, 45);
        const slow = planMockTest(topics, 15, 200);

        expect(slow.durationMinutes).toBeGreaterThan(fast.durationMinutes);
        expect(fast.durationMinutes).toBeGreaterThan(0);
    });

    it('never sets a duration so tight that a diagnostic becomes a stress test', () => {
        // A measured 10 s/question came from practice, where the answer appears after each one. A test
        // has no such pause, so the pace is floored.
        const plan = planMockTest(topics, 15, 10);

        expect(plan.durationMinutes).toBeGreaterThanOrEqual(
            Math.round((15 * 45) / 60)
        );
    });

    it('explains every topic it chose', () => {
        for (const allocation of planMockTest(topics, 15, 90).allocations) {
            expect(allocation.reason).toContain(allocation.name);
            expect(allocation.reason.length).toBeGreaterThan(15);
        }
    });
});

describe('markMockTest', () => {
    const names = new Map([
        ['t-a', 'Arrays'],
        ['t-b', 'Trees'],
    ]);

    const q = (topicId: string, isCorrect: boolean, answered = true) => ({
        topicId,
        isCorrect,
        answered,
    });

    it('scores what was right out of what was asked', () => {
        const result = markMockTest(
            [q('t-a', true), q('t-a', true), q('t-b', false), q('t-b', false)],
            names
        );

        expect(result.correctCount).toBe(2);
        expect(result.totalQuestions).toBe(4);
        expect(result.scorePercent).toBe(50);
    });

    /**
     * A skipped question has to score zero, or leaving questions blank would raise the percentage —
     * which would make the best strategy answering only what you are sure of.
     */
    it('scores a skipped question as wrong, but reports it separately', () => {
        const result = markMockTest(
            [q('t-a', true), q('t-a', false, false), q('t-a', false, false)],
            names
        );

        expect(result.scorePercent).toBeCloseTo(33.3, 1);
        expect(result.answeredCount).toBe(1);
        expect(result.totalQuestions).toBe(3);
        // "33% having answered one of three" needs different advice from "33% having answered all".
        expect(result.verdict).toMatch(/blank/i);
    });

    it('breaks the score down by topic, weakest first', () => {
        const result = markMockTest(
            [
                q('t-a', true),
                q('t-a', true),
                q('t-b', false),
                q('t-b', false),
                q('t-b', true),
            ],
            names
        );

        // The list is meant to read as a to-do, so the top of it should be the thing to do first.
        expect(result.byTopic[0]!.topicId).toBe('t-b');
        expect(result.byTopic[0]!.percent).toBeCloseTo(33.3, 1);
        expect(result.byTopic[1]!.percent).toBe(100);
    });

    it('names the weakest topic in the verdict, so there is something to do next', () => {
        const result = markMockTest(
            [q('t-a', true), q('t-a', true), q('t-b', false), q('t-b', false)],
            names
        );

        expect(result.verdict).toContain('Trees');
    });

    it('says so plainly when the test went well', () => {
        const result = markMockTest([q('t-a', true), q('t-a', true)], names);

        expect(result.passed).toBe(true);
        expect(result.scorePercent).toBe(100);
        expect(result.verdict).toMatch(/strong/i);
    });

    it('reads nothing into a test that was not attempted', () => {
        const result = markMockTest(
            [q('t-a', false, false), q('t-a', false, false)],
            names
        );

        expect(result.scorePercent).toBe(0);
        expect(result.verdict).toMatch(/nothing/i);
    });

    it('does not fall over on an empty test', () => {
        const result = markMockTest([], names);

        expect(result.scorePercent).toBe(0);
        expect(result.byTopic).toEqual([]);
    });
});
