import { Router } from 'express';
import { getDueRevisions } from '@/controllers/revisionController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const revisionRouter = Router();

revisionRouter.use(requireAuth);

// GET /api/v1/revision/due
//
// Not rate limited: it is a cheap read of the learner's own rows, costs nothing in AI calls, and the
// plan screen asks for it on every visit.
revisionRouter.get('/due', asyncRoute(getDueRevisions));
