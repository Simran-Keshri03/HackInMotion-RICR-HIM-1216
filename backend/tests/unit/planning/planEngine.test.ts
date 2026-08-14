import { describe, expect, it } from 'vitest';
import {
    PLAN_CONFIG,
    addDays,
    buildPlan,
    topicNeed,
    type PlanTopic,
} from '@/services/planning/planEngine.js';

/**
 * A plan is a promise about somebody's remaining time before an exam, so the things worth testing
 * are the ones that would make it a lie: a day holding more minutes than the learner has, a
 * session too short to teach anything, work scheduled after the exam, or a weak topic quietly
 * getting less time than a strong one.
 *
 * The engine is pure, so all of this runs without a database.
 */

function topic(overrides: Partial<PlanTopic> = {}): PlanTopic {
    return {
        topicId: `t-${Math.abs(hash(overrides.name ?? 'Topic'))}`,
        name: 'Topic',
        subjectName: 'Subject',
        weight: 1,
        masteryScore: 50,
        attempts: 5,
        ...overrides,
    };
}

/** Stable ids without Math.random, so a failing test fails the same way twice. */
function hash(text: string): number {
    let value = 0;
    for (const char of text) value = (value * 31 + char.charCodeAt(0)) | 0;
    return value;
}

const base = {
    startDate: '2026-08-14',
    daysRemaining: 30,
    dailyMinutes: 60,
    secondsPerQuestion: 90,
};

describe('addDays', () => {
    it('crosses month and year boundaries correctly', () => {
        expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
        expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
        expect(addDays('2026-08-14', 0)).toBe('2026-08-14');
    });
});

describe('topicNeed', () => {
    it('ranks a weak topic above a strong one', () => {
        expect(topicNeed(topic({ masteryScore: 10 }))).toBeGreaterThan(
            topicNeed(topic({ masteryScore: 70 }))
        );
    });

    it('ranks a heavier topic above a lighter one at the same mastery', () => {
        expect(topicNeed(topic({ masteryScore: 50, weight: 2 }))).toBeGreaterThan(
            topicNeed(topic({ masteryScore: 50, weight: 1 }))
        );
    });

    it('treats a topic never attempted as needing the most, not the least', () => {
        // null mastery is the absence of a measurement, not a measurement of zero. Getting this
        // backwards would make the plan skip everything the learner has not started.
        const untouched = topicNeed(topic({ masteryScore: null, attempts: 0 }));

        expect(untouched).toBeGreaterThan(topicNeed(topic({ masteryScore: 40 })));
    });

    /**
     * The inversion the diagnostic assessment exposed, and the reason `unknownMastery` exists.
     *
     * `masteryScore ?? 0` stood in for "unknown" and quietly meant "the worst possible", so a topic the
     * learner had just been measured as weak at ranked *below* one nobody had ever asked about.
     * Observed live: answering a diagnostic question wrong moved that topic from 105 planned minutes to
     * 75, while an unmeasured topic held the top slot at 150. That is the opposite of prioritising weak
     * areas, which is the one thing the plan exists to do.
     */
    it('ranks a topic measured as weak above one never measured at all', () => {
        const measuredWeak = topicNeed(topic({ masteryScore: 29, attempts: 1 }));
        const neverMeasured = topicNeed(topic({ masteryScore: null, attempts: 0 }));

        expect(measuredWeak).toBeGreaterThan(neverMeasured);
    });

    it('ranks a topic never measured above one measured as solid', () => {
        // Not knowing belongs between the two things you can know.
        const neverMeasured = topicNeed(topic({ masteryScore: null, attempts: 0 }));
        const measuredStrong = topicNeed(topic({ masteryScore: 78, attempts: 6 }));

        expect(neverMeasured).toBeGreaterThan(measuredStrong);
    });

    it('still gives a mastered topic something, so it is not abandoned', () => {
        // Nobody should walk into an exam having forgotten what they knew a month ago.
        expect(topicNeed(topic({ masteryScore: 100 }))).toBeGreaterThan(0);
    });
});

