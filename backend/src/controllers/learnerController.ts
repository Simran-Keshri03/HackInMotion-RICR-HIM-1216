import type { Request, Response } from 'express';
import { authOf } from '@/middleware/authMiddleware.js';
import { userDb } from '@/config/database.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { LearnerModelService } from '@/services/learner/learnerModel.js';
import { sendOk } from '@/utils/http.js';

/**
 * Thin by design: read the identity, delegate, respond. No SQL, no business rules.
 *
 * The repository is built with userDb, so every query runs as the signed-in learner and
 * RLS is a second lock behind the user id we pass in.
 */
export async function getLearnerSummary(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    const service = new LearnerModelService(new LearnerRepository(userDb(accessToken)));

    sendOk(res, await service.getSummary(userId));
}
