import { Suspense, lazy } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { Loading } from '@/components/Loading/States';
import { useAuth } from '@/features/auth/AuthProvider';
import { Layout } from '@/components/layout/Layout';

/**
 * Routing, with each page in its own chunk.
 *
 * `lazy` is the point: a learner opening the login screen downloads the login screen, not the
 * dashboard and the practice engine as well. On a slow connection that is the difference
 * between a usable first load and a blank wait.
 */

const Login = lazy(() => import('@/pages/Login/Login'));
const Dashboard = lazy(() => import('@/pages/Dashboard/Dashboard'));
const Practice = lazy(() => import('@/pages/Practice/Practice'));
const LearningGoals = lazy(() => import('@/pages/LearningGoals/LearningGoals'));

/**
 * Everything behind this needs a session.
 *
 * `loading` has to be handled separately from "no session": while the stored session is being
 * read, session is null but the learner is not signed out. Redirecting on that would bounce an
 * authenticated learner to the login screen on every reload.
 */
function RequireAuth() {
    const { session, loading } = useAuth();

    if (loading) return <Loading label="Checking your session…" />;
    if (!session) return <Navigate to="/login" replace />;

    return (
        <Layout>
            <Outlet />
        </Layout>
    );
}

/** The login screen is pointless once signed in. */
function RedirectIfSignedIn({ children }: { children: React.ReactNode }) {
    const { session, loading } = useAuth();

    if (loading) return <Loading />;
    if (session) return <Navigate to="/dashboard" replace />;

    return <>{children}</>;
}

export function AppRoutes() {
    return (
        <Suspense fallback={<Loading />}>
            <Routes>
                <Route
                    path="/login"
                    element={
                        <RedirectIfSignedIn>
                            <Login />
                        </RedirectIfSignedIn>
                    }
                />

                <Route element={<RequireAuth />}>
                    <Route path="/dashboard" element={<Dashboard />} />
                    <Route path="/practice" element={<Practice />} />
                    <Route path="/goals" element={<LearningGoals />} />
                </Route>

                {/* Anything unknown goes to the dashboard, which itself redirects to login
                    when there is no session. One rule, no 404 screen to build. */}
                <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
        </Suspense>
    );
}
