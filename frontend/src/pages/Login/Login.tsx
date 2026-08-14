import { type FormEvent, useState } from 'react';
import { Icon, Logo } from '@/components/Icon/Icon';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * Sign in, or create an account.
 *
 * One screen, two modes. A separate `/signup` route would double the layout for a form that differs
 * by one field and one button label, and somebody who lands on the wrong one has to navigate rather
 * than toggle.
 *
 * Three things here are worth knowing before reading the code:
 *
 * **The demo credentials are gone from this screen.** They were a hint on the sign-in box, which is
 * fine while an app is being built and is a published password once anybody else can reach it. The
 * demo account still exists and still works — it is simply not advertised.
 *
 * **Sign-up may not sign you in.** With email confirmation switched on, Supabase creates the account
 * and returns no session. Left unhandled the screen looks like the button did nothing, so that state
 * is a message of its own.
 *
 * **There are no social sign-in buttons.** Google, GitHub and Microsoft were built and then removed:
 * every provider needs a client id and secret entered in the Supabase dashboard, and
 * `GET /auth/v1/settings` on this project reports `email` as the only enabled method. Three buttons
 * that answer "that is not switched on yet" are worse than no buttons — they read as a broken app
 * rather than a product that signs you in with a password.
 *
 * `signInWithProvider` is still in AuthProvider, unused, with its pre-flight check. Re-adding a
 * button is a few lines if a provider is ever enabled; rewriting the working part would not be.
 */

type Mode = 'signin' | 'signup';

const FEATURES = [
    {
        icon: 'target',
        tile: 'tile--blue',
        title: 'Adaptive practice',
        body: 'Questions follow your mastery, so you spend time where it changes something.',
    },
    {
        icon: 'chart',
        tile: 'tile--green',
        title: 'Honest progress',
        body: 'A mastery score with the evidence behind it, not a badge for turning up.',
    },
    {
        icon: 'calendar',
        tile: 'tile--violet',
        title: 'A plan that adapts',
        body: 'Miss a few days and the plan rebuilds around the time you have left.',
    },
] as const;

