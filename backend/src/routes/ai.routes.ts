import { Router } from 'express';
import {
    askTutor,
    askTutorSchema,
    getConversation,
    listConversations,
} from '@/controllers/aiController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { rateLimit } from '@/middleware/rateLimitMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const aiRouter = Router();

aiRouter.use(requireAuth);

// Reads are free and unlimited: a learner scrolling their own history costs nothing.
aiRouter.get('/conversations', asyncRoute(listConversations));
aiRouter.get('/conversations/:id', asyncRoute(getConversation));

// POST /api/v1/ai/tutor
//
// Rate limited per learner because every call spends money. 40 an hour is far more than a person
// studying can get through — it exists to stop a loop in client code, not to ration help.
aiRouter.post(
    '/tutor',
    rateLimit({
        max: 40,
        windowMs: 60 * 60 * 1000,
        message: 'You have asked a lot of questions in the last hour.',
    }),
    validateBody(askTutorSchema),
    asyncRoute(askTutor)
);
