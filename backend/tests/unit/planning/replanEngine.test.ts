import { describe, expect, it } from 'vitest';
import {
    REPLAN_CONFIG,
    reconcileStatus,
    shouldReplan,
    type ReplanInputs,
    type SessionStatus,
} from '@/services/planning/replanEngine.js';

/**
 * Re-planning runs when the plan is read, which makes restraint the thing worth testing hardest.
 * A plan that rebuilds itself every time somebody looks at it is not adaptive — it moves work the
 * learner has not had a chance to do yet, and it does so most aggressively at exactly the moment
 * they are already behind and checking anxiously.
 *
 * So: what triggers a rebuild, and much more importantly, what must not.
 */

const TODAY = '2026-08-14';
const YESTERDAY_ISO = '2026-08-13T09:00:00.000Z';
const NOW_ISO = '2026-08-14T09:00:00.000Z';

function session(
    scheduledDate: string,
    status: SessionStatus,
    answered = 0
): ReplanInputs['pastSessions'][number] {
    return {
        scheduledDate,
        topicId: `topic-${scheduledDate}`,
        plannedQuestions: 5,
        questionsAnswered: answered,
        questionsCorrect: Math.floor(answered / 2),
        status,
    };
}

function inputs(overrides: Partial<ReplanInputs> = {}): ReplanInputs {
    return {
        today: TODAY,
        planCreatedAt: '2026-08-01T09:00:00.000Z',
        now: NOW_ISO,
        pastSessions: [],
        topics: [],
        ...overrides,
    };
}

describe('reconcileStatus', () => {
    it('calls a session with no answers missed', () => {
        expect(
            reconcileStatus({
                scheduledDate: TODAY,
                topicId: 't',
                plannedQuestions: 5,
                questionsAnswered: 0,
                questionsCorrect: 0,
            })
        ).toBe('missed');
    });

    it('calls a session that met its target completed', () => {
        expect(
            reconcileStatus({
                scheduledDate: TODAY,
                topicId: 't',
                plannedQuestions: 5,
                questionsAnswered: 5,
                questionsCorrect: 3,
            })
        ).toBe('completed');
    });

    it('counts answering more than asked as completed, not as an error', () => {
        expect(
            reconcileStatus({
                scheduledDate: TODAY,
                topicId: 't',
                plannedQuestions: 5,
                questionsAnswered: 9,
                questionsCorrect: 7,
            })
        ).toBe('completed');
    });

    /**
     * `partial` is the common case and it is not a failure. Somebody who answered three of five
     * turned up. Folding this into `missed` would fire rebuilds at people who are studying.
     */
    it('calls a session that was started but not finished partial', () => {
        expect(
            reconcileStatus({
                scheduledDate: TODAY,
                topicId: 't',
                plannedQuestions: 5,
                questionsAnswered: 3,
                questionsCorrect: 1,
            })
        ).toBe('partial');
    });
});

describe('shouldReplan — restraint', () => {
    it('does nothing when the plan is being followed', () => {
        const verdict = shouldReplan(
            inputs({
                pastSessions: [
                    session('2026-08-11', 'completed', 5),
                    session('2026-08-12', 'completed', 5),
                    session('2026-08-13', 'partial', 3),
                ],
            })
        );

        expect(verdict.replan).toBe(false);
        expect(verdict.reason).toBe(null);
    });

    /**
     * The most important test here. Re-planning triggers on read, so without the rate limit a
     * learner refreshing their plan five times produces five versions — each one reshuffling work
     * they have not had a chance to attempt.
     */
    it('refuses to rebuild a plan that was just built, however bad the signal', () => {
        const verdict = shouldReplan(
            inputs({
                planCreatedAt: NOW_ISO,
                pastSessions: [
                    session('2026-08-11', 'missed'),
                    session('2026-08-12', 'missed'),
                    session('2026-08-13', 'missed'),
                    session('2026-08-10', 'missed'),
                ],
                topics: [
                    {
                        topicId: 'a',
                        name: 'Arrays',
                        masteryScore: 12,
                        recentAccuracyPercent: 10,
                        recentAttempts: 10,
                    },
                    {
                        topicId: 'b',
                        name: 'Trees',
                        masteryScore: 15,
                        recentAccuracyPercent: 15,
                        recentAttempts: 8,
                    },
                ],
            })
        );

        expect(verdict.replan).toBe(false);
    });

    it('allows a rebuild once the previous plan is a day old', () => {
        const verdict = shouldReplan(
            inputs({
                planCreatedAt: YESTERDAY_ISO,
                pastSessions: [
                    session('2026-08-11', 'missed'),
                    session('2026-08-12', 'missed'),
                    session('2026-08-13', 'missed'),
                ],
            })
        );

        expect(verdict.replan).toBe(true);
    });

    it('does not rebuild for a single missed day', () => {
        // One missed session is a life, not a pattern. Rebuilding would move the remaining work
        // earlier and make the plan harder precisely when somebody is already behind.
        const verdict = shouldReplan(inputs({ pastSessions: [session('2026-08-13', 'missed')] }));

        expect(verdict.replan).toBe(false);
    });

    it('ignores sessions missed longer ago than the window', () => {
        const verdict = shouldReplan(
            inputs({
                pastSessions: [
                    session('2026-06-01', 'missed'),
                    session('2026-06-02', 'missed'),
                    session('2026-06-03', 'missed'),
                    session('2026-06-04', 'missed'),
                ],
            })
        );

        // Already accounted for by whatever plan came after them. Counting them forever would mean
        // one bad week in June rebuilds the plan every day until the exam.
        expect(verdict.replan).toBe(false);
    });

    it('does not rebuild over one struggling topic', () => {
        const verdict = shouldReplan(
            inputs({
                topics: [
                    {
                        topicId: 'a',
                        name: 'Arrays',
                        masteryScore: 12,
                        recentAccuracyPercent: 10,
                        recentAttempts: 10,
                    },
                ],
            })
        );

        // One hard topic is normal. The adaptive engine already drops its difficulty within the
        // session; the whole plan does not need rewriting for it.
        expect(verdict.replan).toBe(false);
    });

    it('does not treat a couple of wrong answers as a struggling topic', () => {
        const verdict = shouldReplan(
            inputs({
                topics: [
                    {
                        topicId: 'a',
                        name: 'Arrays',
                        masteryScore: 20,
                        recentAccuracyPercent: 0,
                        recentAttempts: 2,
                    },
                    {
                        topicId: 'b',
                        name: 'Trees',
                        masteryScore: 20,
                        recentAccuracyPercent: 0,
                        recentAttempts: 1,
                    },
                ],
            })
        );

        // Two answers is not evidence. Acting on it would rebuild the plan for anybody who opened a
        // new topic and got the first question wrong.
        expect(verdict.replan).toBe(false);
    });
});

