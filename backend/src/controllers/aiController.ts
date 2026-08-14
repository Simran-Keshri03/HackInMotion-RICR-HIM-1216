import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { AiRepository } from '@/repositories/aiRepository.js';
import { claudeProvider } from '@/services/ai/providers/claudeProvider.js';
import { TutorService } from '@/services/ai/aiService.js';
import { AppError, sendOk } from '@/utils/http.js';

export const askTutorSchema = z.object({
    question: z.string().trim().min(2).max(2000),
    /** Continues a thread. Ownership is checked server-side, not trusted. */
    conversationId: z.string().uuid().optional(),
    topicId: z.string().uuid().optional(),
    /** The question on screen, when asked from the practice page. */
    currentQuestion: z.string().max(2000).optional(),
});

/** POST /api/v1/ai/tutor — ask a question, get an answer grounded in this learner's state. */
export async function askTutor(req: Request, res: Response) {
    const { userId } = authOf(req);
    const body = req.body as z.infer<typeof askTutorSchema>;

    // Elevated client: writing a conversation, and reading the mastery and mistakes the reply is
    // grounded in, are both closed to learners. Every query is filtered by the user id from the
    // token.
    const service = new TutorService(claudeProvider(), new AiRepository(adminDb));

    sendOk(
        res,
        await service.ask({
            userId,
            question: body.question,
            conversationId: body.conversationId,
            topicId: body.topicId,
            currentQuestion: body.currentQuestion,
        }),
        201
    );
}

/** GET /api/v1/ai/conversations — the learner's own threads, most recent first. */
export async function listConversations(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    // Reads only, so the learner-scoped client is right: RLS is a second lock behind the user id.
    const service = new TutorService(unusedProvider(), new AiRepository(userDb(accessToken)));

    sendOk(res, { conversations: await service.listConversations(userId) });
}

/** GET /api/v1/ai/conversations/:id — one thread with its messages. */
export async function getConversation(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    const id = z.string().uuid().safeParse(req.params.id);

    if (!id.success) {
        throw new AppError(400, 'INVALID_INPUT', 'That is not a conversation id.');
    }

    const service = new TutorService(unusedProvider(), new AiRepository(userDb(accessToken)));

    sendOk(res, await service.getConversation(id.data, userId));
}

/**
 * The read paths never call the model, but the service asks for a provider. Rather than making
 * the dependency nullable everywhere, hand these one that throws if it is ever reached — reading
 * your own chat history must not depend on an API key being configured.
 */
function unusedProvider() {
    return {
        name: 'unused',
        generateJson() {
            throw new Error('reads do not call the model');
        },
        generateText() {
            throw new Error('reads do not call the model');
        },
    } as never;
}
