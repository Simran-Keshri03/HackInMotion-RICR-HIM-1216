import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last line of defence.
 *
 * A render error anywhere below this unmounts the whole tree and leaves a white screen —
 * exactly the failure the brief says must never happen. React only surfaces render errors to
 * a class component, so this is one of the few places a class is the right tool rather than a
 * stylistic choice.
 *
 * It catches render errors only. Failures inside event handlers and promises are handled per
 * screen by the states in components/Loading.
 */

interface Props {
    children: ReactNode;
}

interface State {
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        // Console is enough for a hackathon build; this is where a real error reporter would
        // be wired in.
        console.error('Render error:', error, info.componentStack);
    }

    render() {
        const { error } = this.state;

        if (!error) return this.props.children;

        return (
            <div className="shell">
                <div className="card stack">
                    <h2>This screen stopped working</h2>
                    <p className="muted">
                        Something in the page failed to render. Your progress is
                        saved — reloading will pick up where you left off.
                    </p>
                    <p className="faint mono">{error.message}</p>
                    <button
                        type="button"
                        className="primary"
                        onClick={() => window.location.reload()}
                    >
                        Reload
                    </button>
                </div>
            </div>
        );
    }
}
