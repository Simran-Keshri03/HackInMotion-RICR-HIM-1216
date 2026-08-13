import { Router } from 'express';
import {
    createGoal,
    createGoalSchema,
    getActiveGoal,
    listSubjects,
} from '@/controllers/goalController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const goalsRouter = Router();

goalsRouter.use(requireAuth);

// GET  /api/v1/goals/subjects   what the learner can choose from
// GET  /api/v1/goals            the active goal, or null
// POST /api/v1/goals            set the goal, archiving any previous one
//
// /subjects is declared before the bare GET so it is never read as a goal id.
goalsRouter.get('/subjects', asyncRoute(listSubjects));
goalsRouter.get('/', asyncRoute(getActiveGoal));
goalsRouter.post('/', validateBody(createGoalSchema), asyncRoute(createGoal));
