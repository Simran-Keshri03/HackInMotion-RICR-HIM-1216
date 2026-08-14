import { type FormEvent, useEffect, useState } from 'react';
import { Icon } from '@/components/Icon/Icon';
import { useNavigate } from 'react-router-dom';
import { Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { Curriculum, Goal, ResolveOutcome, Subject } from '@/types/api';

/**
 * What the learner is preparing for, by when, and with how much time per day.
 *
 * This is the input everything downstream depends on. Without a goal the adaptive engine falls
 * back to the entire syllabus, which is technically defensible and practically useless — a
 * learner sitting a DBMS paper next month does not want Probability questions.
 *
 * It asks in two steps, because the second question cannot be written until the first is
 * answered. A learner types what they are studying for in their own words — "class 10", "12th
 * boards", "GATE CSE" — and the model turns that into a syllabus. Only then does the app know
 * which subjects to offer. A fixed subject list would have to guess, and would be wrong for
 * everybody it did not guess for.
 *
 * Text that is not a study goal is refused here rather than accepted and left to produce an
 * empty app: "dog" comes back rejected with a reason, and the learner stays on step one.
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

/** The syllabus in view, and the subjects inside it. Null until step one is answered. */
interface Resolved {
    curriculum: Curriculum;
    subjects: Subject[];
}

export default function LearningGoals() {
    const navigate = useNavigate();

    const existing = useApi<{ goal: Goal | null }>(() =>
        api.get<{ goal: Goal | null }>('/goals')
    );

    // Step one.
    const [goalText, setGoalText] = useState('');
    const [resolving, setResolving] = useState(false);
    const [rejection, setRejection] = useState<string | null>(null);
    const [resolved, setResolved] = useState<Resolved | null>(null);

    // Step two.
    const [title, setTitle] = useState('');
    /**
     * The title this screen filled in by itself, so a later syllabus can replace it.
     *
     * Without it, "only fill the title when it is empty" silently keeps the wrong name: pick one
     * syllabus, go back, pick another, and the title still reads the first one's — which is then
     * what gets saved unless the learner notices and retypes it. Comparing against what was
     * auto-filled tells the two cases apart, so a name the learner actually wrote survives and one
     * this screen guessed does not.
     */
    const [autoTitle, setAutoTitle] = useState('');
    const [examDate, setExamDate] = useState(isoDaysFromNow(DEFAULT_DAYS_AHEAD));
    const [dailyMinutes, setDailyMinutes] = useState(DEFAULT_DAILY_MINUTES);
    const [chosen, setChosen] = useState<string[]>([]);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const current = existing.data?.goal ?? null;

    /**
     * Editing an existing goal skips step one: the syllabus is already decided, so its subjects
     * are fetched directly and the form opens filled in. Without this, changing an exam date
     * would mean re-answering "what are you studying for" and paying for a lookup to be told
     * something the goal already records.
     */
    const [prefilled, setPrefilled] = useState(false);

    useEffect(() => {
        if (prefilled || !current?.curriculumId) return;

        setPrefilled(true);
        setTitle(current.title);
        setExamDate(current.examDate);
        setDailyMinutes(current.dailyMinutes);
        setChosen(current.subjectIds);

        const curriculumId = current.curriculumId;

        void (async () => {
            try {
                const { subjects } = await api.get<{ subjects: Subject[] }>(
                    `/goals/subjects?curriculumId=${curriculumId}`
                );

                // The goal records a curriculum id, not its name, and the learner is not choosing
                // a syllabus on this path — so the heading uses their own goal title rather than
                // a second request to look up a name they already wrote.
                setResolved({
                    curriculum: {
                        id: curriculumId,
                        slug: '',
                        name: current.title,
                        description: null,
                        isAiGenerated: false,
                    },
                    subjects,
                });
            } catch (cause) {
                setError(
                    cause instanceof Error
                        ? cause.message
                        : 'Could not load your syllabus.'
                );
            }
        })();
    }, [current, prefilled]);

    const daysRemaining = daysUntil(examDate);
    const dateIsSane = !Number.isNaN(daysRemaining) && daysRemaining >= 1;
    const totalMinutes = dateIsSane ? daysRemaining * dailyMinutes : 0;
    const canSave = title.trim() !== '' && dateIsSane && chosen.length > 0;

    function toggleSubject(id: string) {
        setChosen((ids) =>
            ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
        );
    }

    /** Step one: hand what they typed to the model and see whether it names something studiable. */
    async function handleResolve(event: FormEvent) {
        event.preventDefault();

        const text = goalText.trim();
        if (text.length < 2 || resolving) return;

        setRejection(null);
        setError(null);
        setResolving(true);

        try {
            const outcome = await api.post<ResolveOutcome>('/curricula/resolve', {
                goalText: text,
            });

            if (outcome.status === 'rejected' || !outcome.curriculum) {
                setRejection(
                    outcome.message ??
                        'That does not look like something to study for. Try an exam, a class, or a subject.'
                );
                return;
            }

            setResolved({
                curriculum: outcome.curriculum,
                subjects: outcome.subjects ?? [],
            });

            /**
             * Nothing pre-picked. The learner chooses.
             *
             * This screen used to tick every subject in the syllabus, on the theory that most
             * people want all of it and narrowing is easier than building up. In use that theory
             * is wrong in a way that matters: a learner who wanted two subjects out of ten never
             * made a choice at all, and the engine — correctly following a goal covering
             * everything — sent them to the first topic of a subject they had not asked for. The
             * app looked like it had decided for them, because it had.
             *
             * Ten empty checkboxes ask a question. Ten ticked ones only look like an answer.
             */
            setChosen([]);

            // The name the model settled on reads better than the learner's phrasing
            // ("class-10" -> "Class 10"), and it is still theirs to edit.
            if (title.trim() === '' || title === autoTitle) {
                setTitle(outcome.curriculum.name);
                setAutoTitle(outcome.curriculum.name);
            }
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : 'Could not look that up. Try again.'
            );
        } finally {
            setResolving(false);
        }
    }

    async function handleSave(event: FormEvent) {
        event.preventDefault();

        if (!resolved) return;

        setError(null);
        setSaving(true);

        try {
            await api.post<{ goal: Goal }>('/goals', {
                title: title.trim(),
                curriculumId: resolved.curriculum.id,
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

    if (existing.loading) return <Loading label="Loading your goal…" />;

    if (existing.error) {
        return <Failed error={existing.error} onRetry={existing.reload} />;
    }

    // ---------------------------------------------------------------- step one
    if (!resolved) {
        return (
            <form className="stack" onSubmit={handleResolve}>
                <div className="spread" style={{ alignItems: 'flex-start', gap: 16 }}>
                    <div style={{ minWidth: 0 }}>
                    <span className="label">
                        {current ? 'Your goal' : 'Set your goal'}
                    </span>
                    <h1 style={{ marginBottom: 6 }}>What are you preparing for?</h1>
                    <p className="muted" style={{ margin: 0 }}>
                        Type it however you say it — <em>class 10</em>,{' '}
                        <em>12th boards</em>, <em>GATE CSE</em>. The syllabus is worked
                        out from that, and everything you practise comes from it.
                    </p>
                    </div>

                {/* The page's mark. Every screen has one so a page is recognisable at a glance
                    rather than being a heading above a stack of dark rectangles. Hidden on narrow
                    screens, where it would push the heading onto two awkward lines. */}
                    <span className="hero-mark" aria-hidden="true">
                        <Icon name="target" size={40} />
                    </span>
                </div>

                {rejection && <div className="banner banner--error">{rejection}</div>}
                {error && <div className="banner banner--error">{error}</div>}

                <div className="card stack">
                    <div className="field">
                        <label htmlFor="goalText">Exam, class, or subject</label>
                        <input
                            id="goalText"
                            value={goalText}
                            maxLength={120}
                            placeholder="class 10"
                            autoFocus
                            required
                            disabled={resolving}
                            onChange={(e) => setGoalText(e.target.value)}
                        />
                        <span className="faint">
                            A syllabus somebody has already looked up is instant. A new one
                            takes a few seconds to work out.
                        </span>
                    </div>

                    <button
                        type="submit"
                        className="primary wide"
                        disabled={resolving || goalText.trim().length < 2}
                    >
                        {resolving ? 'Working out your syllabus…' : 'Continue'}
                    </button>
                </div>

                {resolving && <Loading label="Reading the syllabus…" />}
            </form>
        );
    }

    // ---------------------------------------------------------------- step two
    const topicsChosen = resolved.subjects
        .filter((subject) => chosen.includes(subject.id))
        .reduce((total, subject) => total + subject.topicCount, 0);

    return (
        <form className="stack" onSubmit={handleSave}>
            <div>
                <span className="label">{resolved.curriculum.name}</span>
                <h1>How much time do you have?</h1>
                {resolved.curriculum.description && (
                    <p className="muted" style={{ margin: 0 }}>
                        {resolved.curriculum.description}
                    </p>
                )}
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
                        placeholder="Class 10 boards"
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
                    <span className="label">What do you want to study?</span>
                    <p className="faint" style={{ margin: '6px 0 0' }}>
                        Pick the subjects you are sitting. Only these will be practised —
                        questions never come from a subject you did not choose.
                    </p>
                </div>

                {resolved.subjects.map((subject) => {
                    const picked = chosen.includes(subject.id);

                    return (
                        <button
                            key={subject.id}
                            type="button"
                            className="option"
                            aria-pressed={picked}
                            onClick={() => toggleSubject(subject.id)}
                        >
                            <span className="option__mark">{picked ? '✓' : ''}</span>
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

                {resolved.subjects.length === 0 && (
                    <span className="faint">
                        This syllabus has no subjects yet. Pick a different goal.
                    </span>
                )}

                {resolved.subjects.length > 0 && chosen.length === 0 && (
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
                            <div className="big">{describeBudget(totalMinutes)}</div>
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
                            {describeBudget(Math.round(totalMinutes / topicsChosen))} per
                            topic, if you keep to it.
                        </p>
                    )}
                </div>
            )}

            <div className="row" style={{ gap: 10 }}>
                <button
                    type="button"
                    onClick={() => {
                        setResolved(null);
                        setChosen([]);
                        setRejection(null);
                        setError(null);
                    }}
                >
                    Change goal
                </button>

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
            </div>
        </form>
    );
}
