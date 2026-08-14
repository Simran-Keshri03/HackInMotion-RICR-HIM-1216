import type { Session } from '@supabase/auth-js';
import { type ReactNode, createContext, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';

/**
 * Who is signed in.
 *
 * Supabase owns the session: it persists it, refreshes it, and tells us when it changes.
 * This provider does nothing more than expose it to React, so there is no second copy of
 * auth state to drift out of sync.
 *
 * `loading` matters more than it looks. Without it the app renders the login screen for a
 * moment on every reload while the stored session is being read, which makes an already
 * signed-in learner think they were logged out.
 */

interface AuthState {
    session: Session | null;
    loading: boolean;
    signIn: (email: string, password: string) => Promise<void>;
    signUp: (
        email: string,
        password: string,
        displayName: string
    ) => Promise<{ needsEmailConfirm: boolean }>;
    /** Google, GitHub or Microsoft. Redirects away from the app and comes back with a session. */
    signInWithProvider: (provider: OAuthProvider) => Promise<void>;
    signOut: () => Promise<void>;
}

/**
 * The providers the sign-in screen offers.
 *
 * Each one has to be switched on in the Supabase dashboard with a client id and secret from the
 * provider's own console — there is no way to configure that from code. Until a provider is enabled
 * Supabase answers with "Unsupported provider", which is why `signInWithProvider` translates that
 * into something a person can act on instead of letting it surface raw.
 */
export type OAuthProvider = 'google' | 'github' | 'azure';

const LABELS: Record<OAuthProvider, string> = {
    google: 'Google',
    github: 'GitHub',
    azure: 'Microsoft',
};

/**
 * Checks the authorize URL before sending the browser to it.
 *
 * This exists because of how `signInWithOAuth` actually behaves, which is not how it reads.
 * It performs **no network request** — it builds the authorize URL and navigates, returning no error
 * whether the provider is configured or not. So a provider that is switched off produces no client
 * error at all: the browser leaves the app, Supabase answers the navigation with
 * `400 {"msg":"Unsupported provider: provider is not enabled"}`, and the learner is left staring at
 * raw JSON on a page that is no longer ours. The catch block that was supposed to explain this could
 * never run.
 *
 * `redirect: 'manual'` is what makes the two cases distinguishable. A configured provider answers
 * with a redirect to Google or GitHub, which fetch surfaces as an opaque response — `type` of
 * `'opaqueredirect'` and status 0. An unconfigured one answers 400 with a readable body. So an opaque
 * response means "this will work" and a real status means "it will not".
 *
 * Fails open. If the check itself cannot run — offline, a blocked request — the navigation is allowed
 * rather than refused: being wrong by letting somebody try is better than being wrong by telling them
 * a working button is broken.
 */
async function providerIsEnabled(authorizeUrl: string): Promise<boolean> {
    try {
        const response = await fetch(authorizeUrl, {
            method: 'GET',
            redirect: 'manual',
        });

        if (response.type === 'opaqueredirect') return true;

        return response.status < 400;
    } catch {
        return true;
    }
}

/**
 * Turns the two sign-up failures people actually hit into sentences they can act on.
 *
 * Both are configuration rather than mistakes, so the raw message sends somebody looking for a
 * problem with what they typed.
 *
 * **Rate limit.** Supabase's built-in mailer sends only a couple of messages an hour on the free
 * tier, so the third sign-up of a session fails with "email rate limit exceeded" — nothing to do with
 * the address. The real fix is switching confirmation off or attaching real SMTP, neither of which is
 * a thing the person at the keyboard can do, so the message says what happened and offers the way
 * round it.
 *
 * **Rejected domain.** Supabase validates the domain, so invented ones like `@adigam-demo.com` are
 * refused as "invalid" even though the address is well-formed.
 */
function friendlySignUpError(message: string): string {
    if (/rate limit/i.test(message)) {
        return 'Too many sign-up emails have been sent from this project in the last hour. Wait a while, or sign in with an account that already exists.';
    }

    if (/email address .* is invalid|invalid email/i.test(message)) {
        return 'That email address was refused. Use a real address — made-up domains are rejected.';
    }

    return message;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let active = true;

        // Read the stored session once, then follow every change.
        supabase.auth.getSession().then(({ data }) => {
            if (!active) return;
            setSession(data.session);
            setLoading(false);
        });

        const { data } = supabase.auth.onAuthStateChange((_event, next) => {
            setSession(next);
            setLoading(false);
        });

        return () => {
            active = false;
            data.subscription.unsubscribe();
        };
    }, []);

    const value = useMemo<AuthState>(
        () => ({
            session,
            loading,

            async signIn(email, password) {
                const { error } = await supabase.auth.signInWithPassword({
                    email,
                    password,
                });
                if (error) throw new Error(error.message);
            },

            async signUp(email, password, displayName) {
                const { data, error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        /**
                         * `full_name`, not `display_name`.
                         *
                         * The `handle_new_user` trigger on auth.users reads
                         * `raw_user_meta_data ->> 'full_name'` into `profiles.display_name`, and that
                         * key was chosen because it is what OAuth providers send. Matching it means
                         * the name reaches the profile with no migration and by the same path for
                         * both routes in — which matters because with email confirmation on there is
                         * no session after sign-up, so there is no token to PATCH the profile with
                         * afterwards. The trigger is the only chance to record it.
                         */
                        data: { full_name: displayName.trim() },
                    },
                });
                if (error) throw new Error(friendlySignUpError(error.message));

                // With email confirmation switched on, Supabase creates the user but no
                // session. The caller needs to know, or the screen looks broken.
                return { needsEmailConfirm: data.session === null };
            },

            async signInWithProvider(provider) {
                const { data, error } = await supabase.auth.signInWithOAuth({
                    provider,
                    options: {
                        // Back to where they started. Supabase also needs this exact URL in its
                        // allowed redirect list, or it silently sends them to the site root.
                        redirectTo: `${window.location.origin}/dashboard`,
                        // Hand back the URL instead of navigating, so it can be checked first. See
                        // the comment on `providerIsEnabled` for why that check has to exist.
                        skipBrowserRedirect: true,
                    },
                });

                if (error) throw new Error(error.message);
                if (!data?.url) throw new Error('Could not start sign-in. Try again.');

                if (!(await providerIsEnabled(data.url))) {
                    throw new Error(
                        `${LABELS[provider]} sign-in is not switched on for this project yet — it needs a client ID and secret adding in the Supabase dashboard. Use your email and password for now.`
                    );
                }

                // Assigning to href rather than using the router: the destination is another origin.
                window.location.href = data.url;
            },

            async signOut() {
                await supabase.auth.signOut();
            },
        }),
        [session, loading]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
    const context = useContext(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used inside AuthProvider');
    }
    return context;
}
