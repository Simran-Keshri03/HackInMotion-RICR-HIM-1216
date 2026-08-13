import type { Request, Response } from 'express';
import { z } from 'zod';
import { adminDb, userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { CurriculumRepository } from '@/repositories/curriculumRepository.js';
import { claudeProvider } from '@/services/ai/providers/claudeProvider.js';
import { CurriculumService } from '@/services/learning/curriculumService.js';
import { sendOk } from '@/utils/http.js';

/**
 * Free text, capped short. 120 characters is enough for "class 12 physics and chemistry" and
 * bounds what reaches the prompt — the real protection is that the reply is schema-validated,
 * business-checked and inserted through parameterised queries, but a short input costs less and
 * gives a crafted prompt less room.
 */
export const resolveCurriculumSchema = z.object({
    goalText: z.string().trim().min(2).max(120),
});

/**
 * POST /api/v1/curricula/resolve
 *
 * Decides whether the text names something studiable and, if it does, returns that syllabus —
 * generating and storing it the first time anyone asks for it.
 *
 * A rejection is a 200 with `status: "rejected"`, not an error status. "Dog is not a study goal"
 * is a normal answer from this endpoint: the request was well-formed and the system worked
 * exactly as intended. Reserving 4xx for actual client mistakes keeps that distinction useful.
 *
 * Elevated client because it may write a curriculum, which learners cannot do directly.
 */
export async function resolveCurriculum(req: Request, res: Response) {
    const body = req.body as z.infer<typeof resolveCurriculumSchema>;

    const service = new CurriculumService(
        claudeProvider(),
        new CurriculumRepository(adminDb)
    );

    sendOk(res, await service.resolve(body.goalText));
}

/** GET /api/v1/curricula/default — the syllabus offered before any goal is set. */
export async function getDefaultCurriculum(req: Request, res: Response) {
    const { accessToken } = authOf(req);

    const service = new CurriculumService(
        // No AI call on this path, so the learner-scoped client is enough and RLS applies.
        claudeProviderIfConfigured(),
        new CurriculumRepository(userDb(accessToken))
    );

    sendOk(res, await service.getDefault());
}

/**
 * The default-curriculum read never calls the model, but the service asks for a provider. Rather
 * than making the dependency optional and nullable everywhere, hand it one that throws if it is
 * ever actually used — a missing API key must not stop a learner reading the syllabus.
 */
function claudeProviderIfConfigured() {
    try {
        return claudeProvider();
    } catch {
        return {
            name: 'unconfigured',
            generateJson() {
                throw new Error('AI is not configured');
            },
            generateText() {
                throw new Error('AI is not configured');
            },
        } as never;
    }
}
