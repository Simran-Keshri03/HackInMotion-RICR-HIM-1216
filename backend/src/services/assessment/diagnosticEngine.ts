/**
 * The diagnostic: the sitting that establishes what a learner already knows, before any plan exists.
 *
 * This is the missing input to the study plan generator. The plan prioritises weak areas by comparing
 * each topic's mastery against a target — and for a learner who has just set a goal there is no mastery
 * at all, so every topic reports an identical full gap and the ranking collapses to exam weight alone.
 * Concretely, with the plan's own formula:
 *
 *   no assessment      Algorithms (w 1.5) 1.500   Digital Logic (w 1.0) 1.000   Aptitude (w 0.8) 0.800
 *   after a diagnostic Algorithms (m 72)  0.229   Digital Logic (m 18)  0.788   Aptitude (m 55)  0.282
 *
 * In the first row the order is just the weights. In the second, Digital Logic outranks a heavier
 * subject because the learner is actually weak at it — which is the behaviour the brief asks for and
 * which is impossible to produce without measuring first.
 *
 * Selection here is therefore **broad, not deep**, and that is the whole design. Practice picks several
 * questions on one topic to move mastery; a mock test picks a few topics to produce a score. A
 * diagnostic has a different job: find out *where* the learner is weak, which means covering as many
 * topics as the paper allows, one question each. Three questions on Trees tell you a lot about Trees
 * and nothing about the other eleven topics you could have asked about instead.
 *
 * Pure, like every other engine here.
 */

export interface DiagnosticTopic {
    topicId: string;
    name: string;
    subjectId: string;
    subjectName: string;
    /** Exam importance of the subject this topic belongs to. */
    subjectWeight: number;
    /** Verified questions available on this topic. */
    availableQuestions: number;
}

export interface DiagnosticPick {
    topicId: string;
    topicName: string;
    subjectId: string;
    subjectName: string;
    position: number;
}

export interface DiagnosticPlan {
    picks: DiagnosticPick[];
    /** Subjects the paper covers, with how many questions each got. */
    coverage: { subjectId: string; subjectName: string; questionCount: number }[];
    /** Subjects that could not be covered at all, named rather than silently absent. */
    uncovered: { subjectName: string; reason: string }[];
}

export const DIAGNOSTIC_CONFIG = {
    /**
     * Length of the paper.
     *
     * Fifteen is a compromise with a specific shape. Fewer than about ten and a subject with two
     * questions can be judged by a coin flip; many more and a learner abandons the thing standing
     * between them and their first plan, which is worse than a slightly noisier measurement.
     */
    defaultQuestions: 15,
    minQuestions: 6,
    maxQuestions: 25,

    /**
     * Most questions any one subject may take.
     *
     * Without a cap, a syllabus with one deep subject and five thin ones spends the whole paper on the
     * deep one and reports nothing about the rest — the exact failure a diagnostic exists to avoid.
     */
    maxPerSubject: 4,

    /** One question per topic. Depth is what practice is for. */
    maxPerTopic: 1,

    /**
     * Minutes allowed per question.
     *
     * More generous than practice, because a learner sitting this has never seen the interface and is
     * being measured on material they may not have studied yet. Rushing a diagnostic produces a
     * pessimistic picture, and a pessimistic picture becomes a plan that wastes their time on things
     * they already knew.
     */
    secondsPerQuestion: 75,
} as const;

/**
 * Chooses the paper.
 *
 * Round-robins across subjects rather than filling one at a time, so a paper cut short by a thin
 * question bank still covers breadth. Subjects are visited heaviest-first, which means when there are
 * more subjects than questions the ones that matter most to the exam are the ones measured.
 */
export function planDiagnostic(
    topics: DiagnosticTopic[],
    requestedQuestions: number
): DiagnosticPlan {
    const { minQuestions, maxQuestions, maxPerSubject } = DIAGNOSTIC_CONFIG;

    const target = Math.min(maxQuestions, Math.max(minQuestions, Math.round(requestedQuestions)));

    const uncovered: { subjectName: string; reason: string }[] = [];

    // A topic with no verified questions cannot be measured.
    const usable = topics.filter((topic) => topic.availableQuestions > 0);

    // Group by subject so the paper can be spread across them.
    const bySubject = new Map<string, DiagnosticTopic[]>();

    for (const topic of usable) {
        bySubject.set(topic.subjectId, [...(bySubject.get(topic.subjectId) ?? []), topic]);
    }

    // Any subject in the goal with nothing measurable is named, because a breakdown missing a subject
    // the learner cares about reads as a bug rather than as an empty question bank.
    const seen = new Set(usable.map((topic) => topic.subjectId));

    for (const topic of topics) {
        if (seen.has(topic.subjectId)) continue;
        if (uncovered.some((entry) => entry.subjectName === topic.subjectName)) continue;

        uncovered.push({
            subjectName: topic.subjectName,
            reason: 'has no questions yet, so it could not be assessed',
        });
    }

    if (bySubject.size === 0) {
        return { picks: [], coverage: [], uncovered };
    }

    // Heaviest subject first: when questions run out, the exam's biggest parts are the measured ones.
    const subjects = [...bySubject.entries()]
        .map(([subjectId, list]) => ({
            subjectId,
            subjectName: list[0]!.subjectName,
            weight: list[0]!.subjectWeight,
            // Within a subject, take the topics with the deepest banks first — they are the most
            // likely to actually yield a question.
            queue: [...list].sort((a, b) => b.availableQuestions - a.availableQuestions),
        }))
        .sort((a, b) => b.weight - a.weight);

    const picks: DiagnosticPick[] = [];
    const takenPerSubject = new Map<string, number>();

    // Round-robin. Each pass takes at most one question from each subject, so breadth is established
    // before any subject gets a second question.
    let progressed = true;

    while (picks.length < target && progressed) {
        progressed = false;

        for (const subject of subjects) {
            if (picks.length >= target) break;

            const taken = takenPerSubject.get(subject.subjectId) ?? 0;
            if (taken >= maxPerSubject) continue;

            const topic = subject.queue.shift();
            if (!topic) continue;

            picks.push({
                topicId: topic.topicId,
                topicName: topic.name,
                subjectId: subject.subjectId,
                subjectName: subject.subjectName,
                position: picks.length + 1,
            });

            takenPerSubject.set(subject.subjectId, taken + 1);
            progressed = true;
        }
    }

    const coverage = [...takenPerSubject.entries()].map(([subjectId, questionCount]) => ({
        subjectId,
        subjectName:
            subjects.find((subject) => subject.subjectId === subjectId)?.subjectName ?? 'Subject',
        questionCount,
    }));

    return { picks, coverage, uncovered };
}

