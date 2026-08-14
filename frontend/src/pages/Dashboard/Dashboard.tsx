import { Link, useNavigate } from 'react-router-dom';
import { ActivityHeatmap } from '@/components/Activity/ActivityHeatmap';
import { Icon } from '@/components/Icon/Icon';
import { Badges } from '@/components/Activity/Badges';
import { Empty, Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type {
    ActivityResponse,
    Goal,
    LearnerProfile,
    LearnerSummary,
    NextSession,
} from '@/types/api';

/**
 * The dashboard leads with what to do, not with what happened.
 *
 * Charts tell a learner their accuracy is 61% and leave them to work out the implication. The
 * "do this next" card is the product: one instruction, and the engine's own sentence
 * explaining why it chose that instruction. The numbers come after.
 */

const ACTION_LABELS: Record<string, string> = {
    learn_new: 'Start something new',
    practice: 'Practise',
    revise: 'Revise',
    mini_test: 'Quick test',
};

export default function Dashboard() {
    const navigate = useNavigate();

    // Two independent requests. If the summary fails the recommendation can still render, and
    // vice versa — one slow endpoint should not blank the whole screen.
    const summary = useApi<LearnerSummary>(() => api.get<LearnerSummary>('/learner/summary'));
    const session = useApi<NextSession>(() => api.get<NextSession>('/recommendations/next'));
    // Whether a goal exists changes what the empty state should say. Without one the engine
    // ranks the whole syllabus, so "nothing to practise" is the wrong message — the learner
    // needs to be sent to set a goal, not told there is no work.
    const goal = useApi<{ goal: Goal | null }>(() => api.get<{ goal: Goal | null }>('/goals'));
    // The year grid and the badges. Its own request, so a slow year of squares never delays the one
    // thing this screen exists for — telling the learner what to do next.
    const activity = useApi<ActivityResponse>(() => api.get<ActivityResponse>('/learner/activity'));
    // Just for the greeting, so it renders as soon as it arrives rather than waiting on the rest.
    const profile = useApi<{ profile: LearnerProfile }>(() =>
        api.get<{ profile: LearnerProfile }>('/learner/profile')
    );

    const name = profile.data?.profile.displayName?.trim();

    return (
        <div className="stack">
            {/* The greeting always renders.
                It used to be gated on the name being known, so that a learner who had never set one
                got no greeting at all — and since a fresh account has no name, the first thing a new
                learner saw was a dashboard that opened with nothing. The name is added when it is
                there and a nudge to set one when it is not, which is both friendlier and a route to
                fixing it. The heading is only held back until the request settles, to avoid a flash
                of "Welcome back" before "Welcome back, Ayush". */}
            {!profile.loading && (
                <div className="spread" style={{ alignItems: 'flex-start', gap: 16 }}>
                    <div style={{ minWidth: 0 }}>
                        <span className="label">{greetingFor(new Date())}</span>
                        <h1 style={{ marginBottom: 0 }}>
                            {name ? `Welcome back, ${name}` : 'Welcome back'}
                        </h1>
                        {!name && (
                            <p className="faint" style={{ margin: '6px 0 0' }}>
                                <Link to="/settings">Add your name</Link> so this says hello
                                properly.
                            </p>
                        )}
                    </div>

                    {/* The page's mark, matching every other screen. */}
                    <span className="hero-mark" aria-hidden="true">
                        <Icon name="grid" size={40} />
                    </span>
                </div>
            )}

            {/* ---------------------------------------------- next action */}
            {session.loading && <Loading label="Working out what you should do next…" />}

            {session.error ? <Failed error={session.error} onRetry={session.reload} /> : null}

            {goal.data && !goal.data.goal && (
                <div className="card stack">
                    <span className="label">Start here</span>
                    <p style={{ margin: 0 }}>
                        You have not set a goal yet, so practice is being drawn from the whole
                        syllabus. Tell us your exam and how much time you have and it will focus on
                        what matters.
                    </p>
                    <button type="button" className="primary" onClick={() => navigate('/goals')}>
                        Set your goal
                    </button>
                </div>
            )}

            {session.data && !session.data.recommendation && (
                <Empty
                    title="Nothing to practise yet"
                    action={
                        <button type="button" onClick={() => navigate('/goals')}>
                            Change your goal
                        </button>
                    }
                >
                    <p className="muted">
                        {session.data.reason ??
                            'There are no questions available for the subjects you chose.'}
                    </p>
                </Empty>
            )}

            {session.data?.recommendation && (
                <div className="card card--accent stack">
                    <div className="spread">
                        <span className="label">Do this next</span>
                        <span className={`pill pill--${session.data.recommendation.difficulty}`}>
                            {session.data.recommendation.difficulty}
                        </span>
                    </div>

                    <div>
                        <h1>{session.data.recommendation.topic.name}</h1>
                        <p className="muted" style={{ margin: 0 }}>
                            {ACTION_LABELS[session.data.recommendation.action] ??
                                session.data.recommendation.action}
                            {' · '}
                            {session.data.recommendation.questionCount}{' '}
                            {session.data.recommendation.questionCount === 1
                                ? 'question'
                                : 'questions'}
                            {' · about '}
                            {session.data.recommendation.estimatedMinutes} min
                        </p>
                    </div>

                    {/* No Start button here. Practice begins on the Practice screen and nowhere
                        else — two entry points meant two places that could disagree about what the
                        session was, and a learner who started from here never saw their subjects.
                        This card is now what it says it is: the answer to "what should I do next". */}

                    {/* The engine's own explanation, verbatim. A recommendation a learner
                        cannot interrogate is one they will not follow. */}
                    <p style={{ margin: 0 }}>{session.data.recommendation.reason}</p>

                    <MasterySignal
                        score={session.data.recommendation.signals.masteryScore}
                        attempts={session.data.recommendation.signals.totalAttempts}
                    />

                    {session.data.bankNote && (
                        <p className="faint" style={{ margin: 0 }}>
                            {session.data.bankNote}
                        </p>
                    )}
                </div>
            )}

            {goal.data?.goal && (
                <div className="card">
                    <div className="spread">
                        <div>
                            <span className="label">{goal.data.goal.title}</span>
                            <div className="faint">{goal.data.goal.dailyMinutes} min a day</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                            <div className="big">{Math.max(0, goal.data.goal.daysRemaining)}</div>
                            <div className="faint">
                                {goal.data.goal.daysRemaining === 1 ? 'day' : 'days'} left
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* ---------------------------------------------- the year, and the shelf

                Outside the "has any activity" gate on purpose, and this was a real mistake first
                time round: gated, a brand new learner's dashboard showed neither, which is exactly
                the moment the year grid and the badge targets do the most work. An empty grid saying
                "answer something today to start a streak" is information; a missing grid is a
                dashboard that looks broken. The badge card behaves the same way — with nothing earned
                it shows what the first one takes.

                Both go under the "do this next" card: motivation is what brings somebody back, but
                the instruction is what they came for today. */}
            {activity.loading && (
                <>
                    <div className="skeleton" style={{ height: 190 }} />
                    <div className="skeleton" style={{ height: 150, opacity: 0.6 }} />
                </>
            )}

            {activity.data && (
                <>
                    <ActivityHeatmap calendar={activity.data.calendar} />
                    <Badges badges={activity.data.badges} upcoming={activity.data.upcoming} />
                </>
            )}

            {/* ---------------------------------------------- your numbers */}
            {summary.loading && <Loading label="Loading your progress…" />}

            {summary.error ? <Failed error={summary.error} onRetry={summary.reload} /> : null}

            {summary.data && !summary.data.hasActivity && (
                <div className="card">
                    <span className="label">Your progress</span>
                    <p className="muted" style={{ marginTop: 10, marginBottom: 0 }}>
                        Answer your first question and your mastery scores will start appearing
                        here.
                    </p>
                </div>
            )}

            {summary.data?.hasActivity && (
                <>
                    <div className="card">
                        <span className="label">Your numbers</span>
                        <div className="row" style={{ marginTop: 14, gap: 32 }}>
                            <Stat
                                value={String(summary.data.attempts.total)}
                                label="questions answered"
                            />
                            <Stat
                                value={
                                    summary.data.attempts.accuracyPercent === null
                                        ? '—'
                                        : `${Math.round(summary.data.attempts.accuracyPercent)}%`
                                }
                                label="accuracy"
                            />
                            <Stat
                                value={String(summary.data.habits.currentStreakDays)}
                                label="day streak"
                            />
                            {/* Regularity, next to volume and accuracy on purpose: it is the one
                                of the three a learner can improve today by simply turning up. */}
                            <Stat
                                value={
                                    summary.data.habits.consistencyPercent === null
                                        ? '—'
                                        : `${Math.round(summary.data.habits.consistencyPercent)}%`
                                }
                                label="days studied"
                            />
                        </div>

                        {summary.data.habits.longestStreakDays >
                            summary.data.habits.currentStreakDays && (
                            <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                                Your best run was {summary.data.habits.longestStreakDays} days.
                            </p>
                        )}
                    </div>

                    {summary.data.weakestTopics.length > 0 && (
                        <div className="card stack">
                            <span className="label">Weakest topics</span>

                            {summary.data.weakestTopics.map((topic) => (
                                <div key={topic.topicId}>
                                    <div className="spread">
                                        <span>{topic.name}</span>
                                        <span className="mono muted">
                                            {Math.round(topic.masteryScore)}
                                        </span>
                                    </div>
                                    <div
                                        className="meter"
                                        style={{ marginTop: 6 }}
                                        role="progressbar"
                                        aria-label={`${topic.name} mastery`}
                                        aria-valuenow={Math.round(topic.masteryScore)}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                    >
                                        <div
                                            style={{
                                                width: `${topic.masteryScore}%`,
                                            }}
                                        />
                                    </div>
                                    <span className="faint">
                                        based on {topic.attempts}{' '}
                                        {topic.attempts === 1 ? 'attempt' : 'attempts'}
                                    </span>
                                </div>
                            ))}

                            {/* Said out loud rather than implied: a score from a handful of
                                answers is an estimate, and the interface should not pretend
                                otherwise. */}
                            <p className="faint" style={{ margin: 0 }}>
                                Mastery is an estimate from your answers so far, not a measurement.
                            </p>
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

function Stat({ value, label }: { value: string; label: string }) {
    return (
        <div>
            <div className="big">{value}</div>
            <div className="faint">{label}</div>
        </div>
    );
}

function MasterySignal({ score, attempts }: { score: number | null; attempts: number }) {
    if (score === null) {
        return (
            <p className="faint" style={{ margin: 0 }}>
                You have not attempted this topic yet.
            </p>
        );
    }

    return (
        <div>
            <div className="spread">
                <span className="faint">Current mastery</span>
                <span className="mono">
                    {Math.round(score)} · {attempts} {attempts === 1 ? 'attempt' : 'attempts'}
                </span>
            </div>
            <div className="meter" style={{ marginTop: 6 }}>
                <div style={{ width: `${score}%` }} />
            </div>
        </div>
    );
}

/**
 * "Good morning" and so on, from the device clock.
 *
 * The device's own time on purpose, not the timezone stored on the profile: a greeting should match
 * the light outside the window of whoever is reading it. The stored timezone is for things that have
 * to be consistent across devices — streaks, due dates — and this is not one of them.
 */
function greetingFor(now: Date): string {
    const hour = now.getHours();

    if (hour < 5) return 'Late night';
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';

    return 'Good evening';
}
