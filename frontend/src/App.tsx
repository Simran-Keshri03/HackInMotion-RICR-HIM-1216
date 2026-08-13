import { BrowserRouter } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary/ErrorBoundary';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { AppRoutes } from '@/router';

/**
 * The three things that wrap the whole app, outermost first:
 *   ErrorBoundary  so a render failure shows a message instead of a white screen
 *   AuthProvider   so every screen and the API client can reach the session
 *   BrowserRouter  so routing works
 *
 * ErrorBoundary is outside the others deliberately: if AuthProvider itself throws, something
 * still catches it.
 */
export default function App() {
    return (
        <ErrorBoundary>
            <AuthProvider>
                <BrowserRouter>
                    <AppRoutes />
                </BrowserRouter>
            </AuthProvider>
        </ErrorBoundary>
    );
}
