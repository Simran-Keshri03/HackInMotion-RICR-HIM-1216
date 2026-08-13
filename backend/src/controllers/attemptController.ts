import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { AttemptRepository } from '@/repositories/attemptRepository.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { MasteryRepository } from '@/repositories/masteryRepository.js';
import { PracticeService } from '@/services/practice/practiceService.js';
import { sendOk } from '@/utils/http.js';

/**
 * Note what is absent from this schema: user_id. The learner is whoever the verified token
 * says they are. Anything the client sends about identity is ignored, not validated.
 */
export const submitAttemptSchema = z
    .object({
        questionId: z.string().uuid(),

        // Choice questions send option indexes; numeric questions send a value. Exactly
        // one of the two, checked below.
        selectedOptions: z.array(z.number().int().min(0).max(50)).max(20).optional(),
        value: z.number().finite().optional(),

        // Matches the database's ceiling: over an hour means the tab was left open.
        timeTakenSeconds: z.number().int().min(0).max(3600).nullable().default(null),

        source: z
            .enum(['practice', 'assessment', 'topic_test', 'mock_test', 'revision'])
            .default('practice'),
    })
    .refine(
        (body) =>
            (body.selectedOptions === undefined) !== (body.value === undefined),
        {
            message:
                'Send either selectedOptions (choice questions) or value (numeric questions), not both.',
        }
    );

export async function submitAttempt(req: Request, res: Response) {
    const { userId } = authOf(req);
    const body = req.body as z.infer<typeof submitAttemptSchema>;

    // Elevated client on purpose: grading reads the correct answer, and the attempt log
    // and mastery cache are both closed to learners. Every query below is filtered by the
    // user id from the token.
    const service = new PracticeService(
        new AttemptRepository(adminDb),
        new MasteryRepository(adminDb),
        new LearnerRepository(adminDb)
    );

    const result = await service.submit({
        userId,
        questionId: body.questionId,
        answer:
            body.selectedOptions !== undefined
                ? { selectedOptions: body.selectedOptions }
                : { value: body.value as number },
        timeTakenSeconds: body.timeTakenSeconds,
        source: body.source,
    });

    sendOk(res, result, 201);
}
