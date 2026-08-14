import { Router } from 'express';
import { getReadiness } from '@/controllers/readinessController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const readinessRouter = Router();

readinessRouter.use(requireAuth);

// GET /api/v1/readiness
//
// Not rate limited: three cheap reads of the learner's own rows and no AI call, asked for on every
// visit to the dashboard.
readinessRouter.get('/', asyncRoute(getReadiness));
