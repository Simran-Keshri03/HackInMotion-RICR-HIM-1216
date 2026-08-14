import { Router } from 'express';
import {
    getAssessment,
    getDiagnostic,
    startAssessmentSchema,
    startDiagnostic,
    submitAssessment,
    submitAssessmentSchema,
} from '@/controllers/assessmentController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { rateLimit } from '@/middleware/rateLimitMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const assessmentRouter = Router();

assessmentRouter.use(requireAuth);

// GET  /api/v1/assessments/diagnostic
// POST /api/v1/assessments/diagnostic
// GET  /api/v1/assessments/:id
// POST /api/v1/assessments/:id/submit
//
// `/diagnostic` is declared before `/:id` so the literal path is never read as an id.
assessmentRouter.get('/diagnostic', asyncRoute(getDiagnostic));

// Costs nothing in AI calls, but each start writes a paper and retires the previous one.
assessmentRouter.post(
    '/diagnostic',
    rateLimit({
        max: 10,
        windowMs: 60 * 60 * 1000,
        message: 'You have started a lot of assessments in the last hour.',
    }),
    validateBody(startAssessmentSchema),
    asyncRoute(startDiagnostic)
);

assessmentRouter.get('/:id', asyncRoute(getAssessment));
assessmentRouter.post(
    '/:id/submit',
    validateBody(submitAssessmentSchema),
    asyncRoute(submitAssessment)
);
