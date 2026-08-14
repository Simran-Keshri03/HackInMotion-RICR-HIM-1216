import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { AttemptRepository } from '@/repositories/attemptRepository.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { MockTestRepository } from '@/repositories/mockTestRepository.js';
import { PlanRepository } from '@/repositories/planRepository.js';
import { MOCK_TEST_CONFIG, MockTestService } from '@/services/assessment/mockTestService.js';
import { AppError, sendOk } from '@/utils/http.js';

/**
 * Every endpoint here uses the elevated client, and that is the security story of the feature.
 *
 * Marking reads `questions.correct_answer`, which learners hold no privilege on, and writes
 * `mock_test_questions.is_correct`, which is the marking itself — a learner able to write it could
 * mark their own paper. Both tables grant SELECT and nothing else, so the service is the only route.
 *
 * `MockTestService` therefore checks ownership itself on every read: the elevated client bypasses
 * row-level security, so the user id filter inside the repository is what stands between a test id and
 * somebody else's paper.
 */
function service(): MockTestService {
    return new MockTestService(
        new MockTestRepository(adminDb),
        new PlanRepository(adminDb),
        new LearnerRepository(adminDb),
        new AttemptRepository(adminDb)
    );
}

export const generateTestSchema = z.object({
    questionCount: z
        .number()
        .int()
        .min(MOCK_TEST_CONFIG.minQuestions)
        .max(MOCK_TEST_CONFIG.maxQuestions)
        .optional(),
});

export const submitTestSchema = z.object({
    answers: z
        .array(
            z.object({
                questionId: z.string().uuid(),
                // Exactly the two answer shapes the grader understands. A question the learner skipped
                // is simply absent from this array rather than sent as null.
                selectedOptions: z.array(z.number().int().min(0).max(20)).optional(),
                value: z.number().optional(),
            })
        )
        .max(MOCK_TEST_CONFIG.maxQuestions),
    secondsTaken: z.number().int().min(0).max(86_400),
});

/** GET /api/v1/mock-tests — recent sittings, plus the one still open if there is one. */
export async function listTests(req: Request, res: Response) {
    const { userId } = authOf(req);
    const tests = service();

    sendOk(res, {
        tests: await tests.listRecent(userId),
        open: await tests.getOpen(userId),
        limits: {
            min: MOCK_TEST_CONFIG.minQuestions,
            max: MOCK_TEST_CONFIG.maxQuestions,
            default: MOCK_TEST_CONFIG.defaultQuestions,
        },
    });
}

/** GET /api/v1/mock-tests/:id — questions while open, the result once submitted. */
export async function getTest(req: Request, res: Response) {
    const { userId } = authOf(req);
    const id = z.string().uuid().safeParse(req.params.id);

    if (!id.success) {
        // The same answer as a test that is not yours, so the two cannot be told apart.
        throw new AppError(404, 'TEST_NOT_FOUND', 'That test does not exist.');
    }

    sendOk(res, { test: await service().getOne(userId, id.data) });
}

/**
 * POST /api/v1/mock-tests — build one from the study plan.
 *
 * Rate limited in the route. Not for AI cost — a test spends nothing on the model — but because each
 * one writes a paper's worth of rows and retires the previous test.
 */
export async function generateTest(req: Request, res: Response) {
    const { userId } = authOf(req);
    const body = req.body as z.infer<typeof generateTestSchema>;

    sendOk(
        res,
        {
            test: await service().generate(
                userId,
                body.questionCount ?? MOCK_TEST_CONFIG.defaultQuestions
            ),
        },
        201
    );
}

/** POST /api/v1/mock-tests/:id/submit — every answer at once, marked in one pass. */
export async function submitTest(req: Request, res: Response) {
    const { userId } = authOf(req);
    const id = z.string().uuid().safeParse(req.params.id);

    if (!id.success) {
        throw new AppError(404, 'TEST_NOT_FOUND', 'That test does not exist.');
    }

    const body = req.body as z.infer<typeof submitTestSchema>;

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
        test: await service().submit(userId, id.data, answers, body.secondsTaken),
    });
}
