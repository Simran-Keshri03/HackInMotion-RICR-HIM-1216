import { Router } from 'express';
import { getLearnerSummary } from '@/controllers/learnerController.js';
import { getActivity, getGoalSubjects } from '@/controllers/activityController.js';
import {
    getProfile,
    updateProfile,
    updateProfileSchema,
} from '@/controllers/profileController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const learnerRouter = Router();

// Every route here needs a signed-in learner.
learnerRouter.use(requireAuth);

// GET /api/v1/learner/summary
learnerRouter.get('/summary', asyncRoute(getLearnerSummary));

// GET /api/v1/learner/activity — a year of squares, plus badges.
//
// Not rate limited: it reads the learner's own rows, spends nothing on AI, and the dashboard asks for
// it on every visit.
learnerRouter.get('/activity', asyncRoute(getActivity));

// GET   /api/v1/learner/profile — name, email, timezone
// PATCH /api/v1/learner/profile — name and timezone only; the column grant enforces the rest
// GET /api/v1/learner/subjects — the goal's subjects with per-subject progress
learnerRouter.get('/subjects', asyncRoute(getGoalSubjects));

learnerRouter.get('/profile', asyncRoute(getProfile));
learnerRouter.patch(
    '/profile',
    validateBody(updateProfileSchema),
    asyncRoute(updateProfile)
);
