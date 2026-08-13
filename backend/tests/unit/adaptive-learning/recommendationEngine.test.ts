import { describe, expect, it } from 'vitest';
import { chooseDifficulty } from '@/services/adaptive/difficultyEngine.js';
import {
    type TopicCandidate,
    priorityScore,
    recommendNextAction,
} from '@/services/adaptive/recommendationEngine.js';

function topic(overrides: Partial<TopicCandidate> = {}): TopicCandidate {
    return {
        topicId: 't1',
        name: 'Topic',
        weight: 1,
        masteryScore: 50,
        recentAccuracy: 0.5,
        recentAttempts: 6,
        totalAttempts: 10,
        daysSinceLastAttempt: 1,
        ...overrides,
    };
}

function recommend(candidates: TopicCandidate[]) {
    return recommendNextAction({
        candidates,
        secondsPerQuestion: null,
        availableMinutes: null,
    });
}

describe('chooseDifficulty', () => {
    it('follows mastery when recent form says nothing unusual', () => {
        expect(
            chooseDifficulty({ masteryScore: 20, recentAccuracy: 0.5, recentAttempts: 6 })
                .difficulty
        ).toBe('easy');
        expect(
            chooseDifficulty({ masteryScore: 55, recentAccuracy: 0.5, recentAttempts: 6 })
                .difficulty
        ).toBe('medium');
        expect(
            chooseDifficulty({ masteryScore: 80, recentAccuracy: 0.5, recentAttempts: 6 })
                .difficulty
        ).toBe('hard');
    });

    it('steps back when recent answers are going badly, despite a healthy score', () => {
        const choice = chooseDifficulty({
            masteryScore: 85,
            recentAccuracy: 0.2,
            recentAttempts: 8,
        });

        expect(choice.difficulty).toBe('medium');
        expect(choice.reason).toMatch(/stepping back/i);
    });

    it('steps up when recent answers are almost all right', () => {
        const choice = chooseDifficulty({
            masteryScore: 45,
            recentAccuracy: 0.95,
            recentAttempts: 8,
        });

        expect(choice.difficulty).toBe('hard');
        expect(choice.reason).toMatch(/stepping up/i);
    });

    it('ignores recent form when there is barely any of it', () => {
        // One unlucky answer must not drop a learner off hard questions.
        expect(
            chooseDifficulty({ masteryScore: 85, recentAccuracy: 0, recentAttempts: 1 })
                .difficulty
        ).toBe('hard');
    });

    it('cannot step below easy or above hard', () => {
        expect(
            chooseDifficulty({ masteryScore: 5, recentAccuracy: 0, recentAttempts: 10 })
                .difficulty
        ).toBe('easy');
        expect(
            chooseDifficulty({ masteryScore: 99, recentAccuracy: 1, recentAttempts: 10 })
                .difficulty
        ).toBe('hard');
    });
});

describe('priorityScore', () => {
    it('ranks a weaker topic above a stronger one', () => {
        expect(priorityScore(topic({ masteryScore: 20 }))).toBeGreaterThan(
            priorityScore(topic({ masteryScore: 80 }))
        );
    });

    it('treats an unattempted topic as a full gap, not as fine', () => {
        const untouched = topic({
            masteryScore: null,
            totalAttempts: 0,
            daysSinceLastAttempt: null,
        });

        expect(priorityScore(untouched)).toBeGreaterThan(
            priorityScore(topic({ masteryScore: 30 }))
        );
    });

    it('ranks a stale topic above an identical fresh one', () => {
        expect(priorityScore(topic({ daysSinceLastAttempt: 30 }))).toBeGreaterThan(
            priorityScore(topic({ daysSinceLastAttempt: 0 }))
        );
    });

    it('lets exam weight break a tie between equally weak topics', () => {
        expect(priorityScore(topic({ weight: 2 }))).toBeGreaterThan(
            priorityScore(topic({ weight: 1 }))
        );
    });
});

