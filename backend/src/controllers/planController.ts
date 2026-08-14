import type { Request, Response } from 'express';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { GoalRepository } from '@/repositories/goalRepository.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { PlanRepository } from '@/repositories/planRepository.js';
import { RevisionRepository } from '@/repositories/revisionRepository.js';
import { GoalService } from '@/services/learning/goalService.js';
import { PlanService } from '@/services/planning/planService.js';
import { AppError, sendOk } from '@/utils/http.js';

/**
 * GET /api/v1/study-plan/current
 *
 * The learner's plan, or null. Null is a real answer: somebody who has set a goal but never asked
 * for a plan should see a screen offering to build one, not an error.
 *
 * Learner-scoped client, so row-level security is a second lock behind the user id in the token.
 */
export async function getCurrentPlan(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    // Read as the learner; the goal is their own row and RLS applying is one less thing to reason
    // about.
    const goal = await new GoalService(
        new GoalRepository(userDb(accessToken))
    ).getActive(userId);

    // Elevated, because reading the plan may also settle past sessions and rebuild it — both writes
    // learners hold no privilege for. That is deliberate: a learner who could mark their own
    // sessions complete would make the missed-session signal, and every re-plan built on it,
    // worthless.
    const service = new PlanService(
        new PlanRepository(adminDb),
        new LearnerRepository(adminDb),
        new RevisionRepository(adminDb)
    );

    const { plan, adjustment } = await service.refreshCurrent(
        userId,
        goal
            ? {
                  id: goal.id,
                  examDate: goal.examDate,
                  dailyMinutes: goal.dailyMinutes,
              }
            : null
    );

    sendOk(res, { plan, adjustment });
}

/**
 * POST /api/v1/study-plan/generate
 *
 * Builds a plan from the active goal. Elevated client, because both plan tables grant learners
 * SELECT and nothing else — a learner who could write their own plan could write themselves an
 * easy one, and every screen built on the plan would then mean nothing.
 */
export async function generatePlan(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    // The goal is read as the learner: it is their own row, and RLS applying is one less thing to
    // reason about.
    const goal = await new GoalService(
        new GoalRepository(userDb(accessToken))
    ).getActive(userId);

    if (!goal) {
        throw new AppError(
            400,
            'NO_ACTIVE_GOAL',
            'Set a learning goal first — the plan is built from it.'
        );
    }

    const service = new PlanService(
        new PlanRepository(adminDb),
        new LearnerRepository(adminDb),
        new RevisionRepository(adminDb)
    );

    const plan = await service.generate(
        userId,
        {
            id: goal.id,
            examDate: goal.examDate,
            dailyMinutes: goal.dailyMinutes,
        },
        'requested'
    );

    sendOk(res, { plan }, 201);
}
