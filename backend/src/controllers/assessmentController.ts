import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { AssessmentRepository } from '@/repositories/assessmentRepository.js';
import { AttemptRepository } from '@/repositories/attemptRepository.js';
import { GoalRepository } from '@/repositories/goalRepository.js';
import { MasteryRepository } from '@/repositories/masteryRepository.js';
import { AssessmentService, DIAGNOSTIC_CONFIG } from '@/services/assessment/assessmentService.js';
import { GoalService } from '@/services/learning/goalService.js';
import { AppError, sendOk } from '@/utils/http.js';

/**
 * The elevated client throughout, for the same reasons the mock test endpoints use it: marking reads
 * `questions.correct_answer`, which learners hold no privilege on, and the assessment tables grant
 * SELECT and nothing else. `AssessmentService` therefore checks ownership itself on every read.
 */
function service(): AssessmentService {
    return new AssessmentService(
        new AssessmentRepository(adminDb),
        new AttemptRepository(adminDb),
        new MasteryRepository(adminDb)
    );
}

/** The learner's active goal, or a 400 explaining that an assessment needs one. */
async function requireGoal(userId: string, accessToken: string) {
    const goal = await new GoalService(new GoalRepository(userDb(accessToken))).getActive(userId);

    if (!goal) {
        throw new AppError(
            400,
            'NO_ACTIVE_GOAL',
            'Set a learning goal first — an assessment measures you against the subjects you chose.'
        );
    }

    return goal;
}

export const startAssessmentSchema = z.object({
    questionCount: z
        .number()
        .int()
        .min(DIAGNOSTIC_CONFIG.minQuestions)
        .max(DIAGNOSTIC_CONFIG.maxQuestions)
        .optional(),
});

export const submitAssessmentSchema = z.object({
    answers: z
        .array(
            z.object({
                questionId: z.string().uuid(),
                selectedOptions: z.array(z.number().int().min(0).max(20)).optional(),
                value: z.number().optional(),
            })
        )
        .max(DIAGNOSTIC_CONFIG.maxQuestions),
});

/**
 * GET /api/v1/assessments/diagnostic
 *
 * The diagnostic for the current goal, or null. Null is a real answer: a learner who has set a goal and
 * not sat one should be offered it, not shown an error.
 */
export async function getDiagnostic(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);
    const goal = await requireGoal(userId, accessToken);

    sendOk(res, {
        assessment: await service().getForGoal(userId, goal.id),
        limits: {
            min: DIAGNOSTIC_CONFIG.minQuestions,
            max: DIAGNOSTIC_CONFIG.maxQuestions,
            default: DIAGNOSTIC_CONFIG.defaultQuestions,
        },
    });
}

/** POST /api/v1/assessments/diagnostic — build and start one. */
export async function startDiagnostic(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);
    const body = req.body as z.infer<typeof startAssessmentSchema>;
    const goal = await requireGoal(userId, accessToken);

    sendOk(
        res,
        {
            assessment: await service().start(
                userId,
                goal.id,
                body.questionCount ?? DIAGNOSTIC_CONFIG.defaultQuestions
            ),
        },
        201
    );
}

/** GET /api/v1/assessments/:id */
export async function getAssessment(req: Request, res: Response) {
    const { userId } = authOf(req);
    const id = z.string().uuid().safeParse(req.params.id);

    if (!id.success) {
        // The same answer as one that is not yours, so the two cannot be told apart by probing.
        throw new AppError(404, 'ASSESSMENT_NOT_FOUND', 'That assessment does not exist.');
    }

    sendOk(res, { assessment: await service().getOne(userId, id.data) });
}

/**
 * POST /api/v1/assessments/:id/submit
 *
 * Marks the paper and lets it move mastery, which is what makes the next study plan personalised.
 */
export async function submitAssessment(req: Request, res: Response) {
    const { userId } = authOf(req);
    const id = z.string().uuid().safeParse(req.params.id);

    if (!id.success) {
        throw new AppError(404, 'ASSESSMENT_NOT_FOUND', 'That assessment does not exist.');
    }

    const body = req.body as z.infer<typeof submitAssessmentSchema>;

    const answers = body.answers.map((answer) => ({
        questionId: answer.questionId,
        answer:
            answer.selectedOptions !== undefined
                ? { selectedOptions: answer.selectedOptions }
                : answer.value !== undefined
                  ? { value: answer.value }
                  : undefined,
    }));

    sendOk(res, {
        assessment: await service().submit(userId, id.data, answers),
    });
}
