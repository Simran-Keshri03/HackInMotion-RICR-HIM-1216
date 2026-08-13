import { Router } from 'express';
import {
    getDefaultCurriculum,
    resolveCurriculum,
    resolveCurriculumSchema,
} from '@/controllers/curriculumController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { rateLimit } from '@/middleware/rateLimitMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const curriculaRouter = Router();

curriculaRouter.use(requireAuth);

// GET /api/v1/curricula/default — no AI, no cost
curriculaRouter.get('/default', asyncRoute(getDefaultCurriculum));

// POST /api/v1/curricula/resolve
//
// Rate limited because this is a free-text AI entry point: a script in a loop would otherwise
// spend real money. 20 an hour is far more than a person setting a goal needs, and a repeated
// goal is served from the database without an AI call at all.
curriculaRouter.post(
    '/resolve',
    rateLimit({
        max: 20,
        windowMs: 60 * 60 * 1000,
        message: 'You have looked up a lot of goals in the last hour.',
    }),
    validateBody(resolveCurriculumSchema),
    asyncRoute(resolveCurriculum)
);
