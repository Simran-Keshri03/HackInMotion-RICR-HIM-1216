import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon/Icon';
import { Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { MockTest, MockTestList } from '@/types/api';

/**
 * Mock tests: a paper built from the study plan, sat in one go, marked at the end.
 *
 * The screen has one job the practice screen does not: **give nothing away until it is over.** No
 * marking, no colour, no explanation between questions — because knowing you got question three wrong
 * changes how you answer question four, and then the score measures something other than what you
 * knew when you started. Every answer is held locally and posted together at the end.
 *
 * That is not client-side politeness. The server never sends the answers for an open test, so the
 * screen could not reveal them if it wanted to.
 *
 * Navigation between questions is free — forwards, back, and a strip of numbers — because that is what
 * sitting a paper is like, and because a learner who cannot revisit question two will not skip it when
 * they should.
 */

type Phase = 'idle' | 'sitting' | 'done';

/** Answers held in the browser until submission. Keyed by question id. */
type Answers = Record<string, number[] | number>;

function mmss(totalSeconds: number): string {
    const minutes = Math.floor(Math.max(0, totalSeconds) / 60);
    const seconds = Math.max(0, totalSeconds) % 60;

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export default function MockTest() {
    const list = useApi<MockTestList>(() => api.get<MockTestList>('/mock-tests'));

    const [test, setTest] = useState<MockTest | null>(null);
    const [phase, setPhase] = useState<Phase>('idle');
    const [answers, setAnswers] = useState<Answers>({});
    const [index, setIndex] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // A test left open in a previous visit is offered rather than lost. The answers are gone — they
    // only ever lived in this component — so it restarts, which is honest: an interrupted paper is not
    // a paper.
    const open = list.data?.open ?? null;

    /**
     * The clock.
     *
     * Counts up rather than down. A countdown that hits zero has to either cut somebody off mid-answer
     * or do nothing, and the second is a lie; counting up lets the screen say "you are over the
     * suggested time" without taking the paper away. `duration_minutes` is shown beside it as the
     * target.
     */
    useEffect(() => {
        if (phase !== 'sitting') return;

        const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
        return () => clearInterval(timer);
    }, [phase]);

    async function begin(questionCount?: number) {
        setError(null);
        setBusy(true);

        try {
            const result = await api.post<{ test: MockTest }>('/mock-tests', {
                ...(questionCount ? { questionCount } : {}),
            });

            setTest(result.test);
            setAnswers({});
            setIndex(0);
            setElapsed(0);
            setPhase('sitting');
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : 'Could not build a test.'
            );
        } finally {
            setBusy(false);
        }
    }

    async function resume(testId: string) {
        setError(null);
        setBusy(true);

        try {
            const result = await api.get<{ test: MockTest }>(`/mock-tests/${testId}`);
            setTest(result.test);
            setAnswers({});
            setIndex(0);
            setElapsed(0);
            setPhase('sitting');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not open that test.');
        } finally {
            setBusy(false);
        }
    }

    async function submit() {
        if (!test || busy) return;

        setError(null);
        setBusy(true);

        try {
            const result = await api.post<{ test: MockTest }>(
                `/mock-tests/${test.id}/submit`,
                {
                    // Only what was actually answered. A question left out is recorded as skipped,
                    // which the result reports separately from wrong.
                    answers: Object.entries(answers).map(([questionId, value]) =>
                        Array.isArray(value)
                            ? { questionId, selectedOptions: value }
                            : { questionId, value }
                    ),
                    secondsTaken: elapsed,
                }
            );

            setTest(result.test);
            setPhase('done');
            list.reload();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not submit.');
        } finally {
            setBusy(false);
        }
    }

    async function review(testId: string) {
        setError(null);
        setBusy(true);

        try {
            const result = await api.get<{ test: MockTest }>(`/mock-tests/${testId}`);
            setTest(result.test);
            setPhase('done');
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not open that test.');
        } finally {
            setBusy(false);
        }
    }

    const questions = test?.questions ?? [];
    const question = questions[index];
    const answeredCount = useMemo(() => Object.keys(answers).length, [answers]);

    function choose(questionId: string, optionIndex: number, multi: boolean) {
        setAnswers((current) => {
            if (!multi) return { ...current, [questionId]: [optionIndex] };

            const existing = current[questionId];
            const chosen = Array.isArray(existing) ? existing : [];

            return {
                ...current,
                [questionId]: chosen.includes(optionIndex)
                    ? chosen.filter((i) => i !== optionIndex)
                    : [...chosen, optionIndex],
            };
        });
    }

    // ---------------------------------------------------------------- sitting
    if (phase === 'sitting' && test && question) {
        const chosen = answers[question.id];
        const selected = Array.isArray(chosen) ? chosen : [];
        const isMulti = question.question_type === 'msq';
        const overtime = elapsed > test.durationMinutes * 60;

        return (
            <div className="stack" style={{ maxWidth: 760 }}>
                <div className="spread" style={{ flexWrap: 'wrap', gap: 10 }}>
                    <div>
                        <span className="label">Mock test</span>
                        <div className="faint">
                            Question {index + 1} of {questions.length} ·{' '}
                            {answeredCount} answered
                        </div>
                    </div>

                    <div className="row" style={{ gap: 10 }}>
                        <span className={overtime ? 'pill pill--hard' : 'pill'}>
                            {mmss(elapsed)} / {test.durationMinutes}:00
                        </span>
                    </div>
                </div>

                {/* A number for every question, so nothing is lost by moving around. Answered ones are
                    marked — the only marking on this screen, and it says "you gave an answer", never
                    whether it was right. */}
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
                    <div className="spread">
                        <span className="faint">
                            {question.marks} {question.marks === 1 ? 'mark' : 'marks'}
                        </span>
                        <span className={`pill pill--${question.difficulty}`}>
                            {question.difficulty}
                        </span>
                    </div>

                    <p style={{ margin: 0, fontSize: '1.05rem' }}>{question.body}</p>

                    {isMulti && (
                        <p className="faint" style={{ margin: 0 }}>
                            Select every correct option — partial answers score nothing.
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

                                        if (e.target.value === '') delete next[question.id];
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
                            {busy ? 'Marking…' : 'Finish and see score'}
                        </button>
                    )}
                </div>

                {answeredCount < questions.length && index === questions.length - 1 && (
                    <p className="faint" style={{ margin: 0 }}>
                        {questions.length - answeredCount} unanswered. Blank counts as
                        wrong, so it is worth a guess.
                    </p>
                )}
            </div>
        );
    }

    // ---------------------------------------------------------------- result
    if (phase === 'done' && test?.result) {
        const { result } = test;

        return (
            <div className="stack" style={{ maxWidth: 760 }}>
                <div>
                    <span className="label">Result</span>
                    <h1 style={{ marginBottom: 4 }}>
                        {result.correctCount} out of {result.totalQuestions}
                    </h1>
                    <p className="muted" style={{ margin: 0 }}>
                        {test.title}
                    </p>
                </div>

                <div className="card card--accent">
                    <div className="row" style={{ gap: 30, flexWrap: 'wrap' }}>
                        <div>
                            <div className="big">{result.scorePercent}%</div>
                            <div className="faint">score</div>
                        </div>
                        <div>
                            <div className="big">
                                {result.answeredCount}/{result.totalQuestions}
                            </div>
                            <div className="faint">answered</div>
                        </div>
                        <div>
                            <div className="big">
                                {result.passed ? 'Pass' : 'Below target'}
                            </div>
                            <div className="faint">against 60%</div>
                        </div>
                    </div>

                    {/* The engine's own sentence, verbatim. It names the topic to go to next, which is
                        the only thing a score is actually useful for. */}
                    <p style={{ marginTop: 14, marginBottom: 0 }}>{result.verdict}</p>
                </div>

                <div className="card stack" style={{ gap: 8 }}>
                    <span className="label">By topic — weakest first</span>

                    {result.byTopic.map((topic) => (
                        <div key={topic.topicId} className="stack" style={{ gap: 4 }}>
                            <div className="spread">
                                <span>{topic.name}</span>
                                <span className="faint">
                                    {topic.correct}/{topic.total} · {topic.percent}%
                                </span>
                            </div>
                            <div className="subjects__bar">
                                <span
                                    style={{
                                        width: `${topic.percent}%`,
                                        background:
                                            topic.percent < 50
                                                ? 'var(--bad)'
                                                : topic.percent < 75
                                                  ? 'var(--warn)'
                                                  : 'var(--good)',
                                    }}
                                />
                            </div>
                        </div>
                    ))}
                </div>

                <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                    <Link to="/practice" className="primary btn-link">
                        Practise the weakest topic
                    </Link>
                    <button
                        type="button"
                        onClick={() => {
                            setPhase('idle');
                            setTest(null);
                        }}
                    >
                        Back to tests
                    </button>
                </div>
            </div>
        );
    }

    // ---------------------------------------------------------------- idle
    if (list.loading) return <Loading label="Loading your tests…" />;
    if (list.error) return <Failed error={list.error} onRetry={list.reload} />;

    const history = (list.data?.tests ?? []).filter(
        (entry) => entry.status === 'submitted'
    );

    return (
        <div className="worksplit">
            <div className="stack">
                <div className="spread" style={{ alignItems: 'flex-start', gap: 16 }}>
                    <div style={{ minWidth: 0 }}>
                        <span className="label">Mock tests</span>
                        <h1 style={{ marginBottom: 6 }}>Test yourself on your plan</h1>
                        <p className="muted" style={{ margin: 0, maxWidth: '54ch' }}>
                            A paper built from the topics your study plan has scheduled —
                            so the score tells you whether the studying is working, not
                            whether you know things you were never asked to learn yet.
                        </p>
                    </div>
                    <span className="hero-mark" aria-hidden="true">
                        <Icon name="chart" size={40} />
                    </span>
                </div>

                {error && <div className="banner banner--error">{error}</div>}

                {open && (
                    <div className="card card--glow stack">
                        <span className="label">Unfinished test</span>
                        <p style={{ margin: 0 }}>
                            You left {open.title.toLowerCase()} open. Starting it again
                            begins from the first question — answers are not kept while a
                            paper is closed.
                        </p>
                        <button
                            type="button"
                            className="primary wide"
                            disabled={busy}
                            onClick={() => void resume(open.id)}
                        >
                            Open it
                        </button>
                    </div>
                )}

                <div className="card stack">
                    <div>
                        <span className="label">New test</span>
                        <p className="faint" style={{ margin: '6px 0 0' }}>
                            No answers are shown until you finish. That is the point — it
                            measures what you knew walking in.
                        </p>
                    </div>

                    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                        {[10, 15, 25].map((count) => (
                            <button
                                key={count}
                                type="button"
                                className={count === 15 ? 'primary' : undefined}
                                disabled={busy}
                                onClick={() => void begin(count)}
                            >
                                {busy ? 'Building…' : `${count} questions`}
                            </button>
                        ))}
                    </div>
                </div>

                {history.length > 0 && (
                    <div className="card stack" style={{ gap: 8 }}>
                        <span className="label">Your tests</span>

                        {history.map((entry) => (
                            <button
                                key={entry.id}
                                type="button"
                                className="row-item"
                                onClick={() => void review(entry.id)}
                            >
                                <span
                                    className={`tile ${(entry.scorePercent ?? 0) >= 60 ? 'tile--green' : 'tile--fire'}`}
                                >
                                    {Math.round(entry.scorePercent ?? 0)}
                                </span>
                                <span className="row-item__body">
                                    <strong>{entry.title}</strong>
                                    <div className="faint">
                                        {entry.correctCount}/{entry.totalQuestions}{' '}
                                        correct ·{' '}
                                        {new Date(
                                            entry.submittedAt ?? entry.startedAt
                                        ).toLocaleDateString(undefined, {
                                            day: 'numeric',
                                            month: 'short',
                                        })}
                                    </div>
                                </span>
                                <Icon name="chevron" className="row-item__chev" />
                            </button>
                        ))}
                    </div>
                )}
            </div>

            <aside className="stack">
                <div className="card stack" style={{ gap: 14 }}>
                    <div className="row" style={{ gap: 10 }}>
                        <span className="tile tile--violet">
                            <Icon name="shield" />
                        </span>
                        <strong>How a test differs</strong>
                    </div>

                    {[
                        {
                            tile: 'tile--blue',
                            icon: 'lock',
                            title: 'Nothing revealed until the end',
                            body: 'The server does not send the answers for an open paper.',
                        },
                        {
                            tile: 'tile--green',
                            icon: 'chart',
                            title: 'Several topics at once',
                            body: 'Interleaved, so running out of time costs you evenly.',
                        },
                        {
                            tile: 'tile--fire',
                            icon: 'flame',
                            title: 'It counts',
                            body: 'Answers move your mastery like any other practice.',
                        },
                    ].map((item) => (
                        <div
                            key={item.title}
                            className="row"
                            style={{ gap: 12, alignItems: 'flex-start' }}
                        >
                            <span className={`tile ${item.tile}`}>
                                <Icon name={item.icon as 'lock'} />
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

                <div className="card stack" style={{ gap: 10 }}>
                    <strong>Where the questions come from</strong>
                    <p className="faint" style={{ margin: 0 }}>
                        Topics your plan has scheduled, weighted by how much time it gave
                        them and how far from mastered they are. Topics with too few
                        questions in the bank are named and left out rather than padded.
                    </p>
                    <Link to="/plan" className="faint">
                        See your plan
                    </Link>
                </div>
            </aside>
        </div>
    );
}
