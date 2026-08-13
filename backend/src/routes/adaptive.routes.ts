import { Router } from 'express';
import { getNextRecommendation } from '@/controllers/adaptiveController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const recommendationsRouter = Router();

recommendationsRouter.use(requireAuth);

// GET /api/v1/recommendations/next
recommendationsRouter.get('/next', asyncRoute(getNextRecommendation));
