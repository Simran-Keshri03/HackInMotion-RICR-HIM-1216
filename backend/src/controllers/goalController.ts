import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { GoalRepository } from '@/repositories/goalRepository.js';
import { GoalService } from '@/services/learning/goalService.js';
import { AppError, sendOk } from '@/utils/http.js';

/**
 * Note what is absent: user_id. The learner is whoever the verified token says they are.
 *
 * The numeric bounds mirror the CHECK constraints on learning_goals, so a bad value is a clear
 * 400 naming the field rather than a database error the client cannot act on. The date is
 * checked for shape here and for sense (future, within two years) in the service — a CHECK
 * constraint cannot enforce that, because it would also fire on every later UPDATE.
 */
export const createGoalSchema = z.object({
    title: z.string().trim().min(1).max(120),
    curriculumId: z.string().uuid(),
    examDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD form'),
    dailyMinutes: z.number().int().min(10).max(960),
    subjectIds: z.array(z.string().uuid()).min(1).max(20),
});

/**
 * GET /api/v1/goals/subjects?curriculumId=… — subjects within one syllabus.
 *
 * Scoped to a curriculum rather than listing everything: curricula are shared, so a global list
 * would offer a class 10 learner somebody else's GATE subjects.
 */
export async function listSubjects(req: Request, res: Response) {
    const { accessToken } = authOf(req);

    const query = z
        .object({ curriculumId: z.string().uuid() })
        .safeParse(req.query);

    if (!query.success) {
        throw new AppError(
            400,
            'INVALID_INPUT',
            'curriculumId is required and must be a uuid.'
        );
    }

    const service = new GoalService(new GoalRepository(userDb(accessToken)));

    sendOk(res, {
        subjects: await service.listSubjects(query.data.curriculumId),
    });
}

/**
 * GET /api/v1/goals — the learner's active goal, or null.
 *
 * Null is a real answer, not an error: a learner who has not set a goal yet should see the
 * screen that asks for one, and a 404 would make the client guess at that distinction.
 */
export async function getActiveGoal(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    const service = new GoalService(new GoalRepository(userDb(accessToken)));

    sendOk(res, { goal: await service.getActive(userId) });
}

/**
 * POST /api/v1/goals — set the goal, replacing any existing one.
 *
 * Elevated client, because the goal tables grant SELECT to learners and nothing else: writes
 * go through here so the validation above cannot be skipped by talking to the database
 * directly.
 */
export async function createGoal(req: Request, res: Response) {
    const { userId } = authOf(req);
    const body = req.body as z.infer<typeof createGoalSchema>;

    const service = new GoalService(new GoalRepository(adminDb));

    const goal = await service.create({
        userId,
        curriculumId: body.curriculumId,
        title: body.title,
        examDate: body.examDate,
        dailyMinutes: body.dailyMinutes,
        subjectIds: body.subjectIds,
    });

    sendOk(res, { goal }, 201);
}