describe('buildPlan — the promises it must not break', () => {
    const topics = [
        topic({ name: 'Arrays', masteryScore: 10, attempts: 3, weight: 1.5 }),
        topic({ name: 'Trees', masteryScore: 35, attempts: 8, weight: 1.2 }),
        topic({ name: 'Sorting', masteryScore: 70, attempts: 12, weight: 1 }),
        topic({ name: 'Graphs', masteryScore: null, attempts: 0, weight: 1.3 }),
    ];

    it('never schedules a day beyond the learner\'s daily minutes', () => {
        const plan = buildPlan({ ...base, topics });

        const perDay = new Map<string, number>();
        for (const session of plan.sessions) {
            perDay.set(
                session.scheduledDate,
                (perDay.get(session.scheduledDate) ?? 0) + session.plannedMinutes
            );
        }

        for (const [date, minutes] of perDay) {
            expect(minutes, `${date} is overbooked`).toBeLessThanOrEqual(base.dailyMinutes);
        }
    });

    it('never schedules a session too short to be worth doing', () => {
        const plan = buildPlan({ ...base, topics });

        for (const session of plan.sessions) {
            expect(session.plannedMinutes).toBeGreaterThanOrEqual(
                PLAN_CONFIG.minSessionMinutes
            );
        }
    });

    it('never schedules anything on or after the exam', () => {
        const plan = buildPlan({ ...base, daysRemaining: 10, topics });
        const lastAllowed = addDays(base.startDate, 9);

        for (const session of plan.sessions) {
            expect(session.scheduledDate <= lastAllowed).toBe(true);
        }
    });

    it('never puts more topics in one day than a day can hold', () => {
        // A long day should mean longer sessions, not a list of eight topics.
        const plan = buildPlan({ ...base, dailyMinutes: 480, topics });

        const perDay = new Map<string, number>();
        for (const session of plan.sessions) {
            perDay.set(
                session.scheduledDate,
                (perDay.get(session.scheduledDate) ?? 0) + 1
            );
        }

        for (const count of perDay.values()) {
            expect(count).toBeLessThanOrEqual(PLAN_CONFIG.maxTopicsPerDay);
        }
    });

    it('gives the weakest topic more total time than the strongest', () => {
        const plan = buildPlan({ ...base, topics });

        const byTopic = new Map<string, number>();
        for (const session of plan.sessions) {
            byTopic.set(
                session.topicName,
                (byTopic.get(session.topicName) ?? 0) + session.plannedMinutes
            );
        }

        expect(byTopic.get('Arrays') ?? 0).toBeGreaterThan(byTopic.get('Sorting') ?? 0);
    });

    it('spreads topics across the first days instead of finishing one at a time', () => {
        const plan = buildPlan({ ...base, topics });

        const firstThreeDays = new Set(
            plan.sessions
                .filter((session) => session.scheduledDate <= addDays(base.startDate, 2))
                .map((session) => session.topicName)
        );

        // A learner should have met most of their plan in the first few days.
        expect(firstThreeDays.size).toBeGreaterThan(1);
    });

    it('explains every session in words', () => {
        const plan = buildPlan({ ...base, topics });

        for (const session of plan.sessions) {
            expect(session.reason.length).toBeGreaterThan(10);
            expect(session.reason).toContain(session.topicName);
        }
    });

    it('estimates question counts from how fast the learner actually works', () => {
        const fast = buildPlan({ ...base, topics, secondsPerQuestion: 30 });
        const slow = buildPlan({ ...base, topics, secondsPerQuestion: 180 });

        const total = (plan: { sessions: { plannedQuestions: number }[] }) =>
            plan.sessions.reduce((sum, s) => sum + s.plannedQuestions, 0);

        // Same minutes, more questions for the faster learner. Otherwise a plan promising
        // "20 minutes, 12 questions" is wrong for everybody who is not average.
        expect(total(fast)).toBeGreaterThan(total(slow));
    });

    it('always asks for at least one question per session', () => {
        const plan = buildPlan({ ...base, topics, secondsPerQuestion: 3600 });

        for (const session of plan.sessions) {
            expect(session.plannedQuestions).toBeGreaterThanOrEqual(1);
        }
    });
});

