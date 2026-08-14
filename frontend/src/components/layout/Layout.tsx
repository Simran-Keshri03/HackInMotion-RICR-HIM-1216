import { type ReactNode, useEffect, useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { Icon, type IconName, Logo } from '@/components/Icon/Icon';
import { useAuth } from '@/features/auth/AuthProvider';

/**
 * The shell around every signed-in screen: top bar, left sidebar, workspace.
 *
 * The sidebar is a real column above 900px and a slide-over below it, from the same markup — one
 * layout with a breakpoint rather than two navs that drift apart. The top bar keeps the four things
 * a learner reaches for constantly; the sidebar holds everything.
 *
 * **Every item goes to a different real screen.** Placeholders for unbuilt ones — Mock Tests,
 * Analytics, Bookmarks, Notes — were here briefly, greyed out and labelled "Soon", and were removed:
 * a nav list that is half real reads as a product with broken links.
 *
 * An "Achievements" item pointing at the dashboard was removed for the same reason in a subtler coat.
 * The badge shelf and the progress numbers *are* the dashboard, so a second entry to the same place
 * would both duplicate a destination and light two items up at once. Where a thing lives is the
 * honest answer to where it lives.
 */

interface NavItem {
    label: string;
    icon: IconName;
    to: string;
}

const LEARNING: NavItem[] = [
    { label: 'Dashboard', icon: 'grid', to: '/dashboard' },
    { label: 'Practice', icon: 'code', to: '/practice' },
    { label: 'Mock Tests', icon: 'file', to: '/mock-tests' },
    { label: 'Study Plan', icon: 'calendar', to: '/plan' },
    { label: 'Ask Adigam', icon: 'sparkles', to: '/tutor' },
    { label: 'Groups', icon: 'users', to: '/groups' },
    { label: 'Your Goal', icon: 'target', to: '/goals' },
    { label: 'Settings', icon: 'settings', to: '/settings' },
];

/** The handful worth reaching without opening the sidebar. */
const TOP: { label: string; to: string }[] = [
    { label: 'Plan', to: '/plan' },
    { label: 'Group', to: '/groups' },
    { label: 'Ask', to: '/tutor' },
    { label: 'Goal', to: '/goals' },
];

export function Layout({ children }: { children: ReactNode }) {
    const { session, signOut } = useAuth();
    const email = session?.user.email ?? '';
    const location = useLocation();

    const [drawerOpen, setDrawerOpen] = useState(false);

    // Close the drawer on navigation. Without this it stays open over the page somebody just asked
    // for, which reads as the tap not having worked.
    useEffect(() => setDrawerOpen(false), [location.pathname]);

    // Escape closes it, because a slide-over that traps you is worse than no slide-over.
    useEffect(() => {
        if (!drawerOpen) return;

        const onKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setDrawerOpen(false);
        };

        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [drawerOpen]);

    return (
        <>
            <header className="topbar">
                <div className="row" style={{ gap: 10 }}>
                    <button
                        type="button"
                        className="topbar__burger"
                        aria-label="Open menu"
                        aria-expanded={drawerOpen}
                        onClick={() => setDrawerOpen(true)}
                    >
                        <Icon name="menu" size={20} />
                    </button>

                    <Link to="/dashboard" className="brand row" style={{ gap: 9 }}>
                        <Logo />
                        <span>
                            Adigam<span> AI</span>
                        </span>
                    </Link>
                </div>

                <nav className="topnav" aria-label="Main">
                    {TOP.map((item) => (
                        <NavLink
                            key={item.to}
                            to={item.to}
                            className={({ isActive }) =>
                                isActive
                                    ? 'topnav__link topnav__link--active'
                                    : 'topnav__link'
                            }
                        >
                            {item.label}
                        </NavLink>
                    ))}
                </nav>

                <div className="topbar__account">
                    <span className="faint topbar__email" title={email}>
                        {email}
                    </span>
                    {/* Initial rather than a photo: there are no avatar uploads, and a real initial
                        beats a generic silhouette. */}
                    <span className="avatar avatar--sm" aria-hidden="true">
                        {(email[0] ?? '?').toUpperCase()}
                    </span>
                    <button type="button" className="primary" onClick={signOut}>
                        Sign out
                    </button>
                </div>
            </header>

            <div className="shellgrid">
                {drawerOpen && (
                    <button
                        type="button"
                        className="scrim"
                        aria-label="Close menu"
                        onClick={() => setDrawerOpen(false)}
                    />
                )}

                <aside className="sidebar" data-open={drawerOpen}>
                    <div className="sidebar__group">
                        <div className="spread">
                            <span className="sidebar__heading">Learning</span>
                            <button
                                type="button"
                                className="sidebar__close"
                                aria-label="Close menu"
                                onClick={() => setDrawerOpen(false)}
                            >
                                <Icon name="close" size={18} />
                            </button>
                        </div>

                        {LEARNING.map((item) => (
                            <NavLink
                                key={item.label}
                                to={item.to}
                                className={({ isActive }) =>
                                    isActive
                                        ? 'sidebar__link sidebar__link--active'
                                        : 'sidebar__link'
                                }
                            >
                                <Icon name={item.icon} />
                                {item.label}
                            </NavLink>
                        ))}
                    </div>
                </aside>

                <main className="workspace">{children}</main>
            </div>
        </>
    );
}
