import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Empty, Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import { PracticeSession } from '@/pages/Practice/PracticeSession';
import type { GoalSubject } from '@/types/api';

/**
 * Practice: pick a subject, or let the engine pick for you.
 *
 * The subjects are the ones from the learner's **goal**, not the whole syllabus. Offering subjects
 * they deliberately left out would undo the choice the goal screen exists to let them make.
 *
 * Both routes in are here on purpose. Choosing a subject is what somebody wants when they know what
 * today is for — a Databases test on Friday. Letting the engine choose is what the product is
 * actually for, and it stays the first and most prominent option because "the weakest thing across
 * everything you are studying" is a better answer than anything a learner picks by mood.
 *
 * Progress on each card is **topics started**, not average mastery. A subject whose topics are mostly
 * untouched has a low average, which on a bar is indistinguishable from "you are bad at this" when the
 * truth is "you have not begun". Coverage is the honest number; mastery is shown next to it in words.
 */
export default function Practice() {
    const subjects = useApi<{ subjects: GoalSubject[] }>(() =>
        api.get<{ subjects: GoalSubject[] }>('/learner/subjects')
    );

    /**
     * Null means the picker; a `{ subjectId }` object means a session is running.
     *
     * An object rather than a plain string, because `null` has to mean "not started" while the
     * adaptive path legitimately runs with no subject id at all.
     */
    const [running, setRunning] = useState<{ subjectId: string | null } | null>(null);

    if (running) {
        return (
            <PracticeSession
                subjectId={running.subjectId}
                // Back to the picker, not the dashboard. Finishing a set and wanting another is the
                // common case, and this screen is now the only place practice starts from.
                onExit={() => {
                    setRunning(null);
                    subjects.reload();
                }}
            />
        );
    }

    if (subjects.loading) return <Loading label="Loading your subjects…" />;
    if (subjects.error) {
        return <Failed error={subjects.error} onRetry={subjects.reload} />;
    }

    const list = subjects.data?.subjects ?? [];

    if (list.length === 0) {
        return (
            <div className="stack">
                <div>
                    <span className="label">Practice</span>
                    <h1>Nothing to practise yet</h1>
                </div>

                <Empty title="Set a goal first">
                    <p className="muted" style={{ margin: 0 }}>
                        Practice is drawn from the subjects in your goal. Tell us what you
                        are preparing for and they will appear here.
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
                <span className="label">Practice</span>
                <h1>Practice by subject</h1>
                <p className="muted" style={{ margin: 0 }}>
                    Pick a subject, or let Adigam choose the topic you need most.
                </p>
            </div>

            {/* First, and deliberately. The adaptive choice is the product; a subject grid is the
                convenience next to it. */}
            <div className="card card--accent stack">
                <div>
                    <span className="label">Recommended</span>
                    <p style={{ margin: '6px 0 0' }}>
                        Across everything in your goal, weakest and most overdue first.
                    </p>
                </div>
                <button
                    type="button"
                    className="primary wide"
                    onClick={() => setRunning({ subjectId: null })}
                >
                    Start practice
                </button>
            </div>

            <div className="subjects">
                {list.map((subject) => (
                    <SubjectCard
                        key={subject.id}
                        subject={subject}
                        onStart={() => setRunning({ subjectId: subject.id })}
                    />
                ))}
            </div>
        </div>
    );
}

function SubjectCard({
    subject,
    onStart,
}: {
    subject: GoalSubject;
    onStart: () => void;
}) {
    const coverage =
        subject.topicCount > 0
            ? Math.round((subject.topicsStarted / subject.topicCount) * 100)
            : 0;

    return (
        <div className="card stack" style={{ gap: 10 }}>
            <div className="spread" style={{ alignItems: 'flex-start', gap: 8 }}>
                <strong>{subject.name}</strong>
                {/* Exam weight, not difficulty. It is what the planner and the ranking actually
                    multiply by, so showing anything else here would be decoration that disagrees
                    with how the app behaves. */}
                {subject.weight >= 1.3 && <span className="pill pill--hard">high weight</span>}
            </div>

            <div>
                <div className="subjects__bar">
                    <span style={{ width: `${coverage}%` }} />
                </div>
                <div className="faint" style={{ marginTop: 6 }}>
                    {subject.topicsStarted} of {subject.topicCount} topics started
                    {subject.averageMastery !== null && (
                        <> · mastery {Math.round(subject.averageMastery)}</>
                    )}
                    {subject.topicsMastered > 0 && (
                        <> · {subject.topicsMastered} mastered</>
                    )}
                </div>
            </div>

            <button type="button" className="primary wide" onClick={onStart}>
                Start practice
            </button>
        </div>
    );
}
