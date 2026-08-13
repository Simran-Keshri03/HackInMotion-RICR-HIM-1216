import { Router } from 'express';
import { getLearnerSummary } from '@/controllers/learnerController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const learnerRouter = Router();

// Every route here needs a signed-in learner.
learnerRouter.use(requireAuth);

// GET /api/v1/learner/summary
learnerRouter.get('/summary', asyncRoute(getLearnerSummary));
