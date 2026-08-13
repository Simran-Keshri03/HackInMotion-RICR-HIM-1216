import type { Session } from '@supabase/auth-js';
import {
    type ReactNode,
    createContext,
    useContext,
    useEffect,
    useMemo,
    useState,
} from 'react';
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
    signUp: (email: string, password: string) => Promise<{ needsEmailConfirm: boolean }>;
    signOut: () => Promise<void>;
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

            async signUp(email, password) {
                const { data, error } = await supabase.auth.signUp({ email, password });
                if (error) throw new Error(error.message);

                // With email confirmation switched on, Supabase creates the user but no
                // session. The caller needs to know, or the screen looks broken.
                return { needsEmailConfirm: data.session === null };
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
