import { Router } from 'express';
import { generatePlan, getCurrentPlan } from '@/controllers/planController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { rateLimit } from '@/middleware/rateLimitMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const planRouter = Router();

planRouter.use(requireAuth);

// GET /api/v1/study-plan/current
planRouter.get('/current', asyncRoute(getCurrentPlan));

// POST /api/v1/study-plan/generate
//
// Rate limited despite costing nothing in AI calls: a plan writes over a hundred rows and
// supersedes the previous one, so a loop here would fill the table with dead plans.
planRouter.post(
    '/generate',
    rateLimit({
        max: 20,
        windowMs: 60 * 60 * 1000,
        message: 'You have rebuilt your plan a lot in the last hour.',
    }),
    asyncRoute(generatePlan)
);