describe('shouldReplan — acting when it should', () => {
    it('rebuilds after enough missed sessions, and says how many', () => {
        const verdict = shouldReplan(
            inputs({
                pastSessions: [
                    session('2026-08-11', 'missed'),
                    session('2026-08-12', 'missed'),
                    session('2026-08-13', 'missed'),
                    session('2026-08-10', 'completed', 5),
                ],
            })
        );

        expect(verdict.replan).toBe(true);
        expect(verdict.reason).toBe('missed_sessions');
        expect(verdict.explanation).toContain('3');
        // Framed as the plan adapting, not as the learner failing.
        expect(verdict.explanation).toMatch(/spread over the time you have left/i);
    });

    it('rebuilds when several topics are not improving, and names them', () => {
        const verdict = shouldReplan(
            inputs({
                topics: [
                    {
                        topicId: 'a',
                        name: 'Normalisation',
                        masteryScore: 16,
                        recentAccuracyPercent: 10,
                        recentAttempts: 12,
                    },
                    {
                        topicId: 'b',
                        name: 'Time Complexity',
                        masteryScore: 22,
                        recentAccuracyPercent: 25,
                        recentAttempts: 8,
                    },
                ],
            })
        );

        expect(verdict.replan).toBe(true);
        expect(verdict.reason).toBe('poor_performance');
        expect(verdict.explanation).toContain('Normalisation');
        expect(verdict.explanation).toContain('Time Complexity');
    });

    it('reports missed sessions ahead of poor performance when both are true', () => {
        const verdict = shouldReplan(
            inputs({
                pastSessions: [
                    session('2026-08-11', 'missed'),
                    session('2026-08-12', 'missed'),
                    session('2026-08-13', 'missed'),
                ],
                topics: [
                    {
                        topicId: 'a',
                        name: 'Arrays',
                        masteryScore: 12,
                        recentAccuracyPercent: 10,
                        recentAttempts: 10,
                    },
                    {
                        topicId: 'b',
                        name: 'Trees',
                        masteryScore: 15,
                        recentAccuracyPercent: 15,
                        recentAttempts: 8,
                    },
                ],
            })
        );

        // "You did not do this" is a fact; "this is not working" is an inference from a handful of
        // answers. The learner should be told the certain thing.
        expect(verdict.reason).toBe('missed_sessions');
    });

    it('never names more than three topics in one explanation', () => {
        const verdict = shouldReplan(
            inputs({
                topics: Array.from({ length: 8 }, (_, i) => ({
                    topicId: `t${i}`,
                    name: `Topic ${i}`,
                    masteryScore: 10,
                    recentAccuracyPercent: 10,
                    recentAttempts: 6,
                })),
            })
        );

        expect(verdict.replan).toBe(true);
        // A sentence listing eight topics is a sentence nobody finishes reading.
        expect(verdict.explanation.match(/Topic \d/g) ?? []).toHaveLength(3);
    });

    it('holds its thresholds where they can be argued with', () => {
        // These are opinions, not facts, and a viva question about them should land on a constant
        // rather than a number buried in a condition.
        expect(REPLAN_CONFIG.minMissedToReplan).toBe(3);
        expect(REPLAN_CONFIG.missedWindowDays).toBe(7);
        expect(REPLAN_CONFIG.minStrugglingTopics).toBe(2);
        expect(REPLAN_CONFIG.minHoursBetweenReplans).toBeLessThan(24);
    });
});
