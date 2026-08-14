import { Router } from 'express';
import { submitAttempt, submitAttemptSchema } from '@/controllers/attemptController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const attemptsRouter = Router();

attemptsRouter.use(requireAuth);

// POST /api/v1/attempts
attemptsRouter.post('/', validateBody(submitAttemptSchema), asyncRoute(submitAttempt));
