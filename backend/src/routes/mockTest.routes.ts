import { Router } from 'express';
import {
    generateTest,
    generateTestSchema,
    getTest,
    listTests,
    submitTest,
    submitTestSchema,
} from '@/controllers/mockTestController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { rateLimit } from '@/middleware/rateLimitMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const mockTestRouter = Router();

mockTestRouter.use(requireAuth);

// GET  /api/v1/mock-tests
// POST /api/v1/mock-tests
// GET  /api/v1/mock-tests/:id
// POST /api/v1/mock-tests/:id/submit
mockTestRouter.get('/', asyncRoute(listTests));

// Costs nothing in AI calls, but each test writes a paper's worth of rows and retires the previous
// one, so a loop here would fill the table with abandoned tests.
mockTestRouter.post(
    '/',
    rateLimit({
        max: 20,
        windowMs: 60 * 60 * 1000,
        message: 'You have generated a lot of tests in the last hour.',
    }),
    validateBody(generateTestSchema),
    asyncRoute(generateTest)
);

mockTestRouter.get('/:id', asyncRoute(getTest));
mockTestRouter.post('/:id/submit', validateBody(submitTestSchema), asyncRoute(submitTest));
