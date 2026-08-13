import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * The shell around every signed-in screen: a bar with the brand and a way out.
 *
 * The email is shown so it is obvious which account is in use during a demo, and truncated
 * because a long address should not push the sign-out button off a narrow screen.
 */
export function Layout({ children }: { children: ReactNode }) {
    const { session, signOut } = useAuth();
    const email = session?.user.email ?? '';

    return (
        <>
            <header className="topbar">
                <Link
                    to="/dashboard"
                    className="brand"
                    style={{ textDecoration: 'none', color: 'inherit' }}
                >
                    Adigam<span> AI</span>
                </Link>

                <div className="row" style={{ gap: 12 }}>
                    <Link to="/tutor" className="faint" style={{ textDecoration: 'none' }}>
                        Ask
                    </Link>
                    <Link to="/goals" className="faint" style={{ textDecoration: 'none' }}>
                        Goal
                    </Link>
                    <span
                        className="faint"
                        style={{
                            maxWidth: 160,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                        }}
                        title={email}
                    >
                        {email}
                    </span>
                    <button type="button" onClick={signOut}>
                        Sign out
                    </button>
                </div>
            </header>

            <main className="shell">{children}</main>
        </>
    );
}
