import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { PlanAdjustment, StudyPlan as Plan } from '@/types/api';

/**
 * The plan: what to study, on which day, for how long.
 *
 * Today comes first and stays open, because that is the only day a learner can act on right now.
 * The rest is collapsed to a summary per day — a hundred and seventy-nine days rendered in full is
 * a document nobody reads, and scrolling past it to find today is worse than not having a plan.
 *
 * Every session carries the sentence the planner wrote for it. A plan a learner cannot interrogate
 * is a plan they will abandon the first time it asks for something that looks arbitrary.
 */

function todayIso(): string {
    return new Date().toISOString().slice(0, 10);
}

function describeMinutes(minutes: number): string {
    if (minutes < 60) return `${minutes} min`;

    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;

    return rest === 0 ? `${hours} hr` : `${hours} hr ${rest} min`;
}

/** "Thu 14 Aug" — short enough for a list, unambiguous enough to trust. */
function shortDate(iso: string): string {
    const date = new Date(`${iso}T00:00:00Z`);

    return date.toLocaleDateString(undefined, {
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        timeZone: 'UTC',
    });
}

export default function StudyPlan() {
    // The same read that returns the plan may also have rebuilt it: past sessions are settled and
    // the plan is re-checked server-side on every load, which is what makes re-planning automatic
    // rather than a button nobody presses.
    const plan = useApi<{ plan: Plan | null; adjustment: PlanAdjustment | null }>(() =>
        api.get<{ plan: Plan | null; adjustment: PlanAdjustment | null }>(
            '/study-plan/current'
        )
    );

    const [building, setBuilding] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showAll, setShowAll] = useState(false);

    async function build() {
        setError(null);
        setBuilding(true);

        try {
            const built = await api.post<{ plan: Plan }>('/study-plan/generate', {});
            plan.setData({ plan: built.plan, adjustment: null });
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : 'Could not build your plan.'
            );
        } finally {
            setBuilding(false);
        }
    }

    if (plan.loading) return <Loading label="Loading your plan…" />;
    if (plan.error) return <Failed error={plan.error} onRetry={plan.reload} />;

    const current = plan.data?.plan ?? null;
    const adjustment = plan.data?.adjustment ?? null;

    // ---------------------------------------------------------------- no plan yet
    if (!current) {
        return (
            <div className="stack">
                <div>
                    <span className="label">Study plan</span>
                    <h1>No plan yet</h1>
                </div>

                {error && <div className="banner banner--error">{error}</div>}

                <Empty title="Build a plan from your goal">
                    <p className="muted" style={{ margin: 0 }}>
                        Your time before the exam gets divided between your topics — the
                        weakest and heaviest ones get the most of it. Nothing is asked of
                        the AI here, so it is instant.
                    </p>
                    <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
                        No goal set yet? <Link to="/goals">Set one first.</Link>
                    </p>
                </Empty>

                <button
                    type="button"
                    className="primary wide"
                    disabled={building}
                    onClick={() => void build()}
                >
                    {building ? 'Building…' : 'Build my plan'}
                </button>
            </div>
        );
    }

    const today = todayIso();
    const todayPlan = current.days.find((day) => day.date === today) ?? null;

    const revisionCount = current.days.reduce(
        (total, day) =>
            total + day.sessions.filter((session) => session.kind === 'revise').length,
        0
    );
    const upcoming = current.days.filter((day) => day.date > today);
    const shown = showAll ? upcoming : upcoming.slice(0, 7);

    return (
        <div className="stack">
            <div className="spread">
                <div>
                    <span className="label">Study plan</span>
                    <h1>{describeMinutes(current.dailyMinutes)} a day</h1>
                </div>
                <button type="button" disabled={building} onClick={() => void build()}>
                    {building ? 'Rebuilding…' : 'Rebuild'}
                </button>
            </div>

            {error && <div className="banner banner--error">{error}</div>}

            {/* Shown when the app rebuilt the plan by itself. Framed as the plan adapting rather
                than as the learner failing — the point is that missing days is survivable, which is
                the opposite of what a wall of overdue sessions says. */}
            {adjustment && (
                <div className="banner">
                    <span className="label">
                        {adjustment.reason === 'missed_sessions'
                            ? 'Plan updated'
                            : 'Plan rebalanced'}
                    </span>
                    <p style={{ margin: '6px 0 0' }}>{adjustment.explanation}</p>
                </div>
            )}

            <div className="card card--accent">
                <span className="label">The whole plan</span>
                <div className="row" style={{ marginTop: 12, gap: 28 }}>
                    <div>
                        <div className="big">{current.daysRemaining}</div>
                        <div className="faint">days to the exam</div>
                    </div>
                    <div>
                        <div className="big">
                            {describeMinutes(current.totalMinutesPlanned)}
                        </div>
                        <div className="faint">planned</div>
                    </div>
                    <div>
                        <div className="big">{current.topicsCovered}</div>
                        <div className="faint">topics</div>
                    </div>
                </div>
                {revisionCount > 0 && (
                    <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                        Includes {revisionCount}{' '}
                        {revisionCount === 1 ? 'revision' : 'revisions'} of topics you
                        have already studied, so they do not fade before the exam.
                    </p>
                )}
                {current.version > 1 && (
                    <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                        Version {current.version} of your plan.
                    </p>
                )}
            </div>

            {/* Topics that did not fit are named rather than quietly dropped — a plan missing
                four of the learner's subjects should not look complete. */}
            {current.omittedTopics && current.omittedTopics.length > 0 && (
                <div className="banner">
                    <span className="label">Could not fit everything</span>
                    <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                        {current.omittedTopics.map((topic) => (
                            <li key={topic.name} className="faint">
                                <strong>{topic.name}</strong> — {topic.reason}
                            </li>
                        ))}
                    </ul>
                </div>
            )}

            {/* ------------------------------------------------ today */}
            <div className="card stack">
                <span className="label">Today · {shortDate(today)}</span>

                {todayPlan ? (
                    <>
                        {todayPlan.sessions.map((session) => (
                            <div key={session.id} className="option" aria-pressed={false}>
                                <span className="option__mark">
                                    {session.status === 'completed' ? '✓' : ''}
                                </span>
                                <span>
                                    {/* Revision is labelled ahead of the topic, not after it. A
                                        learner deciding what to do next needs to know this is
                                        something they already know coming back, not new ground —
                                        that changes how they approach it. */}
                                    {session.kind === 'revise' && (
                                        <span className="label">Revision · </span>
                                    )}
                                    <strong>{session.topicName}</strong>
                                    <span className="faint">
                                        {' — '}
                                        {describeMinutes(session.plannedMinutes)},{' '}
                                        {session.plannedQuestions} questions
                                    </span>
                                    {session.reason && (
                                        <div
                                            className="faint"
                                            style={{ marginTop: 4 }}
                                        >
                                            {session.reason}
                                        </div>
                                    )}
                                </span>
                            </div>
                        ))}

                        <Link to="/practice" className="primary wide" style={linkButton}>
                            Start today&rsquo;s session
                        </Link>
                    </>
                ) : (
                    <p className="muted" style={{ margin: 0 }}>
                        Nothing scheduled for today. Your plan starts on{' '}
                        {shortDate(current.days[0]?.date ?? today)}.
                    </p>
                )}
            </div>

            {/* ------------------------------------------------ what comes next */}
            {upcoming.length > 0 && (
                <div className="card stack" style={{ gap: 8 }}>
                    <span className="label">Coming up</span>

                    {shown.map((day) => (
                        <div key={day.date} className="spread">
                            <span className="faint">{shortDate(day.date)}</span>
                            <span>
                                {day.sessions
                                    .map((session) => session.topicName)
                                    .join(', ')}
                                <span className="faint">
                                    {' — '}
                                    {describeMinutes(day.totalMinutes)}
                                </span>
                            </span>
                        </div>
                    ))}

                    {upcoming.length > shown.length && (
                        <button type="button" onClick={() => setShowAll(true)}>
                            Show all {upcoming.length} remaining days
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/** A Link that has to look like the primary button next to it. */
const linkButton = {
    display: 'block',
    textAlign: 'center' as const,
    textDecoration: 'none',
};
