import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon/Icon';
import { Empty, Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { Readiness, ReadinessGap, ReadinessResponse } from '@/types/api';

/**
 * Exam readiness: one number, and then immediately the arithmetic behind it.
 *
 * The breakdown is not an optional detail view, it is the screen. A single figure with nothing behind
 * it is a horoscope — a learner told "61%" either ignores it or panics at it, and neither is a study
 * decision. So the components come first, each with the weight it carried and the sentence naming
 * what would move it.
 *
 * Two lists, not one, and they are labelled differently on purpose. What has been answered and is
 * still weak is evidence. What has never been opened is scored against an assumed mastery of zero,
 * which is a guess — a fair one for planning, but not the same kind of claim, and stacking them
 * together would dress the guesses up as measurements.
 *
 * The dial is a CSS conic gradient. A charting library for one arc would cost more gzipped than every
 * page in this app put together.
 */

const BAND_LABEL: Record<Readiness['band'], string> = {
    ready: 'On course',
    on_track: 'On track',
    building: 'Building',
    not_ready: 'Not ready yet',
};

/** Deliberately not red for a low score. A learner months out is *supposed* to be low. */
const BAND_TONE: Record<Readiness['band'], string> = {
    ready: 'ok',
    on_track: 'ok',
    building: 'warn',
    not_ready: 'warn',
};

const CONFIDENCE_NOTE: Record<Readiness['confidence'], string> = {
    low: 'Not much answered yet, so treat this as a first impression rather than a measurement.',
    medium: 'Enough answered to be meaningful. A mock test would firm it up.',
    high: 'Backed by a solid number of answers and at least one full paper.',
};

function GapList({
    title,
    note,
    gaps,
    masteryTarget,
}: {
    title: string;
    note: string;
    gaps: ReadinessGap[];
    masteryTarget: number;
}) {
    if (gaps.length === 0) return null;

    return (
        <div className="card stack">
            <div>
                <h2 style={{ margin: 0 }}>{title}</h2>
                <p className="faint" style={{ margin: '4px 0 0' }}>
                    {note}
                </p>
            </div>

            <div className="stack" style={{ gap: 8 }}>
                {gaps.map((gap) => (
                    <div key={gap.topicId} className="spread">
                        <span>
                            {gap.name}
                            {gap.subjectName && <span className="faint"> · {gap.subjectName}</span>}
                        </span>
                        <span className="muted" style={{ whiteSpace: 'nowrap' }}>
                            {gap.masteryScore === null
                                ? 'not attempted'
                                : `${Math.round(gap.masteryScore)} / ${masteryTarget}`}
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function ExamReadiness() {
    const readiness = useApi<ReadinessResponse>(() => api.get<ReadinessResponse>('/readiness'));

    if (readiness.loading) return <Loading label="Working out where you stand…" />;
    if (readiness.error) return <Failed error={readiness.error} onRetry={readiness.reload} />;

    const goal = readiness.data?.goal ?? null;
    const result = readiness.data?.readiness ?? null;
    const masteryTarget = readiness.data?.thresholds?.masteryTarget ?? 85;

    // ------------------------------------------------------------------ no goal yet
    if (!goal || !result) {
        return (
            <div className="stack">
                <div>
                    <span className="label">Exam readiness</span>
                    <h1>Nothing to measure yet</h1>
                </div>

                <Empty title="Set a goal first">
                    <p className="muted" style={{ margin: 0 }}>
                        Readiness is measured against a syllabus and a date. Name what you are
                        preparing for and this fills in as you answer questions.
                    </p>
                    <p className="faint" style={{ marginTop: 10, marginBottom: 0 }}>
                        <Link to="/goals">Set your goal</Link>
                    </p>
                </Empty>
            </div>
        );
    }

    return (
        <div className="stack">
            <div>
                <span className="label">Exam readiness</span>
                <h1>{goal.title}</h1>
                <p className="faint" style={{ margin: '4px 0 0' }}>
                    {result.daysRemaining > 0
                        ? `${result.daysRemaining} days to ${goal.examDate}`
                        : `Exam date ${goal.examDate}`}
                </p>
            </div>

            {/* The score, the band, and the verdict together. The verdict is the part worth reading:
                it names the weakest component rather than restating the number. */}
            <div className="card card--glow stack">
                <div className="row" style={{ gap: 20, alignItems: 'center' }}>
                    <div
                        className={`dial dial--${BAND_TONE[result.band]}`}
                        style={{ ['--dial' as string]: `${result.score}%` }}
                        role="img"
                        aria-label={`Readiness ${result.score} out of 100`}
                    >
                        <span className="dial__value">{Math.round(result.score)}</span>
                    </div>

                    <div className="stack" style={{ gap: 6, flex: 1, minWidth: 0 }}>
                        <strong style={{ fontSize: 18 }}>{BAND_LABEL[result.band]}</strong>
                        <p style={{ margin: 0 }}>{result.verdict}</p>
                        <p className="faint" style={{ margin: 0 }}>
                            {CONFIDENCE_NOTE[result.confidence]}
                        </p>
                    </div>
                </div>

                <div className="row row--between faint" style={{ flexWrap: 'wrap', gap: 12 }}>
                    <span>
                        {result.topicsAttempted} of {result.topicsInScope} topics started
                    </span>
                    <span>{result.topicsMastered} mastered</span>
                    <span>
                        {result.mocksTaken === 0
                            ? 'no mock tests yet'
                            : `${result.mocksTaken} mock ${
                                  result.mocksTaken === 1 ? 'test' : 'tests'
                              }`}
                    </span>
                </div>
            </div>

            {/* Every component, with the weight it actually carried. Weights are renormalised
                server-side when a component is missing, so they always add to 100% here. */}
            <div className="card stack">
                <div>
                    <h2 style={{ margin: 0 }}>How that number is made</h2>
                    <p className="faint" style={{ margin: '4px 0 0' }}>
                        Four parts, each weighted. Anything that cannot be measured yet is left out
                        and the rest reweighted — never counted as zero.
                    </p>
                </div>

                <div className="stack" style={{ gap: 14 }}>
                    {result.components.map((component) => (
                        <div key={component.key} className="stack" style={{ gap: 6 }}>
                            <div className="spread">
                                <strong>{component.label}</strong>
                                <span className="muted">
                                    {Math.round(component.score)}
                                    <span className="faint">
                                        {' '}
                                        · {Math.round(component.weight * 100)}% of the score
                                    </span>
                                </span>
                            </div>

                            <div className="meter">
                                <div style={{ width: `${component.score}%` }} />
                            </div>

                            <p className="faint" style={{ margin: 0 }}>
                                {component.detail}
                            </p>
                        </div>
                    ))}
                </div>
            </div>

            <GapList
                title="Costing you the most"
                note="Answered, and still short of the target. These are measured."
                gaps={result.gaps}
                masteryTarget={masteryTarget}
            />

            <GapList
                title="Heaviest topics not started"
                note="Never attempted, so their cost assumes you know none of it. Starting one may prove otherwise."
                gaps={result.notStarted}
                masteryTarget={masteryTarget}
            />

            {/* Readiness answers "where do I stand"; it deliberately does not decide what to do next.
                That is the recommendation engine's job, and duplicating it here would let the two
                disagree. */}
            <div className="card stack">
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                    <span className="tile tile--violet">
                        <Icon name="target" />
                    </span>
                    <div className="stack" style={{ gap: 4 }}>
                        <strong>Move the number</strong>
                        <p className="faint" style={{ margin: 0 }}>
                            Your plan already schedules the weakest and heaviest topics first, and a
                            mock test is the fastest way to firm this up.
                        </p>
                        <p className="faint" style={{ margin: 0 }}>
                            <Link to="/plan">Open your plan</Link> ·{' '}
                            <Link to="/mock-tests">Sit a mock test</Link>
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