describe('buildPlan — revision slots', () => {
    const learn = [
        topic({ name: 'Arrays', masteryScore: 10 }),
        topic({ name: 'Trees', masteryScore: 40 }),
    ];

    const due = [
        {
            topicId: 'r1',
            name: 'Normalisation',
            subjectName: 'Databases',
            dueOn: '2026-08-10',
            lapses: 0,
            lastReviewAccuracy: 85,
        },
        {
            topicId: 'r2',
            name: 'Time Complexity',
            subjectName: 'Algorithms',
            dueOn: '2026-08-12',
            lapses: 2,
            lastReviewAccuracy: 40,
        },
    ];

    it('schedules due revisions on the earliest days', () => {
        const plan = buildPlan({ ...base, topics: learn, dueRevisions: due });

        const revisions = plan.sessions.filter((s) => s.kind === 'revise');

        expect(revisions).toHaveLength(2);
        // A topic past its due date is being actively forgotten, so it cannot wait behind three
        // weeks of new learning.
        for (const session of revisions) {
            expect(session.scheduledDate <= addDays(base.startDate, 1)).toBe(true);
        }
    });

    /**
     * The layout fills each day to capacity, so anything not reserved before the learning pass is
     * crowded out entirely — a backlog of overdue topics would never appear in a plan at all, which
     * is the failure spaced repetition exists to prevent.
     */
    it('does not let revision push a day past the learner\'s daily minutes', () => {
        const plan = buildPlan({ ...base, topics: learn, dueRevisions: due });

        const perDay = new Map<string, number>();
        for (const session of plan.sessions) {
            perDay.set(
                session.scheduledDate,
                (perDay.get(session.scheduledDate) ?? 0) + session.plannedMinutes
            );
        }

        for (const [date, minutes] of perDay) {
            expect(minutes, `${date} is overbooked`).toBeLessThanOrEqual(base.dailyMinutes);
        }
    });

    it('still leaves room for new learning on a revision day', () => {
        const plan = buildPlan({ ...base, topics: learn, dueRevisions: due });

        const firstDay = plan.sessions.filter(
            (s) => s.scheduledDate === base.startDate
        );

        // A plan showing nothing but revision does not move the learner forward, and the exam is not
        // made only of things they have already seen.
        expect(firstDay.some((s) => s.kind === 'learn')).toBe(true);
    });

    it('spreads a large backlog over days instead of stacking one impossible day', () => {
        const backlog = Array.from({ length: 12 }, (_, i) => ({
            topicId: `r${i}`,
            name: `Old Topic ${i}`,
            subjectName: null,
            dueOn: '2026-08-01',
            lapses: 0,
            lastReviewAccuracy: 70,
        }));

        const plan = buildPlan({ ...base, topics: learn, dueRevisions: backlog });

        const days = new Set(
            plan.sessions.filter((s) => s.kind === 'revise').map((s) => s.scheduledDate)
        );

        expect(days.size).toBeGreaterThan(1);
    });

    it('explains a revision, and says when a topic keeps slipping', () => {
        const plan = buildPlan({ ...base, topics: learn, dueRevisions: due });

        const slipping = plan.sessions.find((s) => s.topicName === 'Time Complexity');

        expect(slipping?.reason).toContain('slipped');
        expect(slipping?.reason).toContain('2');
    });

    /**
     * Found by generating a plan against real due topics, not by a unit test — the tests all had
     * disjoint learn and revision lists, so none of them hit it.
     *
     * A topic due for revision is also in the goal's scope, so the learning pass scheduled it a second
     * time on the same day. `study_sessions_unique_slot` is unique on (plan, date, topic), so the
     * entire plan insert failed with a duplicate-key error and the learner got "Something went
     * wrong".
     */
    it('never schedules the same topic twice on one day', () => {
        const shared = topic({ name: 'Normalisation', masteryScore: 30 });

        const plan = buildPlan({
            ...base,
            topics: [shared, topic({ name: 'Trees', masteryScore: 40 })],
            dueRevisions: [
                {
                    topicId: shared.topicId,
                    name: shared.name,
                    subjectName: 'Databases',
                    dueOn: '2026-08-10',
                    lapses: 1,
                    lastReviewAccuracy: 45,
                },
            ],
        });

        const slots = plan.sessions.map((s) => `${s.scheduledDate}|${s.topicId}`);

        expect(new Set(slots).size).toBe(slots.length);
    });

    it('still gives a revised topic its learning time, on another day', () => {
        const shared = topic({ name: 'Normalisation', masteryScore: 20 });

        const plan = buildPlan({
            ...base,
            topics: [shared, topic({ name: 'Trees', masteryScore: 40 })],
            dueRevisions: [
                {
                    topicId: shared.topicId,
                    name: shared.name,
                    subjectName: 'Databases',
                    dueOn: '2026-08-10',
                    lapses: 0,
                    lastReviewAccuracy: 70,
                },
            ],
        });

        // The clash is resolved by moving the learning session, not by dropping it — a weak topic
        // must not lose its allocation for having also been due.
        const learning = plan.sessions.filter(
            (s) => s.topicId === shared.topicId && s.kind === 'learn'
        );

        expect(learning.length).toBeGreaterThan(0);
    });

    it('plans normally when nothing is due', () => {
        const plan = buildPlan({ ...base, topics: learn });

        expect(plan.sessions.every((s) => s.kind === 'learn')).toBe(true);
        expect(plan.sessions.length).toBeGreaterThan(0);
    });
});

