import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { LearnerRepository } from '@/repositories/learnerRepository.js';
import { QuestionRepository } from '@/repositories/questionRepository.js';
import { TopicRepository } from '@/repositories/topicRepository.js';
import { QuestionSelector } from '@/services/adaptive/questionSelector.js';
import {
    finaliseAction,
    planSession,
} from '@/services/adaptive/recommendationEngine.js';
import { claudeProvider } from '@/services/ai/providers/claudeProvider.js';
import { QuestionBankService } from '@/services/questions/questionBankService.js';
import { AppError, sendOk } from '@/utils/http.js';

/**
 * ?minutes=20 tells the engine how much time the learner has right now.
 * ?subject=<uuid> narrows it to one subject they chose from the practice screen.
 */
const querySchema = z.object({
    minutes: z.coerce.number().int().min(1).max(600).optional(),
    subject: z.string().uuid().optional(),
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
            'minutes must be a whole number between 1 and 600, and subject must be a uuid.'
        );
    }

    const db = userDb(accessToken);
    const topics = new TopicRepository(db);
    const learners = new LearnerRepository(db);

    const [candidates, profile] = await Promise.all([
        topics.findCandidatesForLearner(userId, new Date(), query.data.subject ?? null),
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
            reason: query.data.subject
                ? 'That subject is not part of your current goal.'
                : 'No topics are in scope yet. Set a learning goal to get started.',
        });
        return;
    }

    const selector = new QuestionSelector(new QuestionRepository(db));

    let selection = await selector.select({
        userId,
        topicId: plan.candidate.topicId,
        difficulty: plan.difficulty,
        count: plan.requestedQuestionCount,
    });

    // A topic with nothing to practise is filled here, on the way past. Without this, a syllabus
    // the model wrote — which is every syllabus except the one that ships with the app — is a list
    // of topic names with no questions behind any of them, and the learner meets "nothing available
    // yet" wherever they go.
    if (selection.questions.length === 0) {
        const filled = await fillBank(
            userId,
            plan.candidate.topicId,
            plan.difficulty,
            plan.requestedQuestionCount
        );

        if (filled) {
            selection = await selector.select({
                userId,
                topicId: plan.candidate.topicId,
                difficulty: plan.difficulty,
                count: plan.requestedQuestionCount,
            });
        }
    }

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

/**
 * How many questions to write for a topic nobody has practised yet.
 *
 * Measured rather than guessed: three questions takes about twenty seconds and four AI calls, and
 * the learner is waiting for all of it. Asking for the full session's worth would push a first
 * visit past what anybody waits through, and the engine's request is a preference — the
 * recommendation is rebuilt from what the bank actually supplies, so a short first session is
 * honest rather than broken. The next visit to the topic is instant.
 */
const FIRST_BATCH = 3;

/**
 * Writes questions for a topic that has none, and says whether practice can now proceed.
 *
 * Never throws. This runs inside the product's most important read, and a learner asking what to
 * study next must not be shown an error because a syllabus was thin — they get the empty state
 * that was already there. `AIProviderError` reaching the central handler would turn this into a
 * 503, which is the wrong answer to "what should I do now".
 */
async function fillBank(
    userId: string,
    topicId: string,
    difficulty: 'easy' | 'medium' | 'hard',
    requested: number
): Promise<boolean> {
    try {
        // Elevated client: the generation pipeline reads and writes columns learners hold no
        // privilege on, and the answer key is one of them.
        const bank = new QuestionBankService(
            claudeProvider(),
            new QuestionRepository(adminDb)
        );

        return await bank.fillIfEmpty({
            topicId,
            difficulty,
            count: Math.min(requested, FIRST_BATCH),
            userId,
        });
    } catch (error) {
        // Thrown before generation starts — no API key configured, most likely. Worth a line in
        // the log, because a deployment missing its key would otherwise look like every new
        // syllabus being mysteriously empty.
        console.warn(
            `could not fill the bank for topic ${topicId}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
        return false;
    }
}
