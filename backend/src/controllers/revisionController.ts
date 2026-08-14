import type { Request, Response } from 'express';
import { userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { GoalRepository } from '@/repositories/goalRepository.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { RevisionRepository } from '@/repositories/revisionRepository.js';
import { GoalService } from '@/services/learning/goalService.js';
import { daysOverdue } from '@/services/learner/srsEngine.js';
import { todayIn } from '@/utils/dates.js';
import { sendOk } from '@/utils/http.js';

/**
 * GET /api/v1/revision/due — topics the spaced-repetition schedule says are owed a review.
 *
 * Learner-scoped client throughout: this only reads, and row-level security is a second lock behind
 * the user id in the token. Nothing here needs elevated rights, because the response carries no
 * answers — just which topics are due and how overdue they are.
 *
 * An empty list is a real answer, not a 404. A learner who is up to date should be told so.
 */
export async function getDueRevisions(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);
    const db = userDb(accessToken);

    const goal = await new GoalService(new GoalRepository(db)).getActive(userId);

    // Scoped to the current goal's subjects. Without this a learner who switched from class 10 to
    // GATE would be told to revise Trigonometry, which is history rather than something to act on.
    const scopeIds = goal?.subjectIds ?? [];

    // Their day, not the server's: at 00:30 in India the UTC date is still yesterday, and a topic
    // due "today" would be reported as not yet due.
    const today = todayIn(await new LearnerRepository(db).findTimezone(userId));
    const due = await new RevisionRepository(db).findDue(userId, today, scopeIds);

    sendOk(res, {
        today,
        due: due.map((topic) => ({
            ...topic,
            // Computed here rather than stored: it changes every day on its own, and a stored copy
            // would be wrong by definition the morning after it was written.
            daysOverdue: daysOverdue(topic.dueOn, today),
        })),
    });
}
