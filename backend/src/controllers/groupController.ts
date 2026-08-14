import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { GoalRepository } from '@/repositories/goalRepository.js';
import { GroupRepository } from '@/repositories/groupRepository.js';
import { GoalService } from '@/services/learning/goalService.js';
import { GroupService } from '@/services/groups/groupService.js';
import { AppError, sendOk } from '@/utils/http.js';

export const createGroupSchema = z.object({
    name: z.string().trim().min(2).max(60),
});

export const joinGroupSchema = z.object({
    // Loose on length here, tight in the service: people paste codes with spaces, and rejecting that
    // at the schema would be refusing a valid code for a formatting reason.
    inviteCode: z.string().trim().min(4).max(20),
});

/**
 * Every endpoint here uses the elevated client, and that is the whole security story of the feature.
 *
 * Group tables grant learners SELECT and nothing else, so creating, joining and leaving have to come
 * through the service — a learner able to insert into `group_members` directly could add themselves
 * to any group whose id they learned, and the invite code would be decoration. The elevated client
 * also bypasses row-level security, which is why `GroupService` checks membership itself before every
 * read of another learner's numbers.
 */
function service(): GroupService {
    return new GroupService(new GroupRepository(adminDb));
}

/** GET /api/v1/groups — the groups this learner is in. */
export async function listGroups(req: Request, res: Response) {
    const { userId } = authOf(req);

    sendOk(res, { groups: await service().listMine(userId) });
}

/**
 * POST /api/v1/groups — create one.
 *
 * The syllabus is taken from the creator's own goal rather than asked for, so the group screen can say
 * what everybody is preparing for without the creator having to restate it.
 */
export async function createGroup(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);
    const body = req.body as z.infer<typeof createGroupSchema>;

    const goal = await new GoalService(new GoalRepository(userDb(accessToken))).getActive(userId);

    sendOk(
        res,
        { group: await service().create(userId, body.name, goal?.curriculumId ?? null) },
        201
    );
}

/** POST /api/v1/groups/join — join by invite code. */
export async function joinGroup(req: Request, res: Response) {
    const { userId } = authOf(req);
    const body = req.body as z.infer<typeof joinGroupSchema>;

    sendOk(res, { group: await service().join(userId, body.inviteCode) });
}

/** GET /api/v1/groups/:id — members and the ranked comparison. */
export async function getGroup(req: Request, res: Response) {
    const { userId } = authOf(req);
    const groupId = z.string().uuid().safeParse(req.params.id);

    if (!groupId.success) {
        // Same shape of answer as a group that does not exist, so a malformed id cannot be told apart
        // from a real one that is not yours.
        throw new AppError(404, 'GROUP_NOT_FOUND', 'That group does not exist.');
    }

    sendOk(res, { group: await service().detail(userId, groupId.data) });
}

/** POST /api/v1/groups/:id/leave */
export async function leaveGroup(req: Request, res: Response) {
    const { userId } = authOf(req);
    const groupId = z.string().uuid().safeParse(req.params.id);

    if (!groupId.success) {
        throw new AppError(404, 'GROUP_NOT_FOUND', 'That group does not exist.');
    }

    await service().leave(userId, groupId.data);

    sendOk(res, { left: true });
}