export default function Login() {
    const { signIn, signUp } = useAuth();

    const [mode, setMode] = useState<Mode>('signin');
    const [name, setName] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);

    function switchMode(next: Mode) {
        setMode(next);
        if (next === 'signin') setName('');
        // Errors belong to the attempt that produced them. Carrying "wrong password" across to the
        // sign-up form would be nonsense.
        setError(null);
        setNotice(null);
    }

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (busy) return;

        setError(null);
        setNotice(null);
        setBusy(true);

        try {
            if (mode === 'signup') {
                const { needsEmailConfirm } = await signUp(email.trim(), password, name);

                if (needsEmailConfirm) {
                    setNotice(
                        `Account created. Check ${email.trim()} for a confirmation link, then sign in.`
                    );
                    setMode('signin');
                    setPassword('');
                }
                // When confirmation is off, a session arrives and the router moves on by itself.
            } else {
                await signIn(email.trim(), password);
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.');
        } finally {
            setBusy(false);
        }
    }

    const canSubmit =
        email.trim() !== '' &&
        password.length >= 6 &&
        // Only sign-up needs the name. Requiring it to sign in would lock out everybody who made an
        // account before the field existed.
        (mode === 'signin' || name.trim().length >= 2);

    return (
        <div className="authpage">
            <div className="authpage__inner">
                {/* ---------------------------------------------- pitch */}
                <div className="authpitch">
                    <div className="row" style={{ gap: 10 }}>
                        <Logo size={30} />
                        <span className="brand" style={{ fontSize: '1.35rem' }}>
                            Adigam<span> AI</span>
                        </span>
                    </div>

                    <div>
                        <h1 className="authpitch__title">
                            Smarter practice.
                            <br />
                            <span className="authpitch__accent">Stronger you.</span>
                        </h1>
                        <p className="muted" style={{ maxWidth: '46ch' }}>
                            Adaptive learning and a study planner that works out what to give you
                            next — and tells you why it chose it.
                        </p>
                    </div>

                    <div className="stack" style={{ gap: 16 }}>
                        {FEATURES.map((feature) => (
                            <div
                                key={feature.title}
                                className="row"
                                style={{ gap: 12, alignItems: 'flex-start' }}
                            >
                                <span className={`tile ${feature.tile}`}>
                                    <Icon name={feature.icon} />
                                </span>
                                <div style={{ minWidth: 0 }}>
                                    <strong style={{ fontSize: '0.95rem' }}>{feature.title}</strong>
                                    <div className="faint">{feature.body}</div>
                                </div>
                            </div>
                        ))}
                    </div>
                </div>

                {/* ---------------------------------------------- form */}
                <div className="authcard">
                    <div>
                        <h2 style={{ margin: 0 }}>
                            {mode === 'signin' ? 'Welcome back' : 'Create your account'}
                        </h2>
                        <p className="muted" style={{ margin: '6px 0 0' }}>
                            {mode === 'signin'
                                ? 'Sign in to continue your learning journey.'
                                : 'A few seconds, and the first plan is yours.'}
                        </p>
                    </div>

                    {error && <div className="banner banner--error">{error}</div>}
                    {notice && <div className="banner">{notice}</div>}

                    <form className="stack" onSubmit={submit}>
                        {/* Asked for at sign-up rather than left to Settings.
                            It is one field at the only moment somebody is already filling a form, and
                            without it their first sight of the app is a dashboard that greets nobody —
                            `profiles.display_name` starts null and the greeting has nothing to use.
                            It also cannot be collected later in this flow: with email confirmation on
                            there is no session after sign-up, so there is no token to save it with. */}
                        {mode === 'signup' && (
                            <div className="field">
                                <label htmlFor="name">Your name</label>
                                <div className="inputwrap">
                                    <span className="inputwrap__icon">
                                        <Icon name="users" size={16} />
                                    </span>
                                    <input
                                        id="name"
                                        type="text"
                                        autoComplete="name"
                                        placeholder="Ayush"
                                        maxLength={60}
                                        value={name}
                                        disabled={busy}
                                        required
                                        onChange={(e) => setName(e.target.value)}
                                    />
                                </div>
                                <span className="faint">
                                    This is what the app calls you, and what your study group sees.
                                </span>
                            </div>
                        )}

                        <div className="field">
                            <label htmlFor="email">Email address</label>
                            <div className="inputwrap">
                                <span className="inputwrap__icon">
                                    <Icon name="mail" size={16} />
                                </span>
                                <input
                                    id="email"
                                    type="email"
                                    autoComplete="email"
                                    placeholder="you@example.com"
                                    value={email}
                                    disabled={busy}
                                    required
                                    onChange={(e) => setEmail(e.target.value)}
                                />
                            </div>
                        </div>

                        <div className="field">
                            <label htmlFor="password">Password</label>
                            <div className="inputwrap">
                                <span className="inputwrap__icon">
                                    <Icon name="lock" size={16} />
                                </span>
                                <input
                                    id="password"
                                    type={showPassword ? 'text' : 'password'}
                                    // Tells a password manager whether to offer a saved password or
                                    // to generate one. Getting this wrong is why so many sign-up
                                    // forms fight the browser.
                                    autoComplete={
                                        mode === 'signup' ? 'new-password' : 'current-password'
                                    }
                                    placeholder="Enter your password"
                                    value={password}
                                    disabled={busy}
                                    required
                                    minLength={6}
                                    onChange={(e) => setPassword(e.target.value)}
                                />
                                <button
                                    type="button"
                                    className="inputwrap__action"
                                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                                    onClick={() => setShowPassword((v) => !v)}
                                >
                                    <Icon name={showPassword ? 'eyeOff' : 'eye'} size={16} />
                                </button>
                            </div>
                            {mode === 'signup' && (
                                <span className="faint">At least 6 characters.</span>
                            )}
                        </div>

                        <button
                            type="submit"
                            className="primary wide"
                            disabled={busy || !canSubmit}
                        >
                            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
                        </button>
                    </form>

                    <p className="faint" style={{ margin: 0, textAlign: 'center' }}>
                        {mode === 'signin' ? (
                            <>
                                New here?{' '}
                                <button
                                    type="button"
                                    className="linkish"
                                    onClick={() => switchMode('signup')}
                                >
                                    Create an account
                                </button>
                            </>
                        ) : (
                            <>
                                Already have an account?{' '}
                                <button
                                    type="button"
                                    className="linkish"
                                    onClick={() => switchMode('signin')}
                                >
                                    Sign in
                                </button>
                            </>
                        )}
                    </p>
                </div>
            </div>

            <footer className="authfoot">
                <span className="faint">
                    © {new Date().getFullYear()} Adigam AI. Adaptive Learning &amp; Personalized
                    Study Planner.
                </span>
            </footer>
        </div>
    );
}
