import { AuthClient } from '@supabase/auth-js';

/**
 * The browser's auth client.
 *
 * Deliberately `@supabase/auth-js` and not the full `@supabase/supabase-js`. All this app
 * needs from Supabase is sign-in, sign-up, sign-out and the session — every piece of data
 * comes from our own API. The full client additionally bundles postgrest, realtime
 * (websockets), storage and edge-function clients, none of which this app calls, and together
 * they roughly doubled the gzipped bundle. On a 2GB Android phone over a slow connection that
 * is not an acceptable price for code that never runs.
 *
 * Only the publishable key is here, which is fine: it is compiled into the bundle and meant to
 * be public. It grants nothing on its own — every table is behind Row Level Security, which
 * needs a signed-in learner's token. The secret key never appears in the frontend at all; it
 * lives in the backend's environment.
 */

const url = import.meta.env.VITE_SUPABASE_URL;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishableKey) {
    // Fail loudly at startup rather than with a confusing error on the first request.
    throw new Error(
        'Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy frontend/.env.example to frontend/.env.'
    );
}

const auth = new AuthClient({
    // The paths supabase-js would have built for us.
    url: `${url}/auth/v1`,
    headers: { apikey: publishableKey, Authorization: `Bearer ${publishableKey}` },
    // Keep the session in localStorage and refresh it in the background, exactly as the full
    // client does, so a learner stays signed in across reloads.
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
});

/**
 * Shaped like `supabase.auth` so call sites read the same as they would with the full client,
 * and so swapping back is a one-file change if the browser ever needs direct table reads.
 */
export const supabase = { auth };
