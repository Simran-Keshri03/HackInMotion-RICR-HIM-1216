import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '@/components/Icon/Icon';
import { Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { Assessment as AssessmentType, DiagnosticList } from '@/types/api';

/**
 * The diagnostic: the sitting that tells the study plan where to start.
 *
 * This is the input the plan generator was missing. A plan prioritises weak areas by comparing each
 * topic's mastery against a target — and for a learner who has just set a goal there is no mastery at
 * all, so every topic looks equally unknown and the plan can only order by exam weight. Fifteen minutes
 * here is what turns "a plan for this syllabus" into "a plan for you".
 *
 * It is one question per topic, spread across every subject, and that breadth is the design rather than
 * a shortcut: the job is finding *where* the learner is weak, so covering twelve topics once beats
 * covering three topics four times.
 *
 * Like a mock test, nothing is revealed until the end — the server does not send the answers for an open
 * paper, so the screen could not show them if it wanted to.
 */

type Phase = 'idle' | 'sitting' | 'done';
type Answers = Record<string, number[] | number>;

export default function Assessment() {
    const navigate = useNavigate();

    const existing = useApi<DiagnosticList>(() =>
        api.get<DiagnosticList>('/assessments/diagnostic')
    );

    const [assessment, setAssessment] = useState<AssessmentType | null>(null);
    const [phase, setPhase] = useState<Phase>('idle');
    const [answers, setAnswers] = useState<Answers>({});
    const [index, setIndex] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function start() {
        setError(null);
        setBusy(true);

        try {
            const result = await api.post<{ assessment: AssessmentType }>(
                '/assessments/diagnostic',
                {}
            );

            setAssessment(result.assessment);
            setAnswers({});
            setIndex(0);
            setPhase('sitting');
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : 'Could not start the assessment.'
            );
        } finally {
            setBusy(false);
        }
    }

    async function submit() {
        if (!assessment || busy) return;

        setError(null);
        setBusy(true);

        try {
            const result = await api.post<{ assessment: AssessmentType }>(
                `/assessments/${assessment.id}/submit`,
                {
                    // Only what was answered. A question left out is recorded as skipped, and the
                    // result says so rather than folding it into the score silently.
                    answers: Object.entries(answers).map(([questionId, value]) =>
                        Array.isArray(value)
                            ? { questionId, selectedOptions: value }
                            : { questionId, value }
                    ),
                }
            );

            setAssessment(result.assessment);
            setPhase('done');
            existing.reload();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not submit.');
        } finally {
            setBusy(false);
        }
    }

    async function review(id: string) {
        setError(null);
        setBusy(true);

        try {
            const result = await api.get<{ assessment: AssessmentType }>(
                `/assessments/${id}`
            );
            setAssessment(result.assessment);
            setPhase(result.assessment.status === 'completed' ? 'done' : 'sitting');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not open that.');
        } finally {
            setBusy(false);
        }
    }

    function choose(questionId: string, optionIndex: number, multi: boolean) {
        setAnswers((current) => {
            if (!multi) return { ...current, [questionId]: [optionIndex] };

            const existingChoice = current[questionId];
            const chosen = Array.isArray(existingChoice) ? existingChoice : [];

            return {
                ...current,
                [questionId]: chosen.includes(optionIndex)
                    ? chosen.filter((i) => i !== optionIndex)
                    : [...chosen, optionIndex],
            };
        });
    }

    const questions = assessment?.questions ?? [];
    const question = questions[index];
    const answeredCount = Object.keys(answers).length;

    // ---------------------------------------------------------------- sitting
    if (phase === 'sitting' && assessment && question) {
        const chosen = answers[question.id];
        const selected = Array.isArray(chosen) ? chosen : [];
        const isMulti = question.question_type === 'msq';

        return (
            <div className="stack" style={{ maxWidth: 760 }}>
                <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
                    <div>
                        <span className="label">Knowledge check</span>
                        <div className="faint">
                            Question {index + 1} of {questions.length} ·{' '}
                            {answeredCount} answered
                        </div>
                    </div>
                    <span className={`pill pill--${question.difficulty}`}>
                        {question.difficulty}
                    </span>
                </div>

                <div className="qstrip">
                    {questions.map((q, i) => (
                        <button
                            key={q.id}
                            type="button"
                            className={`qstrip__item${answers[q.id] !== undefined ? ' qstrip__item--answered' : ''}`}
                            aria-current={i === index ? 'true' : undefined}
                            onClick={() => setIndex(i)}
                        >
                            {i + 1}
                        </button>
                    ))}
                </div>

                {error && <div className="banner banner--error">{error}</div>}

                <div className="card stack">
                    <p style={{ margin: 0, fontSize: '1.05rem' }}>{question.body}</p>

                    {isMulti && (
                        <p className="faint" style={{ margin: 0 }}>
                            Select every correct option.
                        </p>
                    )}

                    {question.options && (
                        <div className="stack" style={{ gap: 8 }}>
                            {question.options.map((option, optionIndex) => (
                                <button
                                    key={optionIndex}
                                    type="button"
                                    className="option"
                                    aria-pressed={selected.includes(optionIndex)}
                                    onClick={() =>
                                        choose(question.id, optionIndex, isMulti)
                                    }
                                >
                                    <span className="option__mark">
                                        {String.fromCharCode(65 + optionIndex)}
                                    </span>
                                    <span>{option}</span>
                                </button>
                            ))}
                        </div>
                    )}

                    {!question.options && (
                        <div className="field">
                            <label htmlFor="numeric">Your answer</label>
                            <input
                                id="numeric"
                                type="number"
                                step="any"
                                inputMode="decimal"
                                value={typeof chosen === 'number' ? chosen : ''}
                                onChange={(e) =>
                                    setAnswers((current) => {
                                        const next = { ...current };
                                        if (e.target.value === '')
                                            delete next[question.id];
                                        else next[question.id] = Number(e.target.value);
                                        return next;
                                    })
                                }
                            />
                        </div>
                    )}
                </div>

                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => setIndex((i) => i - 1)}
                    >
                        Back
                    </button>

                    {index < questions.length - 1 ? (
                        <button
                            type="button"
                            className="primary wide"
                            onClick={() => setIndex((i) => i + 1)}
                        >
                            Next
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="primary wide"
                            disabled={busy}
                            onClick={() => void submit()}
                        >
                            {busy ? 'Working out your level…' : 'Finish'}
                        </button>
                    )}
                </div>

                <p className="faint" style={{ margin: 0 }}>
                    Nothing is marked until you finish. A blank answer is treated as unknown,
                    which means more plan time on that topic than you may need — a guess is
                    better information than a gap.
                </p>
            </div>
        );
    }

    // ---------------------------------------------------------------- result
    if (phase === 'done' && assessment?.result) {
        const { result } = assessment;

        return (
            <div className="stack" style={{ maxWidth: 760 }}>
                <div>
                    <span className="label">Your level</span>
                    <h1 style={{ marginBottom: 4 }}>
                        {result.correctCount} of {result.totalQuestions}
                    </h1>
                </div>

                <div className="card card--accent">
                    <span className="label">What this changes</span>
                    {/* The engine's own sentence. A level with no consequence is a score; this says what
                        the plan will do differently because of it. */}
                    <p style={{ marginTop: 10, marginBottom: 0 }}>{result.verdict}</p>
                </div>

                <div className="card stack" style={{ gap: 10 }}>
                    <span className="label">By subject — weakest first</span>

                    {result.subjects.map((subject) => (
                        <div key={subject.subjectId} className="spread">
                            <span>
                                {subject.subjectName}
                                <span className="faint">
                                    {' — '}
                                    {subject.correct}/{subject.total}
                                </span>
                            </span>
                            <span
                                className={`pill pill--${
                                    subject.level === 'weak'
                                        ? 'hard'
                                        : subject.level === 'moderate'
                                          ? 'medium'
                                          : 'easy'
                                }`}
                            >
                                {subject.level}
                            </span>
                        </div>
                    ))}

                    <p className="faint" style={{ margin: 0 }}>
                        Bands rather than percentages: two or three questions per subject cannot
                        support a precise number, and a precise number reads as a verdict rather
                        than a starting point.
                    </p>
                </div>

                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        className="primary"
                        onClick={() => navigate('/plan')}
                    >
                        Build my plan from this
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setPhase('idle');
                            setAssessment(null);
                        }}
                    >
                        Back
                    </button>
                </div>
            </div>
        );
    }

    // ---------------------------------------------------------------- idle
    if (existing.loading) return <Loading label="Loading your assessment…" />;
    if (existing.error) {
        return <Failed error={existing.error} onRetry={existing.reload} />;
    }

    const previous = existing.data?.assessment ?? null;
    const done = previous?.status === 'completed';

    return (
        <div className="worksplit">
            <div className="stack">
                <div className="spread" style={{ alignItems: 'flex-start', gap: 16 }}>
                    <div style={{ minWidth: 0 }}>
                        <span className="label">Knowledge check</span>
                        <h1 style={{ marginBottom: 6 }}>Where are you starting from?</h1>
                        <p className="muted" style={{ margin: 0, maxWidth: '54ch' }}>
                            One question per topic, across every subject in your goal. It takes
                            about fifteen minutes and it is what lets your study plan spend time
                            on your weak areas rather than spreading it evenly.
                        </p>
                    </div>
                    <span className="hero-mark" aria-hidden="true">
                        <Icon name="target" size={40} />
                    </span>
                </div>

                {error && <div className="banner banner--error">{error}</div>}

                {done && previous && (
                    <div className="card card--glow stack">
                        <span className="label">Already done</span>
                        <p style={{ margin: 0 }}>
                            You sat this on{' '}
                            {new Date(
                                previous.completedAt ?? previous.startedAt
                            ).toLocaleDateString(undefined, {
                                day: 'numeric',
                                month: 'long',
                            })}
                            . Your plan is already built from it.
                        </p>
                        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                            <button
                                type="button"
                                className="secondary"
                                disabled={busy}
                                onClick={() => void review(previous.id)}
                            >
                                See the breakdown
                            </button>
                            <Link to="/plan" className="faint">
                                Go to your plan
                            </Link>
                        </div>
                    </div>
                )}

                <div className="card stack">
                    <div>
                        <span className="label">
                            {done ? 'Sit it again' : 'Start the check'}
                        </span>
                        <p className="faint" style={{ margin: '6px 0 0' }}>
                            {done
                                ? 'Useful after a few weeks of study — it will show what has moved, and the plan rebuilds around the new picture.'
                                : 'Nothing is revealed until you finish, because knowing one answer changes how you answer the next.'}
                        </p>
                    </div>

                    <button
                        type="button"
                        className="primary wide"
                        disabled={busy}
                        onClick={() => void start()}
                    >
                        {busy ? 'Building your paper…' : 'Start knowledge check'}
                    </button>
                </div>
            </div>

            <aside className="stack">
                <div className="card stack" style={{ gap: 14 }}>
                    <div className="row" style={{ gap: 10 }}>
                        <span className="tile tile--violet">
                            <Icon name="sparkles" />
                        </span>
                        <strong>Why this comes first</strong>
                    </div>

                    {[
                        {
                            tile: 'tile--blue',
                            icon: 'chart',
                            title: 'A plan needs a starting point',
                            body: 'Without one, every topic looks equally unknown and time is split evenly.',
                        },
                        {
                            tile: 'tile--green',
                            icon: 'target',
                            title: 'Broad, not deep',
                            body: 'One question per topic. Finding where you are weak beats measuring one topic precisely.',
                        },
                        {
                            tile: 'tile--fire',
                            icon: 'flame',
                            title: 'It counts',
                            body: 'Answers move your mastery like any other practice — nothing is thrown away.',
                        },
                    ].map((item) => (
                        <div
                            key={item.title}
                            className="row"
                            style={{ gap: 12, alignItems: 'flex-start' }}
                        >
                            <span className={`tile ${item.tile}`}>
                                <Icon name={item.icon as 'chart'} />
                            </span>
                            <div style={{ minWidth: 0 }}>
                                <strong style={{ fontSize: '0.92rem' }}>
                                    {item.title}
                                </strong>
                                <div className="faint">{item.body}</div>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="card stack" style={{ gap: 14 }}>
                    <strong>How it fits together</strong>
                    <div className="steps">
                        {[
                            'Set your goal and subjects',
                            'Sit this knowledge check',
                            'Your plan is built around your weak areas',
                        ].map((step, i) => (
                            <div key={step} className="step">
                                <span className="step__n">{i + 1}</span>
                                <span style={{ fontSize: '0.92rem' }}>{step}</span>
                            </div>
                        ))}
                    </div>
                    <Link to="/goals" className="faint">
                        No goal yet? Set one first
                    </Link>
                </div>
            </aside>
        </div>
    );
}
