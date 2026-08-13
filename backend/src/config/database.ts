import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/config/environment.js';

/**
 * Two clients, on purpose.
 *
 * adminDb  holds the secret key and bypasses RLS entirely. Use it only where elevated
 *          rights are genuinely needed: grading an answer against the correct answer,
 *          writing attempts, updating mastery. Every query through it must filter by
 *          user id by hand, because nothing else will.
 *
 * userDb   acts as the signed-in learner, so RLS applies exactly as it would in the
 *          browser. Use it for reads. If a query here forgets its user filter, the
 *          database still refuses to return somebody else's rows.
 *
 * The point of the split is that the dangerous client is used in few, obvious places,
 * and the everyday one cannot leak data even when the code above it has a bug.
 */

const clientOptions = {
    auth: {
        // A server has no browser session to persist or refresh.
        persistSession: false,
        autoRefreshToken: false,
    },
};

export const adminDb: SupabaseClient = createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SECRET_KEY,
    clientOptions
);

/** A client scoped to one learner's access token. RLS decides what it can see. */
export function userDb(accessToken: string): SupabaseClient {
    return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
        ...clientOptions,
        global: {
            headers: { Authorization: `Bearer ${accessToken}` },
        },
    });
}
