import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { Goal, Subject } from '@/types/api';

/**
 * What the learner is preparing for, by when, and with how much time per day.
 *
 * This is the input everything downstream depends on. Without a goal the adaptive engine falls
 * back to the entire syllabus, which is technically defensible and practically useless — a
 * learner sitting a DBMS paper next month does not want Probability questions.
 *
 * The daily budget is shown as it is typed rather than after saving. "60 minutes a day" means
 * nothing on its own; "45 hours before the exam" is a number a person can judge, and judging it
 * before committing is the whole point of asking.
 */

/** A sensible default: far enough to plan around, near enough to feel real. */
const DEFAULT_DAYS_AHEAD = 45;
const DEFAULT_DAILY_MINUTES = 60;

function isoDaysFromNow(days: number): string {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toISOString().slice(0, 10);
}

/** Whole days from today, counted in UTC so the answer does not shift with the clock. */
function daysUntil(isoDate: string): number {
    const target = Date.parse(`${isoDate}T00:00:00Z`);
    if (Number.isNaN(target)) return Number.NaN;

    const now = new Date();
    const today = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate()
    );

    return Math.round((target - today) / 86_400_000);
}

function describeBudget(minutes: number): string {
    if (minutes < 60) return `${minutes} minutes`;

    const hours = Math.round(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

export default function LearningGoals() {
    const navigate = useNavigate();

    const subjects = useApi<{ subjects: Subject[] }>(() =>
        api.get<{ subjects: Subject[] }>('/goals/subjects')
    );
    const existing = useApi<{ goal: Goal | null }>(() =>
        api.get<{ goal: Goal | null }>('/goals')
    );

    const [title, setTitle] = useState('');
    const [examDate, setExamDate] = useState(isoDaysFromNow(DEFAULT_DAYS_AHEAD));
    const [dailyMinutes, setDailyMinutes] = useState(DEFAULT_DAILY_MINUTES);
    const [chosen, setChosen] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Prefill from the current goal the first time it arrives, so editing does not start from a
    // blank form. Guarded on `title` rather than a separate flag: once the learner has typed
    // anything, their input is never overwritten by a late response.
    const current = existing.data?.goal ?? null;
    const [prefilled, setPrefilled] = useState(false);

    if (current && !prefilled) {
        setPrefilled(true);
        setTitle(current.title);
        setExamDate(current.examDate);
        setDailyMinutes(current.dailyMinutes);
        setChosen(current.subjectIds);
    }

    const daysRemaining = daysUntil(examDate);
    const dateIsSane = !Number.isNaN(daysRemaining) && daysRemaining >= 1;
    const totalMinutes = dateIsSane ? daysRemaining * dailyMinutes : 0;
    const canSave = title.trim() !== '' && dateIsSane && chosen.length > 0;

    function toggleSubject(id: string) {
        setChosen((ids) =>
            ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
        );
    }

    async function handleSubmit(event: FormEvent) {
        event.preventDefault();
        setError(null);
        setSaving(true);

        try {
            await api.post<{ goal: Goal }>('/goals', {
                title: title.trim(),
                examDate,
                dailyMinutes,
                subjectIds: chosen,
            });

            navigate('/dashboard', { replace: true });
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : 'Could not save your goal.'
            );
        } finally {
            setSaving(false);
        }
    }

    if (subjects.loading || existing.loading) {
        return <Loading label="Loading subjects…" />;
    }

    if (subjects.error) {
        return <Failed error={subjects.error} onRetry={subjects.reload} />;
    }

    const topicsChosen = (subjects.data?.subjects ?? [])
        .filter((subject) => chosen.includes(subject.id))
        .reduce((total, subject) => total + subject.topicCount, 0);

    return (
        <form className="stack" onSubmit={handleSubmit}>
            <div>
                <span className="label">
                    {current ? 'Your goal' : 'Set your goal'}
                </span>
                <h1>What are you preparing for?</h1>
                <p className="muted" style={{ margin: 0 }}>
                    Everything else follows from this — which topics you practise, how
                    hard the questions are, and how much you need to cover each day.
                </p>
            </div>

            {error && <div className="banner banner--error">{error}</div>}

            {current && (
                <div className="banner">
                    Saving replaces your current goal. Your answers and mastery scores
                    are kept.
                </div>
            )}

            <div className="card stack">
                <div className="field">
                    <label htmlFor="title">Exam or goal name</label>
                    <input
                        id="title"
                        value={title}
                        maxLength={120}
                        placeholder="DBMS endsem"
                        required
                        onChange={(e) => setTitle(e.target.value)}
                    />
                </div>

                <div className="field">
                    <label htmlFor="examDate">Exam date</label>
                    {/* Native date input: every browser and phone already has a good one, and
                        a picker library would cost more than this whole page. */}
                    <input
                        id="examDate"
                        type="date"
                        value={examDate}
                        min={isoDaysFromNow(1)}
                        required
                        onChange={(e) => setExamDate(e.target.value)}
                    />
                    {dateIsSane ? (
                        <span className="faint">
                            {daysRemaining}{' '}
                            {daysRemaining === 1 ? 'day' : 'days'} from today
                        </span>
                    ) : (
                        <span className="faint" style={{ color: 'var(--bad)' }}>
                            Pick a date in the future.
                        </span>
                    )}
                </div>

                <div className="field">
                    <label htmlFor="dailyMinutes">Minutes you can study per day</label>
                    <input
                        id="dailyMinutes"
                        type="number"
                        min={10}
                        max={960}
                        step={5}
                        value={dailyMinutes}
                        required
                        onChange={(e) =>
                            setDailyMinutes(Number(e.target.value) || 0)
                        }
                    />
                    <span className="faint">
                        Be honest — the plan is only useful if this is a number you will
                        actually hit.
                    </span>
                </div>
            </div>

            <div className="card stack">
                <div>
                    <span className="label">Subjects</span>
                    <p className="faint" style={{ margin: '6px 0 0' }}>
                        Only topics inside the subjects you pick will be practised.
                    </p>
                </div>

                {(subjects.data?.subjects ?? []).map((subject) => {
                    const picked = chosen.includes(subject.id);

                    return (
                        <button
                            key={subject.id}
                            type="button"
                            className="option"
                            aria-pressed={picked}
                            onClick={() => toggleSubject(subject.id)}
                        >
                            <span className="option__mark">
                                {picked ? '✓' : ''}
                            </span>
                            <span>
                                {subject.name}
                                <span className="faint">
                                    {' — '}
                                    {subject.topicCount} topics
                                </span>
                            </span>
                        </button>
                    );
                })}

                {chosen.length === 0 && (
                    <span className="faint">Pick at least one subject.</span>
                )}
            </div>

            {/* The budget, before committing to it. A daily target only means something next to
                the total it adds up to. */}
            {canSave && (
                <div className="card card--accent">
                    <span className="label">Your study budget</span>
                    <div className="row" style={{ marginTop: 12, gap: 28 }}>
                        <div>
                            <div className="big">{daysRemaining}</div>
                            <div className="faint">days left</div>
                        </div>
                        <div>
                            <div className="big">
                                {describeBudget(totalMinutes)}
                            </div>
                            <div className="faint">total study time</div>
                        </div>
                        <div>
                            <div className="big">{topicsChosen}</div>
                            <div className="faint">topics to cover</div>
                        </div>
                    </div>
                    {topicsChosen > 0 && (
                        <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                            About{' '}
                            {describeBudget(
                                Math.round(totalMinutes / topicsChosen)
                            )}{' '}
                            per topic, if you keep to it.
                        </p>
                    )}
                </div>
            )}

            <button
                type="submit"
                className="primary wide"
                disabled={!canSave || saving}
            >
                {saving
                    ? 'Saving…'
                    : current
                      ? 'Update goal'
                      : 'Save goal and start'}
            </button>
        </form>
    );
}
