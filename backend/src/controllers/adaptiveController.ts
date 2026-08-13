import type { Request, Response } from 'express';
import { z } from 'zod';
import { userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { QuestionRepository } from '@/repositories/questionRepository.js';
import { TopicRepository } from '@/repositories/topicRepository.js';
import { QuestionSelector } from '@/services/adaptive/questionSelector.js';
import {
    finaliseAction,
    planSession,
} from '@/services/adaptive/recommendationEngine.js';
import { AppError, sendOk } from '@/utils/http.js';

/** ?minutes=20 tells the engine how much time the learner has right now. */
const querySchema = z.object({
    minutes: z.coerce.number().int().min(1).max(600).optional(),
});

/**
 * GET /api/v1/recommendations/next
 *
 * The single most important read in the product: what should I do now, and why.
 *
 * Everything here runs as the learner (userDb), so RLS is a second lock behind the user id
 * from the token. Nothing needs elevated rights, because the response deliberately contains
 * no correct answers.
 */
export async function getNextRecommendation(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    const query = querySchema.safeParse(req.query);
    if (!query.success) {
        throw new AppError(
            400,
            'INVALID_INPUT',
            'minutes must be a whole number between 1 and 600.'
        );
    }

    const db = userDb(accessToken);
    const topics = new TopicRepository(db);
    const learners = new LearnerRepository(db);

    const [candidates, profile] = await Promise.all([
        topics.findCandidatesForLearner(userId, new Date()),
        learners.findProfile(userId),
    ]);

    // Phase one: which topic, what kind of session, at what difficulty.
    const plan = planSession({
        candidates,
        secondsPerQuestion: profile?.avg_seconds_per_question
            ? Number(profile.avg_seconds_per_question)
            : null,
        availableMinutes: query.data.minutes ?? null,
    });

    if (!plan) {
        // A real, explainable empty state rather than a 404: there is simply nothing in
        // scope yet, and the UI should say "pick a goal" instead of "not found".
        sendOk(res, {
            recommendation: null,
            questions: [],
            reason: 'No topics are in scope yet. Set a learning goal to get started.',
        });
        return;
    }

    const selection = await new QuestionSelector(new QuestionRepository(db)).select({
        userId,
        topicId: plan.candidate.topicId,
        difficulty: plan.difficulty,
        count: plan.requestedQuestionCount,
    });

    if (selection.questions.length === 0) {
        sendOk(res, {
            recommendation: null,
            questions: [],
            reason: `${plan.candidate.name} has no questions available yet.`,
        });
        return;
    }

    // Phase two: the count, the time estimate and the sentence all come from what the bank
    // could actually supply, so the recommendation never promises more than it delivers.
    sendOk(res, {
        recommendation: finaliseAction(plan, selection.questions.length),
        questions: selection.questions,
        bankNote: selection.note,
    });
}
