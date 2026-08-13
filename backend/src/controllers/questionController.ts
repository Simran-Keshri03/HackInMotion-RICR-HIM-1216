import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { QuestionRepository } from '@/repositories/questionRepository.js';
import { claudeProvider } from '@/services/ai/providers/claudeProvider.js';
import { QuestionBankService } from '@/services/questions/questionBankService.js';
import { sendOk } from '@/utils/http.js';

export const generateQuestionsSchema = z.object({
    topicId: z.string().uuid(),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
    // Capped low on purpose: each question costs a second AI call to verify, and a small
    // batch that mostly passes beats a large batch that mostly does not.
    count: z.number().int().min(1).max(5).default(3),
});

/**
 * POST /api/v1/questions/generate
 *
 * Writes new questions into the bank. Elevated client, because the pipeline reads and
 * writes columns learners have no privilege on.
 */
export async function generateQuestions(req: Request, res: Response) {
    const { userId } = authOf(req);
    const body = req.body as z.infer<typeof generateQuestionsSchema>;

    const service = new QuestionBankService(
        // The provider is resolved here, at the edge. Everything below this line only
        // knows IAIProvider.
        claudeProvider(),
        new QuestionRepository(adminDb)
    );

    const result = await service.generateForTopic({
        topicId: body.topicId,
        difficulty: body.difficulty,
        count: body.count,
        userId,
    });

    sendOk(res, result, 201);
}
