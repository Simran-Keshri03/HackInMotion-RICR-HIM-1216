import type { Request, Response } from 'express';
import { userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { GoalRepository } from '@/repositories/goalRepository.js';
import { MockTestRepository } from '@/repositories/mockTestRepository.js';
import { PlanRepository } from '@/repositories/planRepository.js';
import { GoalService } from '@/services/learning/goalService.js';
import { READINESS_CONFIG, scoreReadiness } from '@/services/readiness/readinessEngine.js';
import { sendOk } from '@/utils/http.js';

/**
 * GET /api/v1/readiness — how ready the learner is for the exam they named, and why.
 *
 * Learner-scoped client: three reads of the learner's own rows, no writes, nothing computed that is
 * worth storing. The score is derived on every read on purpose — mastery moves with every answer, and
 * the number of days left moves on its own overnight, so a stored readiness figure is wrong by the
 * next morning without anybody having done anything.
 *
 * Not rate limited. It costs one round of cheap reads and no AI call, and the dashboard asks for it
 * on every visit.
 */
export async function getReadiness(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);
    const db = userDb(accessToken);

    const goal = await new GoalService(new GoalRepository(db)).getActive(userId);

    // No goal is a normal state, not an error: a learner who has just signed up has one, and a 404
    // here would put a broken panel on the dashboard of every new account. The screen shows a prompt
    // to set a goal instead.
    if (!goal) {
        sendOk(res, { goal: null, readiness: null });
        return;
    }

    const [topics, mocks] = await Promise.all([
        new PlanRepository(db).findPlannableTopics(userId, goal.subjectIds),
        new MockTestRepository(db).findRecent(userId, 20),
    ]);

    const readiness = scoreReadiness({
        topics,
        // Only finished papers. An abandoned or in-progress test says nothing about form yet, and
        // counting one as a zero would punish a learner for having opened a mock and stopped.
        mocks: mocks
            .filter((test) => test.status === 'submitted' && test.score_percent !== null)
            .map((test) => ({
                scorePercent: test.score_percent as number,
                submittedAt: test.submitted_at ?? test.started_at,
            })),
        daysRemaining: goal.daysRemaining,
        dailyMinutes: goal.dailyMinutes,
    });

    sendOk(res, {
        goal: {
            title: goal.title,
            examDate: goal.examDate,
            daysRemaining: goal.daysRemaining,
            dailyMinutes: goal.dailyMinutes,
        },
        readiness,
        // Published so the screen never hard-codes a threshold the engine owns. A band drawn at a
        // different line from the one that produced it is the kind of disagreement nobody notices
        // until a learner is told they are "on track" under a heading that says otherwise.
        thresholds: {
            ready: READINESS_CONFIG.readyAt,
            onTrack: READINESS_CONFIG.onTrackAt,
            building: READINESS_CONFIG.buildingAt,
            masteryTarget: READINESS_CONFIG.masteryTarget,
        },
    });
}
