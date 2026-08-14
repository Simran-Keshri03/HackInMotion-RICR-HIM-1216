import { Router } from 'express';
import {
    createGroup,
    createGroupSchema,
    getGroup,
    joinGroup,
    joinGroupSchema,
    leaveGroup,
    listGroups,
} from '@/controllers/groupController.js';
import { requireAuth } from '@/middleware/authMiddleware.js';
import { rateLimit } from '@/middleware/rateLimitMiddleware.js';
import { validateBody } from '@/middleware/validationMiddleware.js';
import { asyncRoute } from '@/utils/http.js';

export const groupRouter = Router();

groupRouter.use(requireAuth);

// GET  /api/v1/groups
// GET  /api/v1/groups/:id
// POST /api/v1/groups
// POST /api/v1/groups/join
// POST /api/v1/groups/:id/leave
groupRouter.get('/', asyncRoute(listGroups));

groupRouter.post('/', validateBody(createGroupSchema), asyncRoute(createGroup));

// Rate limited harder than anything else in the app, and not because it costs money.
//
// An invite code is six characters from a 31-symbol alphabet — about 900 million codes. Unlimited
// attempts turn that into a guessing game against every group in the database, and a hit would put a
// stranger inside a group and show them its members' progress. Thirty tries an hour makes that
// hopeless while being far more than a person mistyping a code they were given.
groupRouter.post(
    '/join',
    rateLimit({
        max: 30,
        windowMs: 60 * 60 * 1000,
        message: 'Too many join attempts. Wait a while and check the code you were given.',
    }),
    validateBody(joinGroupSchema),
    asyncRoute(joinGroup)
);

// Declared after /join so the literal path is never read as a group id.
groupRouter.get('/:id', asyncRoute(getGroup));
groupRouter.post('/:id/leave', asyncRoute(leaveGroup));
