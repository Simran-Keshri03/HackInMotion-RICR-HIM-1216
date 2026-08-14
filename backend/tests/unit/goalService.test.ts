import { describe, expect, it, vi } from 'vitest';
import type { GoalRepository } from '@/repositories/goalRepository.js';
import { GoalService, daysUntil } from '@/services/learning/goalService.js';

/**
 * The validation here is the kind a CHECK constraint cannot express, so it has to be tested
 * where it lives. A stub repository stands in for the database: none of these rules need one,
 * and a test that needs a database is a test nobody runs.
 */

function isoDaysFromNow(days: number): string {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function serviceWithStub() {
    const replaceActive = vi.fn(
        async (
            _userId: string,
            goal: {
                title: string;
                examDate: string;
                dailyMinutes: number;
                subjectIds: string[];
                curriculumId: string;
            }
        ) => ({
            id: 'goal-1',
            title: goal.title,
            exam_date: goal.examDate,
            daily_minutes: goal.dailyMinutes,
            status: 'active' as const,
            created_at: new Date().toISOString(),
            curriculum_id: goal.curriculumId,
        })
    );

    const repo = {
        findSubjects: vi.fn(async (_curriculumId: string) => []),
        findActive: vi.fn(async () => null),
        findScope: vi.fn(async () => []),
        replaceActive,
    } as unknown as GoalRepository;

    return { service: new GoalService(repo), replaceActive };
}

const validGoal = {
    userId: 'user-1',
    curriculumId: '22222222-2222-4222-8222-222222222222',
    title: 'GATE CS 2027',
    examDate: isoDaysFromNow(60),
    dailyMinutes: 90,
    subjectIds: ['11111111-1111-4111-8111-111111111111'],
};

describe('daysUntil', () => {
    it('counts whole days ahead', () => {
        expect(daysUntil(isoDaysFromNow(30))).toBe(30);
        expect(daysUntil(isoDaysFromNow(1))).toBe(1);
    });

    it('returns zero for today and negative for a past date', () => {
        expect(daysUntil(isoDaysFromNow(0))).toBe(0);
        expect(daysUntil(isoDaysFromNow(-5))).toBe(-5);
    });

    it('is not thrown off by the time of day', () => {
        // Counted in UTC on both sides, so the answer is a clean multiple of a day. Comparing a
        // local timestamp against a date string is how "1 day left" becomes "0 days left" for
        // anyone east of UTC late in the evening.
        expect(Number.isInteger(daysUntil(isoDaysFromNow(7)))).toBe(true);
    });

    it('reports a nonsense date rather than guessing', () => {
        expect(daysUntil('not-a-date')).toBeNaN();
        expect(daysUntil('2026-13-45')).toBeNaN();
    });
});

describe('GoalService.create', () => {
    it('accepts a sensible goal and reports the study budget', async () => {
        const { service } = serviceWithStub();

        const goal = await service.create(validGoal);

        expect(goal.daysRemaining).toBe(60);
        // The number the planner will divide work by, and the number the learner sees before
        // committing to a daily target.
        expect(goal.totalMinutesAvailable).toBe(60 * 90);
        expect(goal.subjectIds).toHaveLength(1);
    });

    it('refuses an exam date in the past', async () => {
        const { service } = serviceWithStub();

        await expect(
            service.create({ ...validGoal, examDate: isoDaysFromNow(-1) })
        ).rejects.toThrowError(/must be in the future/i);
    });

    it('refuses today, because there is nothing left to plan', async () => {
        const { service } = serviceWithStub();

        await expect(
            service.create({ ...validGoal, examDate: isoDaysFromNow(0) })
        ).rejects.toThrowError(/must be in the future/i);
    });

    it('refuses a date so far out that a daily plan is meaningless', async () => {
        const { service } = serviceWithStub();

        await expect(
            service.create({ ...validGoal, examDate: isoDaysFromNow(900) })
        ).rejects.toThrowError(/two years/i);
    });

    it('refuses a date that is not a date', async () => {
        const { service } = serviceWithStub();

        await expect(service.create({ ...validGoal, examDate: '2026-99-99' })).rejects.toThrowError(
            /not a real date/i
        );
    });

    it('refuses a goal with no subjects', async () => {
        const { service } = serviceWithStub();

        await expect(service.create({ ...validGoal, subjectIds: [] })).rejects.toThrowError(
            /at least one subject/i
        );
    });

    it('drops a duplicated subject before it reaches the database', async () => {
        // The scope table's primary key is (goal_id, topic_id), so a repeated id would fail as
        // a confusing constraint violation instead of being the harmless client slip it is.
        const { service, replaceActive } = serviceWithStub();
        const id = '11111111-1111-4111-8111-111111111111';

        await service.create({ ...validGoal, subjectIds: [id, id, id] });

        expect(replaceActive.mock.calls[0]?.[1].subjectIds).toEqual([id]);
    });

    it('trims the title, so a stray space is not stored as part of the name', async () => {
        const { service, replaceActive } = serviceWithStub();

        await service.create({ ...validGoal, title: '  GATE CS 2027  ' });

        expect(replaceActive.mock.calls[0]?.[1].title).toBe('GATE CS 2027');
    });
});

describe('GoalService.getActive', () => {
    it('returns null when the learner has no goal, rather than throwing', async () => {
        const { service } = serviceWithStub();

        // A learner without a goal has not hit an error; the UI should ask them to set one.
        expect(await service.getActive('user-1')).toBeNull();
    });
});
