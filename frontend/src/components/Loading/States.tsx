import type { ReactElement, ReactNode } from 'react';
import { ApiError } from '@/lib/api';

/**
 * The three states every screen needs, in one place.
 *
 * The brief asks for loading, empty and error states with a retry option, and a screen that
 * forgets one of them shows a learner a blank page. Keeping them here means each page writes
 * them once and none of them can drift.
 */

export function Loading({ label = 'Loading…' }: { label?: string }): ReactElement {
    return (
        <div className="state">
            <div className="spinner" />
            {label}
        </div>
    );
}

/**
 * Nothing to show, but nothing is wrong. Distinct from an error on purpose: a learner with
 * no attempts yet has not hit a problem, and telling them so would be misleading.
 */
export function Empty({
    title,
    children,
    action,
}: {
    title: string;
    children?: ReactNode;
    action?: ReactNode;
}): ReactElement {
    return (
        <div className="state">
            <h3 style={{ color: 'var(--text)' }}>{title}</h3>
            {children}
            {action && <div style={{ marginTop: 14 }}>{action}</div>}
        </div>
    );
}

/**
 * Something failed. Retry is offered only when trying again could plausibly work — a network
 * drop or a server error, not a 400. An always-visible retry button on a permanent failure
 * teaches learners the button does nothing.
 */
export function Failed({
    error,
    onRetry,
}: {
    error: unknown;
    onRetry?: () => void;
}): ReactElement {
    const apiError = error instanceof ApiError ? error : null;
    const message =
        apiError?.message ??
        (error instanceof Error ? error.message : 'Something went wrong.');

    // Unknown errors get a retry too: we cannot rule out that they are transient.
    const canRetry = onRetry && (apiError === null || apiError.retryable);

    return (
        <div className="state">
            <div className="banner banner--error" style={{ textAlign: 'left' }}>
                {message}
            </div>

            {canRetry && (
                <button
                    type="button"
                    onClick={onRetry}
                    style={{ marginTop: 14 }}
                >
                    Try again
                </button>
            )}
        </div>
    );
}
