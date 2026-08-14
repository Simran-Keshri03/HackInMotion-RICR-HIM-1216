import type { Request, Response } from 'express';
import { z } from 'zod';
import { userDb } from '@/config/database.js';
import { authOf } from '@/middleware/authMiddleware.js';
import { AppError, sendOk } from '@/utils/http.js';

/**
 * The learner's own profile: what to call them, and which timezone their days are in.
 *
 * Both endpoints use the **learner-scoped** client, not the elevated one, and that is the interesting
 * part. `profiles` grants `authenticated` UPDATE on exactly four columns — display_name, avatar_url,
 * timezone, settings — and nothing else. So the database itself refuses to let this request touch
 * `id`, `email`, or anybody else's row, whatever this code does. The validation below is the polite
 * layer that produces a readable 400; the column grant is the layer that actually holds.
 */

export const updateProfileSchema = z
    .object({
        displayName: z.string().trim().min(1).max(60).optional(),
        /**
         * An IANA zone name. Checked against the platform's own timezone database rather than a
         * hand-written list — a stored zone this server cannot format is a zone that silently breaks
         * every streak and revision date for that learner.
         */
        timezone: z
            .string()
            .trim()
            .max(60)
            .refine(isKnownTimezone, 'is not a timezone this server recognises')
            .optional(),
    })
    // A PATCH with nothing in it is a client bug, and answering 200 to it hides that.
    .refine(
        (body) => body.displayName !== undefined || body.timezone !== undefined,
        'send a displayName or a timezone'
    );

function isKnownTimezone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat('en-CA', { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** GET /api/v1/learner/profile */
export async function getProfile(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);

    const { data, error } = await userDb(accessToken)
        .from('profiles')
        .select('display_name, email, timezone, created_at')
        .eq('id', userId)
        .maybeSingle();

    if (error) throw error;

    if (!data) {
        // The row is created by a trigger on sign-up, so its absence means something is wrong with
        // the account rather than with this request.
        throw new AppError(404, 'PROFILE_NOT_FOUND', 'Your profile could not be loaded.');
    }

    sendOk(res, {
        profile: {
            displayName: (data.display_name as string | null) ?? null,
            email: data.email as string,
            timezone: (data.timezone as string | null) ?? 'Asia/Kolkata',
            createdAt: data.created_at as string,
        },
    });
}

/** PATCH /api/v1/learner/profile */
export async function updateProfile(req: Request, res: Response) {
    const { userId, accessToken } = authOf(req);
    const body = req.body as z.infer<typeof updateProfileSchema>;

    const patch: Record<string, string> = {};
    if (body.displayName !== undefined) patch.display_name = body.displayName;
    if (body.timezone !== undefined) patch.timezone = body.timezone;

    const { data, error } = await userDb(accessToken)
        .from('profiles')
        .update(patch)
        .eq('id', userId)
        .select('display_name, email, timezone, created_at')
        .single();

    if (error) throw error;

    sendOk(res, {
        profile: {
            displayName: (data.display_name as string | null) ?? null,
            email: data.email as string,
            timezone: (data.timezone as string | null) ?? 'Asia/Kolkata',
            createdAt: data.created_at as string,
        },
    });
}