export interface DiagnosticAnswer {
    topicId: string;
    subjectId: string;
    subjectName: string;
    isCorrect: boolean;
    /** False for a question the learner skipped. */
    answered: boolean;
}

/** Where a subject sits, in words a learner can act on. */
export type KnowledgeLevel = 'strong' | 'moderate' | 'weak' | 'unmeasured';

export interface SubjectLevel {
    subjectId: string;
    subjectName: string;
    correct: number;
    total: number;
    percent: number;
    level: KnowledgeLevel;
}

export interface DiagnosticResult {
    correctCount: number;
    answeredCount: number;
    totalQuestions: number;
    accuracyPercent: number;
    /** Weakest subject first — the order the plan will spend time in. */
    subjects: SubjectLevel[];
    /** One sentence connecting the result to what happens next. */
    verdict: string;
}

/**
 * Thresholds for the words.
 *
 * Deliberately coarse. A diagnostic asks two to four questions per subject, so reporting "63%" would
 * imply a precision that three questions cannot support — and a learner reading a precise number treats
 * it as a verdict rather than as a starting point. Three bands is about what the evidence justifies.
 *
 * Note these are *not* used to write mastery. Mastery comes from the attempts the diagnostic records,
 * through the same formula every other answer goes through. Deriving a second "assessed level" and
 * storing it would be a number that could drift from the attempts behind it.
 */
const STRONG_AT = 75;
const WEAK_BELOW = 45;

function levelFor(percent: number, total: number): KnowledgeLevel {
    if (total === 0) return 'unmeasured';
    if (percent >= STRONG_AT) return 'strong';
    if (percent < WEAK_BELOW) return 'weak';

    return 'moderate';
}

/**
 * Summarises the sitting.
 *
 * A skipped question counts as wrong for the score — otherwise skipping would raise it — but is
 * reported separately, because a diagnostic somebody half-answered should not be read as a measurement
 * of what they know.
 */
export function summariseDiagnostic(answers: DiagnosticAnswer[]): DiagnosticResult {
    const total = answers.length;
    const correct = answers.filter((answer) => answer.isCorrect).length;
    const answered = answers.filter((answer) => answer.answered).length;

    const grouped = new Map<string, { name: string; correct: number; total: number }>();

    for (const answer of answers) {
        const entry = grouped.get(answer.subjectId) ?? {
            name: answer.subjectName,
            correct: 0,
            total: 0,
        };

        entry.total += 1;
        if (answer.isCorrect) entry.correct += 1;

        grouped.set(answer.subjectId, entry);
    }

    const subjects = [...grouped.entries()]
        .map(([subjectId, entry]) => {
            const percent =
                entry.total > 0 ? Math.round((entry.correct / entry.total) * 1000) / 10 : 0;

            return {
                subjectId,
                subjectName: entry.name,
                correct: entry.correct,
                total: entry.total,
                percent,
                level: levelFor(percent, entry.total),
            };
        })
        // Weakest first: this list is read as "what your plan will start with", so the top of it should
        // be what the plan actually starts with.
        .sort((a, b) => a.percent - b.percent);

    return {
        correctCount: correct,
        answeredCount: answered,
        totalQuestions: total,
        accuracyPercent: total > 0 ? Math.round((correct / total) * 1000) / 10 : 0,
        subjects,
        verdict: verdictFor(subjects, answered, total),
    };
}

function verdictFor(subjects: SubjectLevel[], answered: number, total: number): string {
    if (total === 0) return 'There was nothing to assess.';

    if (answered === 0) {
        return 'Nothing was answered, so your plan will start from scratch rather than from this.';
    }

    if (answered < total) {
        const skipped = total - answered;
        return `You left ${skipped} question${skipped === 1 ? '' : 's'} blank. Your plan will treat those topics as unknown, which is safe but means more time on them than you may need.`;
    }

    const weak = subjects.filter((subject) => subject.level === 'weak');
    const strong = subjects.filter((subject) => subject.level === 'strong');

    if (weak.length > 0) {
        const named = weak
            .slice(0, 2)
            .map((subject) => subject.subjectName)
            .join(' and ');

        return `Your plan will start with ${named}. That is where the time is worth spending.`;
    }

    if (strong.length === subjects.length) {
        return 'Solid across everything measured. Your plan will keep it that way rather than teaching you what you already know.';
    }

    return 'A reasonable starting point. Your plan will spend the most time where this went least well.';
}
