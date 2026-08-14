import type { GoalRepository } from '@/repositories/goalRepository.js';
import { AppError } from '@/utils/http.js';

export interface CreateGoalInput {
    userId: string;
    title: string;
    /** ISO date, YYYY-MM-DD. */
    examDate: string;
    dailyMinutes: number;
    subjectIds: string[];
    /** Which syllabus these subjects belong to. */
    curriculumId: string;
}

export interface GoalView {
    id: string;
    title: string;
    examDate: string;
    dailyMinutes: number;
    subjectIds: string[];
    curriculumId: string | null;
    /** Whole days from today. Zero on exam day, negative once it has passed. */
    daysRemaining: number;
    /** dailyMinutes x days left, so the planner and the UI agree on the budget. */
    totalMinutesAvailable: number;
}

/**
 * Creating and reading the learner's goal.
 *
 * The validation the database cannot do lives here. A CHECK constraint cannot require the exam
 * date to be in the future, because a CHECK also fires on UPDATE — once the exam had passed,
 * any edit to that row would fail. So the rule belongs at the point where a goal is created.
 */
export class GoalService {
    private readonly goals: GoalRepository;

    constructor(goals: GoalRepository) {
        this.goals = goals;
    }

    async listSubjects(curriculumId: string) {
        return this.goals.findSubjects(curriculumId);
    }

    async getActive(userId: string): Promise<GoalView | null> {
        const goal = await this.goals.findActive(userId);
        if (!goal) return null;

        const subjectIds = await this.goals.findScope(goal.id);
        return this.toView(goal, subjectIds);
    }

    async create(input: CreateGoalInput): Promise<GoalView> {
        const daysRemaining = daysUntil(input.examDate);

        if (Number.isNaN(daysRemaining)) {
            throw new AppError(400, 'INVALID_INPUT', 'The exam date is not a real date.');
        }

        if (daysRemaining < 1) {
            throw new AppError(
                400,
                'INVALID_INPUT',
                'The exam date must be in the future — there is nothing to plan otherwise.'
            );
        }

        // Two years out is not a study plan, it is a wish, and the planner's day-by-day
        // allocation becomes meaningless spread that thin.
        if (daysRemaining > 730) {
            throw new AppError(
                400,
                'INVALID_INPUT',
                'Pick an exam date within the next two years.'
            );
        }

        if (input.subjectIds.length === 0) {
            throw new AppError(400, 'INVALID_INPUT', 'Choose at least one subject to study.');
        }

        // Guard against a client sending the same subject twice, which would violate the
        // scope table's composite primary key with a confusing database error.
        const subjectIds = [...new Set(input.subjectIds)];

        const created = await this.goals.replaceActive(input.userId, {
            title: input.title.trim(),
            examDate: input.examDate,
            dailyMinutes: input.dailyMinutes,
            subjectIds,
            curriculumId: input.curriculumId,
        });

        return this.toView(created, subjectIds);
    }

    private toView(
        goal: {
            id: string;
            title: string;
            exam_date: string;
            daily_minutes: number;
            curriculum_id?: string | null;
        },
        subjectIds: string[]
    ): GoalView {
        const daysRemaining = daysUntil(goal.exam_date);

        return {
            id: goal.id,
            title: goal.title,
            examDate: goal.exam_date,
            dailyMinutes: goal.daily_minutes,
            subjectIds,
            curriculumId: goal.curriculum_id ?? null,
            daysRemaining,
            totalMinutesAvailable: Math.max(0, daysRemaining) * goal.daily_minutes,
        };
    }
}

/**
 * Whole days from today to the given date, counted in UTC.
 *
 * UTC on both sides so the difference is a clean multiple of a day. Comparing a local
 * timestamp against a date string is how "1 day left" becomes "0 days left" for anyone east of
 * UTC late in the evening.
 */
export function daysUntil(isoDate: string): number {
    const target = Date.parse(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(target)) return Number.NaN;

    const now = new Date();
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

    return Math.round((target - today) / 86_400_000);
}