describe('recommendNextAction', () => {
    it('returns nothing when there is nothing in scope', () => {
        expect(recommend([])).toBeNull();
    });

    it('picks the weakest important topic and explains itself', () => {
        const result = recommend([
            topic({ topicId: 'strong', name: 'Strong', masteryScore: 88 }),
            topic({ topicId: 'weak', name: 'Weak', masteryScore: 25, weight: 2 }),
        ]);

        expect(result?.topic.id).toBe('weak');
        expect(result?.reason).toContain('Weak');
        expect(result?.reason.length).toBeGreaterThan(20);
    });

    it('starts a never-attempted topic gently instead of testing it', () => {
        const result = recommend([
            topic({
                topicId: 'new',
                name: 'Brand New',
                masteryScore: null,
                totalAttempts: 0,
                recentAttempts: 0,
                recentAccuracy: null,
                daysSinceLastAttempt: null,
            }),
        ]);

        expect(result?.action).toBe('learn_new');
        expect(result?.difficulty).toBe('easy');
        expect(result?.questionCount).toBeLessThanOrEqual(3);
    });

    it('sends a solid but neglected topic to revision', () => {
        const result = recommend([
            topic({ masteryScore: 82, daysSinceLastAttempt: 21, recentAccuracy: 0.8 }),
        ]);

        expect(result?.action).toBe('revise');
        expect(result?.reason).toMatch(/days ago/i);
    });

    it('tests a solid, recently practised topic rather than drilling it again', () => {
        const result = recommend([
            topic({ masteryScore: 85, daysSinceLastAttempt: 1, recentAccuracy: 0.8 }),
        ]);

        expect(result?.action).toBe('mini_test');
    });

    it('offers runners-up so the learner is not forced into one choice', () => {
        // All four are unfinished, so all four compete and the ranking is by need.
        const result = recommend([
            topic({ topicId: 'a', name: 'A', masteryScore: 20 }),
            topic({ topicId: 'b', name: 'B', masteryScore: 30 }),
            topic({ topicId: 'c', name: 'C', masteryScore: 40 }),
            topic({ topicId: 'd', name: 'D', masteryScore: 45 }),
        ]);

        expect(result?.topic.id).toBe('a');
        expect(result?.alternatives).toHaveLength(2);
        expect(result?.alternatives.map((alt) => alt.topicId)).toEqual(['b', 'c']);
    });

    it('does not offer solid topics as alternatives while weak ones remain', () => {
        const result = recommend([
            topic({ topicId: 'weak', name: 'Weak', masteryScore: 20 }),
            topic({ topicId: 'solid', name: 'Solid', masteryScore: 80 }),
        ]);

        expect(result?.topic.id).toBe('weak');
        expect(result?.alternatives).toHaveLength(0);
    });

    it('shrinks the session to the time the learner actually has', () => {
        const full = recommendNextAction({
            candidates: [topic({ masteryScore: 30 })],
            secondsPerQuestion: 60,
            availableMinutes: null,
        });
        const rushed = recommendNextAction({
            candidates: [topic({ masteryScore: 30 })],
            secondsPerQuestion: 60,
            availableMinutes: 2,
        });

        expect(rushed!.questionCount).toBeLessThan(full!.questionCount);
        expect(rushed!.questionCount).toBe(2);
        expect(rushed!.estimatedMinutes).toBeLessThanOrEqual(2);
    });

    it('never recommends a session of zero questions', () => {
        const result = recommendNextAction({
            candidates: [topic()],
            secondsPerQuestion: 300,
            availableMinutes: 1,
        });

        expect(result!.questionCount).toBeGreaterThanOrEqual(1);
        expect(result!.estimatedMinutes).toBeGreaterThanOrEqual(2);
    });

    it('uses the learner own pace for the time estimate', () => {
        const fast = recommendNextAction({
            candidates: [topic({ masteryScore: 30 })],
            secondsPerQuestion: 30,
            availableMinutes: null,
        });
        const slow = recommendNextAction({
            candidates: [topic({ masteryScore: 30 })],
            secondsPerQuestion: 180,
            availableMinutes: null,
        });

        expect(slow!.estimatedMinutes).toBeGreaterThan(fast!.estimatedMinutes);
    });

    it('finishes a struggling topic before opening a new one', () => {
        // The behaviour a tutor would have: 1 out of 6 on Time Complexity is not a reason
        // to go and start something else.
        const result = recommend([
            topic({
                topicId: 'struggling',
                name: 'Time Complexity',
                masteryScore: 22,
                totalAttempts: 6,
                recentAttempts: 6,
                recentAccuracy: 0.17,
                daysSinceLastAttempt: 0,
            }),
            topic({
                topicId: 'fresh',
                name: 'SQL Queries',
                weight: 2,
                masteryScore: null,
                totalAttempts: 0,
                recentAttempts: 0,
                recentAccuracy: null,
                daysSinceLastAttempt: null,
            }),
        ]);

        expect(result?.topic.id).toBe('struggling');
        expect(result?.action).toBe('practice');
    });

    it('opens a new topic once everything already started is reasonable', () => {
        const result = recommend([
            topic({
                topicId: 'done-ish',
                name: 'Sorting',
                masteryScore: 64,
                totalAttempts: 12,
                daysSinceLastAttempt: 0,
            }),
            topic({
                topicId: 'fresh',
                name: 'SQL Queries',
                masteryScore: null,
                totalAttempts: 0,
                recentAttempts: 0,
                recentAccuracy: null,
                daysSinceLastAttempt: null,
            }),
        ]);

        expect(result?.topic.id).toBe('fresh');
        expect(result?.action).toBe('learn_new');
    });

    it('still works when nothing has been started at all', () => {
        const result = recommend([
            topic({
                topicId: 'a',
                name: 'A',
                weight: 1,
                masteryScore: null,
                totalAttempts: 0,
                recentAttempts: 0,
                recentAccuracy: null,
                daysSinceLastAttempt: null,
            }),
            topic({
                topicId: 'b',
                name: 'B',
                weight: 2,
                masteryScore: null,
                totalAttempts: 0,
                recentAttempts: 0,
                recentAccuracy: null,
                daysSinceLastAttempt: null,
            }),
        ]);

        // Nothing to finish, so exam weight decides where to start.
        expect(result?.topic.id).toBe('b');
    });

    it('gives the same answer for the same inputs, whatever order they arrive in', () => {
        const a = topic({ topicId: 'a', name: 'Alpha', masteryScore: 45 });
        const b = topic({ topicId: 'b', name: 'Beta', masteryScore: 45 });

        expect(recommend([a, b])?.topic.id).toBe(recommend([b, a])?.topic.id);
    });
});
