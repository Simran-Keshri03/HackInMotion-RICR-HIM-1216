import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * Sign in or create an account.
 *
 * One form for both, because the fields are identical and two screens for two buttons is
 * needless. Nothing here touches the API directly — Supabase owns the credentials, and
 * AuthProvider owns the session.
 */
export default function Login() {
    const { signIn, signUp } = useAuth();
    const navigate = useNavigate();

    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        setNotice(null);
        setBusy(true);

        try {
            if (mode === 'signin') {
                await signIn(email, password);
                navigate('/dashboard', { replace: true });
                return;
            }

            const { needsEmailConfirm } = await signUp(email, password);

            if (needsEmailConfirm) {
                // Supabase created the account but issued no session. Without saying so, the
                // screen would look like nothing happened.
                setNotice(
                    'Account created. Check your email for a confirmation link, then sign in.'
                );
                setMode('signin');
            } else {
                navigate('/dashboard', { replace: true });
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not sign in.');
        } finally {
            setBusy(false);
        }
    }

    const isSignIn = mode === 'signin';

    return (
        <div className="shell" style={{ maxWidth: 400, paddingTop: 56 }}>
            <div className="stack">
                <div>
                    <h1 className="brand" style={{ fontSize: '1.75rem' }}>
                        Adigam<span> AI</span>
                    </h1>
                    <p className="muted">
                        Practice that adapts to what you actually know.
                    </p>
                </div>

                <form className="card stack" onSubmit={handleSubmit}>
                    <h2>{isSignIn ? 'Sign in' : 'Create an account'}</h2>

                    {notice && <div className="banner banner--good">{notice}</div>}
                    {error && <div className="banner banner--error">{error}</div>}

                    <div className="field">
                        <label htmlFor="email">Email</label>
                        <input
                            id="email"
                            type="email"
                            value={email}
                            autoComplete="email"
                            required
                            onChange={(e) => setEmail(e.target.value)}
                        />
                    </div>

                    <div className="field">
                        <label htmlFor="password">Password</label>
                        <input
                            id="password"
                            type="password"
                            value={password}
                            // Tells the browser's password manager which flow this is.
                            autoComplete={
                                isSignIn ? 'current-password' : 'new-password'
                            }
                            required
                            minLength={8}
                            onChange={(e) => setPassword(e.target.value)}
                        />
                        {!isSignIn && (
                            <span className="faint">At least 8 characters.</span>
                        )}
                    </div>

                    <button
                        type="submit"
                        className="primary wide"
                        disabled={busy}
                    >
                        {busy
                            ? 'Working…'
                            : isSignIn
                              ? 'Sign in'
                              : 'Create account'}
                    </button>

                    <div className="faint" style={{ textAlign: 'center' }}>
                        {isSignIn ? 'New here? ' : 'Already have an account? '}
                        <button
                            type="button"
                            className="link"
                            onClick={() => {
                                setMode(isSignIn ? 'signup' : 'signin');
                                setError(null);
                                setNotice(null);
                            }}
                        >
                            {isSignIn ? 'Create an account' : 'Sign in'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
