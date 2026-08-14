import type { Request, Response } from 'express';
import { userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { CALENDAR_DAYS, addDays, buildCalendar } from '@/services/learner/activityEngine.js';
import { MASTERY_BAR, earnedBadges, nextBadges } from '@/services/learner/badgeEngine.js';
import { todayIn } from '@/utils/dates.js';
import { sendOk } from '@/utils/http.js';

/**
 * GET /api/v1/learner/activity
 *
 * A year of squares, the streaks read off them, and the badges the record supports.
 *
 * Learner-scoped client: this only reads the learner's own rows, so row-level security is a second
 * lock behind the user id in the token. Nothing here needs elevated rights.
 *
 * The streaks come from the calendar rather than from `learner_profiles`, and the badges are
 * recomputed rather than stored — both so that what the learner sees is always consistent with the
 * attempts behind it. A max streak that disagrees with the grid beside it is the kind of thing
 * somebody notices at once and cannot unsee.
 */
export async function getActivity(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);
    const db = userDb(accessToken);

    const learners = new LearnerRepository(db);

    const timezone = await learners.findTimezone(userId);
    const today = todayIn(timezone);
    const from = addDays(today, -(CALENDAR_DAYS - 1));

    const [activity, achievements, profile] = await Promise.all([
        learners.findDailyActivity(userId, from, today, (at) => todayIn(timezone, new Date(at))),
        learners.findAchievementCounts(userId, MASTERY_BAR),
        learners.findProfile(userId),
    ]);

    const calendar = buildCalendar(activity.counts, today);

    const badgeInputs = {
        activeDates: [...activity.counts.keys()].sort(),
        maxStreak: calendar.maxStreak,
        // Lifetime, not the window: a badge for answering a thousand questions should not be lost
        // because they were answered thirteen months ago.
        totalAnswered: profile?.total_attempts ?? activity.total,
        topicsMastered: achievements.topicsMastered,
        accuracyPercent:
            profile?.overall_accuracy === null || profile?.overall_accuracy === undefined
                ? null
                : Number(profile.overall_accuracy),
        reviewsCompleted: achievements.reviewsCompleted,
    };

    const badges = earnedBadges(badgeInputs);

    sendOk(res, {
        calendar,
        badges,
        /** The next milestone in each family — the reason to come back tomorrow. */
        upcoming: nextBadges(badgeInputs),
        /** Convenience for the card that mirrors LeetCode's "Most Recent Badge". */
        latestBadge: badges[0] ?? null,
    });
}

/**
 * GET /api/v1/learner/subjects
 *
 * The subjects in the learner's goal, with how far through each they are. Drives the practice screen.
 *
 * An empty list means "no goal yet", not "no subjects" — the client sends them to the goal screen
 * rather than showing an error, because that is the actual next step.
 */
export async function getGoalSubjects(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    const subjects = await new LearnerRepository(userDb(accessToken)).findGoalSubjects(userId);

    sendOk(res, { subjects });
}