describe('buildPlan — honesty when it does not fit', () => {
    it('drops topics it cannot give a useful amount of time, and says which', () => {
        // Twenty topics, one day, one hour. Four fit properly; the rest cannot.
        const many = Array.from({ length: 20 }, (_, i) =>
            topic({ name: `Topic ${i}`, masteryScore: 20 })
        );

        const plan = buildPlan({ ...base, daysRemaining: 1, topics: many });

        expect(plan.sessions.length).toBeLessThanOrEqual(PLAN_CONFIG.maxTopicsPerDay);
        expect(plan.omittedTopics.length).toBeGreaterThan(0);

        // Named, not silently missing. A plan that quietly drops sixteen topics reads as
        // complete and is not.
        for (const omitted of plan.omittedTopics) {
            expect(omitted.name).toBeTruthy();
            expect(omitted.reason.length).toBeGreaterThan(10);
        }
    });

    /**
     * The bug this exists for was found by generating a plan for a real goal, not by reading code.
     *
     * `learning_goals` allows a daily budget as low as ten minutes, and the planner's session floor
     * was a fixed fifteen. Every day was rejected as too short to hold a session, so the learner got
     * an empty plan and the message "there is not enough time before the exam" — while having a
     * hundred and eighty days. Somebody who says ten minutes a day means it.
     */
    it('plans for a learner whose whole day is shorter than the usual session floor', () => {
        const plan = buildPlan({
            ...base,
            dailyMinutes: 10,
            daysRemaining: 180,
            topics: [
                topic({ name: 'Arrays', masteryScore: null, attempts: 0 }),
                topic({ name: 'Trees', masteryScore: 30 }),
            ],
        });

        expect(plan.sessions.length).toBeGreaterThan(0);

        for (const session of plan.sessions) {
            // Their day, respected: never longer than they said they had.
            expect(session.plannedMinutes).toBeLessThanOrEqual(10);
            expect(session.plannedMinutes).toBeGreaterThan(0);
            expect(session.plannedQuestions).toBeGreaterThanOrEqual(1);
        }
    });

    /**
     * A second bug from the same generated plan. Once a short day can only hold one topic, the
     * round-robin gave that slot to the same queue every day until it was empty — four days, one
     * topic, and on the real goal twenty-five days before the second topic appeared.
     *
     * The session cap cannot help here: at ten minutes a day there is no room to split. Only the
     * order can change, so it rotates.
     */
    it('rotates which topic comes first when a day only fits one', () => {
        const names = ['Arrays', 'Trees', 'Graphs', 'Sorting', 'Hashing'];

        const plan = buildPlan({
            ...base,
            dailyMinutes: 10,
            daysRemaining: 60,
            topics: names.map((name) => topic({ name, masteryScore: 20 })),
        });

        const firstWeek = new Set(
            plan.sessions
                .filter((session) => session.scheduledDate <= addDays(base.startDate, 6))
                .map((session) => session.topicName)
        );

        // A learner should have met most of their plan in week one, not in week four.
        expect(firstWeek.size).toBeGreaterThanOrEqual(names.length - 1);
    });

    it('returns an empty plan for an exam that has already passed', () => {
        const plan = buildPlan({ ...base, daysRemaining: 0, topics: [topic()] });

        expect(plan.sessions).toEqual([]);
        expect(plan.totalMinutesPlanned).toBe(0);
    });

    it('returns an empty plan when the goal has no topics in scope', () => {
        const plan = buildPlan({ ...base, topics: [] });

        expect(plan.sessions).toEqual([]);
        expect(plan.topicsCovered).toBe(0);
    });

    it('reports totals that match the sessions it produced', () => {
        const plan = buildPlan({
            ...base,
            topics: [
                topic({ name: 'Arrays', masteryScore: 10 }),
                topic({ name: 'Trees', masteryScore: 60 }),
            ],
        });

        const summed = plan.sessions.reduce((sum, s) => sum + s.plannedMinutes, 0);

        expect(plan.totalMinutesPlanned).toBe(summed);
        expect(plan.topicsCovered).toBe(
            new Set(plan.sessions.map((s) => s.topicId)).size
        );
        // The plan cannot promise more time than the learner said they had.
        expect(plan.totalMinutesPlanned).toBeLessThanOrEqual(
            base.daysRemaining * base.dailyMinutes
        );
    });
});
