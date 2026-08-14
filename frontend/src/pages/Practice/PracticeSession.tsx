import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { AttemptResult, NextSession } from '@/types/api';

/**
 * A practice set: one question at a time, then the answer, the explanation, and the mastery change.
 *
 * The mastery number moving after an answer is the moment the product justifies itself, so it is
 * shown explicitly — before, after, and the delta — rather than left for the learner to notice on a
 * dashboard later.
 *
 * Note what this screen does not have: the correct answer, until the attempt is submitted. It cannot
 * have it. The browser holds no column privilege on `questions.correct_answer`, so grading happens on
 * the server and the answer arrives in the response. That is why a test here is worth something.
 *
 * `subjectId` narrows the engine to the subject the learner picked; null lets it rank across their
 * whole goal, which is the adaptive path and still the better default.
 */
export function PracticeSession({
    subjectId,
    onExit,
}: {
    subjectId: string | null;
    onExit: () => void;
}) {

    // Re-fetches when the subject changes, which is what `deps` on useApi is for.
    const session = useApi<NextSession>(
        () =>
            api.get<NextSession>(
                subjectId
                    ? `/recommendations/next?subject=${subjectId}`
                    : '/recommendations/next'
            ),
        [subjectId]
    );

    const [index, setIndex] = useState(0);
    const [selected, setSelected] = useState<number[]>([]);
    const [numericValue, setNumericValue] = useState('');
    const [result, setResult] = useState<AttemptResult | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [startedAt, setStartedAt] = useState(() => Date.now());

    if (session.loading) {
        return (
            <Loading
                label="Getting your questions…"
                // A topic nobody has reached before has no questions yet, so the server writes
                // some before it can answer. Saying so beats a spinner that looks stuck.
                slowLabel="Writing questions for a topic you have not practised yet…"
            />
        );
    }

    if (session.error) {
        return <Failed error={session.error} onRetry={session.reload} />;
    }

    const questions = session.data?.questions ?? [];
    const recommendation = session.data?.recommendation;

    if (!recommendation || questions.length === 0) {
        return (
            <Empty
                title="No questions available"
                action={
                    <button type="button" onClick={onExit}>
                        Pick another subject
                    </button>
                }
            >
                <p className="muted">
                    {session.data?.reason ??
                        'There is nothing to practise on this topic yet.'}
                </p>
            </Empty>
        );
    }

    const question = questions[index];

    // Defensive: an index past the end means the set was exhausted, which the finished screen
    // below normally catches first.
    if (!question) {
        return (
            <Empty
                title="Session finished"
                action={
                    <button
                        type="button"
                        className="primary"
                        onClick={onExit}
                    >
                        Pick another subject
                    </button>
                }
            />
        );
    }

    const isLast = index === questions.length - 1;
    const isChoice = question.question_type !== 'numeric';
    const isMulti = question.question_type === 'msq';

    const canSubmit = isChoice ? selected.length > 0 : numericValue.trim() !== '';

    function toggleOption(optionIndex: number) {
        if (result) return; // answered; the options are now read-only

        setSelected((current) => {
            if (isMulti) {
                return current.includes(optionIndex)
                    ? current.filter((i) => i !== optionIndex)
                    : [...current, optionIndex];
            }
            return [optionIndex];
        });
    }

    async function submit() {
        setSubmitting(true);
        setSubmitError(null);

        try {
            const payload = {
                questionId: question.id,
                // Exactly one of these, matching what the backend's schema requires.
                ...(isChoice
                    ? { selectedOptions: selected }
                    : { value: Number(numericValue) }),
                timeTakenSeconds: Math.min(
                    3600,
                    Math.round((Date.now() - startedAt) / 1000)
                ),
                source: 'practice' as const,
            };

            setResult(await api.post<AttemptResult>('/attempts', payload));
        } catch (cause) {
            setSubmitError(
                cause instanceof Error
                    ? cause.message
                    : 'Could not save your answer.'
            );
        } finally {
            setSubmitting(false);
        }
    }

    function next() {
        setIndex((i) => i + 1);
        setSelected([]);
        setNumericValue('');
        setResult(null);
        setSubmitError(null);
        setStartedAt(Date.now());
    }

    // Which options to mark once the answer is known. The correct answer arrives only in the
    // attempt response, so this is empty until then.
    const correctIndexes =
        result && Array.isArray(result.correctAnswer)
            ? (result.correctAnswer as number[])
            : [];

    return (
        <div className="stack">
            <div className="spread">
                <div>
                    <span className="label">{recommendation.topic.name}</span>
                    <div className="faint">
                        Question {index + 1} of {questions.length}
                    </div>
                </div>
                <span className={`pill pill--${question.difficulty}`}>
                    {question.difficulty}
                </span>
            </div>

            <div className="card stack">
                <p style={{ margin: 0, fontSize: '1.05rem' }}>{question.body}</p>

                {isMulti && !result && (
                    <p className="faint" style={{ margin: 0 }}>
                        Select every correct option — partial answers score nothing.
                    </p>
                )}

                {isChoice && question.options && (
                    <div className="stack" style={{ gap: 8 }}>
                        {question.options.map((option, optionIndex) => {
                            const chosen = selected.includes(optionIndex);
                            const isCorrect = correctIndexes.includes(optionIndex);

                            // After answering: mark every correct option, and mark a wrong
                            // option only if the learner picked it.
                            const marking = result
                                ? isCorrect
                                    ? ' option--correct'
                                    : chosen
                                      ? ' option--wrong'
                                      : ''
                                : '';

                            return (
                                <button
                                    key={optionIndex}
                                    type="button"
                                    className={`option${marking}`}
                                    aria-pressed={chosen}
                                    disabled={result !== null}
                                    onClick={() => toggleOption(optionIndex)}
                                >
                                    <span className="option__mark">
                                        {String.fromCharCode(65 + optionIndex)}
                                    </span>
                                    <span>{option}</span>
                                </button>
                            );
                        })}
                    </div>
                )}

                {!isChoice && (
                    <div className="field">
                        <label htmlFor="answer">Your answer</label>
                        <input
                            id="answer"
                            type="number"
                            step="any"
                            inputMode="decimal"
                            value={numericValue}
                            disabled={result !== null}
                            onChange={(e) => setNumericValue(e.target.value)}
                        />
                    </div>
                )}

                {submitError && (
                    <div className="banner banner--error">{submitError}</div>
                )}

                {!result && (
                    <button
                        type="button"
                        className="primary wide"
                        disabled={!canSubmit || submitting}
                        onClick={submit}
                    >
                        {submitting ? 'Checking…' : 'Submit answer'}
                    </button>
                )}
            </div>

            {result && (
                <div className="card stack">
                    <div
                        className={`banner banner--${result.isCorrect ? 'good' : 'error'}`}
                    >
                        <strong>
                            {result.isCorrect ? 'Correct' : 'Not quite'}
                        </strong>
                    </div>

                    {result.explanation && (
                        <div>
                            <span className="label">Why</span>
                            <p style={{ marginTop: 8, marginBottom: 0 }}>
                                {result.explanation}
                            </p>
                        </div>
                    )}

                    {/* The moment a learner is most likely to have a doubt is right after seeing
                        they got something wrong, so the tutor is offered here rather than only
                        from the menu. The topic and question travel with the link so the answer is
                        about this question, not the subject in general. */}
                    <Link
                        to={`/tutor?topic=${question.topic_id}&question=${encodeURIComponent(question.body)}`}
                        className="faint"
                    >
                        Still not clear? Ask Adigam about this question
                    </Link>

                    <MasteryChange mastery={result.mastery} />

                    {isLast ? (
                        <div className="stack" style={{ gap: 8 }}>
                            <button
                                type="button"
                                className="primary wide"
                                onClick={onExit}
                            >
                                Finish
                            </button>
                            <p className="faint" style={{ margin: 0, textAlign: 'center' }}>
                                Your mastery and streak are already updated.
                            </p>
                        </div>
                    ) : (
                        <button
                            type="button"
                            className="primary wide"
                            onClick={next}
                        >
                            Next question
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

/**
 * The payoff. Shows the score before, the score after, and the change — because "your mastery
 * went from 44 to 52" is the sentence that makes the whole system legible to a learner.
 */
function MasteryChange({ mastery }: { mastery: AttemptResult['mastery'] }) {
    const { before, after, change, attemptsOnTopic } = mastery;
    const rose = change !== null && change > 0;

    return (
        <div>
            <span className="label">Mastery on this topic</span>

            <div className="row" style={{ marginTop: 8, gap: 10 }}>
                {before !== null && (
                    <>
                        <span className="mono muted">{Math.round(before)}</span>
                        <span className="faint">→</span>
                    </>
                )}

                <span className="big mono">{Math.round(after)}</span>

                {change !== null && change !== 0 && (
                    <span
                        className="mono"
                        style={{ color: rose ? 'var(--good)' : 'var(--bad)' }}
                    >
                        {rose ? '+' : ''}
                        {change.toFixed(1)}
                    </span>
                )}
            </div>

            <div className="meter" style={{ marginTop: 8 }}>
                <div style={{ width: `${after}%` }} />
            </div>

            {/* Honest framing: early scores move a lot because there is little evidence, and a
                learner should understand that rather than reading a low number as a verdict. */}
            <p className="faint" style={{ marginTop: 8, marginBottom: 0 }}>
                Based on {attemptsOnTopic}{' '}
                {attemptsOnTopic === 1 ? 'attempt' : 'attempts'}. Scores move
                more while there is less evidence.
            </p>
        </div>
    );
}
