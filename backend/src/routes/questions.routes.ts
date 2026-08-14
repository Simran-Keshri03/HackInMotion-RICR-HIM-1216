import { Router } from 'express';
import { generateQuestions, generateQuestionsSchema } from '@/controllers/questionController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { rateLimit } from '@/middleware/rateLimitMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const questionsRouter = Router();

questionsRouter.use(requireAuth);

// POST /api/v1/questions/generate
// Rate limited because every call spends money: one generation request plus one
// verification request per question produced.
questionsRouter.post(
    '/generate',
    rateLimit({
        max: 10,
        windowMs: 60 * 60 * 1000,
        message: 'You have reached the hourly limit for generating questions.',
    }),
    validateBody(generateQuestionsSchema),
    asyncRoute(generateQuestions)
);
