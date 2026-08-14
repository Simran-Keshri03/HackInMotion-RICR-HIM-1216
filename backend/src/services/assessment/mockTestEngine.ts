/**
 * Deciding what goes into a mock test: which topics, how many questions each, and what the score
 * means once it comes back.
 *
 * Pure, like every other engine here, and for the usual reason — a learner who sits a test deserves a
 * breakdown they can argue with, and an allocation that can be unit tested is one that can be
 * explained.
 *
 * The topics come from the **study plan**, which is the point of the feature: a test built from the
 * whole syllabus tells somebody they do not know things they were never asked to study yet, which is
 * demoralising and useless. A test built from what the plan has actually scheduled answers the
 * question the learner is really asking — *is the studying working?*
 */

export interface MockTestTopic {
    topicId: string;
    name: string;
    subjectName: string | null;
    /** Exam importance from the syllabus. */
    weight: number;
    /** 0-100, or null for a topic never attempted. */
    masteryScore: number | null;
    /** How many sessions the plan has scheduled on this topic. */
    plannedSessions: number;
    /** Verified questions available. An allocation cannot exceed this. */
    availableQuestions: number;
}

export interface TopicAllocation {
    topicId: string;
    name: string;
    subjectName: string | null;
    questionCount: number;
    /** Why this topic is in the test, for the screen before it starts. */
    reason: string;
}

export interface MockTestPlan {
    allocations: TopicAllocation[];
    totalQuestions: number;
    durationMinutes: number;
    /** Topics that could not be included, named rather than dropped in silence. */
    omitted: { name: string; reason: string }[];
}

export const MOCK_TEST_CONFIG = {
    /** Default length. Long enough to be a test, short enough to sit in one go on a phone. */
    defaultQuestions: 15,
    minQuestions: 5,
    maxQuestions: 30,

    /**
     * Most topics in one test.
     *
     * A test spread over fifteen topics is one question each, which measures nothing per topic and
     * gives a breakdown of pure noise. Six is enough to feel like a paper and enough for two or three
     * questions each to mean something.
     */
    maxTopics: 6,

    /** Fewest questions a topic can contribute and still appear in the breakdown. */
    minPerTopic: 2,

    /**
     * Seconds allowed per question when the learner has no measured pace yet.
     *
     * Deliberately more generous than the practice estimate: a test is answered without the answer
     * appearing after each question, so there is no natural pause, and a countdown that runs out
     * early turns a diagnostic into a stress test.
     */
    fallbackSecondsPerQuestion: 100,

    /** Score at or above which the test counts as passed, for the wording of the result. */
    passPercent: 60,
} as const;

/**
 * How much of the test a topic deserves.
 *
 * Three multiplied factors:
 *   planned    how much the plan has scheduled on it — this is what makes it a test *of the plan*
 *   gap        how far from mastered, so weak topics get more room than solid ones
 *   weight     exam importance
 *
 * A topic never attempted counts as a full gap rather than zero mastery: they are different things,
 * and zero would imply a measurement that was never taken.
 */
export function topicShare(topic: MockTestTopic): number {
    const gap = Math.max(0.2, (100 - (topic.masteryScore ?? 0)) / 100);
    const planned = 1 + Math.min(3, topic.plannedSessions) * 0.5;

    return gap * planned * Math.max(0.2, topic.weight);
}

/**
 * Builds the test.
 *
 * Returns an empty plan rather than throwing when nothing can be assembled — no topics in the plan,
 * or a question bank too thin to fill even one topic. Both are states a learner can be in, and the
 * screen should say so rather than show an error.
 */
export function planMockTest(
    topics: MockTestTopic[],
    requestedQuestions: number,
    secondsPerQuestion: number | null
): MockTestPlan {
    const { minQuestions, maxQuestions, maxTopics, minPerTopic, fallbackSecondsPerQuestion } =
        MOCK_TEST_CONFIG;

    const empty: MockTestPlan = {
        allocations: [],
        totalQuestions: 0,
        durationMinutes: 0,
        omitted: [],
    };

    const target = Math.min(maxQuestions, Math.max(minQuestions, Math.round(requestedQuestions)));

    const omitted: { name: string; reason: string }[] = [];

    // A topic with nothing in the bank cannot be tested. Said out loud, because a breakdown missing
    // the topic somebody most wanted to check reads as a bug.
    const usable = topics.filter((topic) => {
        if (topic.availableQuestions >= minPerTopic) return true;

        omitted.push({
            name: topic.name,
            reason:
                topic.availableQuestions === 0
                    ? 'has no questions yet'
                    : `has only ${topic.availableQuestions} question${topic.availableQuestions === 1 ? '' : 's'}, too few to test`,
        });

        return false;
    });

    if (usable.length === 0) return { ...empty, omitted };

    // Highest share first, then capped: the topics that matter most make the cut.
    const ranked = [...usable]
        .map((topic) => ({ topic, share: topicShare(topic) }))
        .sort((a, b) => b.share - a.share);

    const chosen = ranked.slice(0, maxTopics);

    for (const { topic } of ranked.slice(maxTopics)) {
        omitted.push({
            name: topic.name,
            reason: 'left out to keep the test short enough to be worth sitting',
        });
    }

    const totalShare = chosen.reduce((sum, entry) => sum + entry.share, 0);

    // ---- proportional split, then repair ----
    // Rounding a proportional split never lands on the target, and every topic also has a floor and a
    // ceiling of its own. So allocate roughly, then fix the difference one question at a time — which
    // is both easier to follow than a clever single pass and impossible to get wrong by one.
    const allocations = chosen.map(({ topic, share }) => {
        const ideal = Math.round((share / totalShare) * target);

        return {
            topic,
            count: Math.max(minPerTopic, Math.min(topic.availableQuestions, ideal || minPerTopic)),
        };
    });

    let total = allocations.reduce((sum, entry) => sum + entry.count, 0);

    // Too many: take from the largest allocation that can spare one.
    while (total > target) {
        const donor = allocations
            .filter((entry) => entry.count > minPerTopic)
            .sort((a, b) => b.count - a.count)[0];

        if (!donor) break;

        donor.count -= 1;
        total -= 1;
    }

    // Too few: give to the highest-share topic that still has questions left in the bank.
    while (total < target) {
        const taker = allocations
            .filter((entry) => entry.count < entry.topic.availableQuestions)
            .sort((a, b) => topicShare(b.topic) - topicShare(a.topic))[0];

        // The bank simply does not hold `target` questions across these topics. A shorter test is the
        // honest outcome, not a failure.
        if (!taker) break;

        taker.count += 1;
        total += 1;
    }

    const pace =
        secondsPerQuestion && secondsPerQuestion > 0
            ? Math.max(secondsPerQuestion, 45)
            : fallbackSecondsPerQuestion;

    return {
        allocations: allocations.map(({ topic, count }) => ({
            topicId: topic.topicId,
            name: topic.name,
            subjectName: topic.subjectName,
            questionCount: count,
            reason: allocationReason(topic),
        })),
        totalQuestions: total,
        durationMinutes: Math.max(1, Math.round((total * pace) / 60)),
        omitted,
    };
}

/** Why this topic is in the test. */
function allocationReason(topic: MockTestTopic): string {
    if (topic.masteryScore === null) {
        return `${topic.name} is scheduled in your plan and untested so far.`;
    }

    const mastery = Math.round(topic.masteryScore);

    if (mastery < 40) {
        return `${topic.name} is at mastery ${mastery} — this checks whether the practice is landing.`;
    }

    if (mastery < 75) {
        return `${topic.name} is at mastery ${mastery} and worth confirming under test conditions.`;
    }

    return `${topic.name} is at mastery ${mastery}; a few questions to prove it holds.`;
}

export interface MarkedQuestion {
    topicId: string | null;
    isCorrect: boolean;
    /** False for a question the learner skipped, which is not the same as getting it wrong. */
    answered: boolean;
}

export interface MockTestResult {
    correctCount: number;
    answeredCount: number;
    totalQuestions: number;
    scorePercent: number;
    passed: boolean;
    /** Per topic, so the learner knows where to go next rather than only how they did. */
    byTopic: {
        topicId: string;
        correct: number;
        total: number;
        percent: number;
    }[];
    /** The one thing worth doing off the back of this test. */
    verdict: string;
}

/**
 * Marks the sitting.
 *
 * A skipped question scores zero — it has to, or leaving questions blank would raise the percentage.
 * But `answeredCount` is reported separately, because "40% having answered everything" and "40%
 * having answered half" are different situations needing different advice.
 */
export function markMockTest(
    questions: MarkedQuestion[],
    topicNames: Map<string, string>
): MockTestResult {
    const total = questions.length;
    const correct = questions.filter((question) => question.isCorrect).length;
    const answered = questions.filter((question) => question.answered).length;

    const scorePercent = total > 0 ? Math.round((correct / total) * 1000) / 10 : 0;

    const grouped = new Map<string, { correct: number; total: number }>();

    for (const question of questions) {
        if (!question.topicId) continue;

        const entry = grouped.get(question.topicId) ?? { correct: 0, total: 0 };
        entry.total += 1;
        if (question.isCorrect) entry.correct += 1;

        grouped.set(question.topicId, entry);
    }

    const byTopic = [...grouped.entries()]
        .map(([topicId, entry]) => ({
            topicId,
            correct: entry.correct,
            total: entry.total,
            percent: Math.round((entry.correct / entry.total) * 1000) / 10,
        }))
        // Weakest first: the list is meant to be read as a to-do, and the top of a to-do list should
        // be the thing to do first.
        .sort((a, b) => a.percent - b.percent);

    return {
        correctCount: correct,
        answeredCount: answered,
        totalQuestions: total,
        scorePercent,
        passed: scorePercent >= MOCK_TEST_CONFIG.passPercent,
        byTopic,
        verdict: verdictFor(scorePercent, answered, total, byTopic, topicNames),
    };
}

/** One sentence of advice, naming the topic to go to next. */
function verdictFor(
    scorePercent: number,
    answered: number,
    total: number,
    byTopic: { topicId: string; percent: number }[],
    topicNames: Map<string, string>
): string {
    if (total === 0) return 'There was nothing to mark.';

    if (answered === 0) {
        return 'Nothing was answered, so there is nothing to read into this one.';
    }

    if (answered < total) {
        const skipped = total - answered;
        return `You left ${skipped} question${skipped === 1 ? '' : 's'} blank, so the score is lower than what you know. Worth sitting again with time to finish.`;
    }

    const weakest = byTopic[0];
    const weakestName = weakest ? topicNames.get(weakest.topicId) : null;

    if (scorePercent >= 85) {
        return 'Strong across the board. Your plan is working — keep going.';
    }

    if (weakest && weakestName && weakest.percent < 50) {
        return `${weakestName} is where this went wrong — ${weakest.percent}% of it. Start there.`;
    }

    if (scorePercent >= MOCK_TEST_CONFIG.passPercent) {
        return 'A pass, with room to tighten up. The breakdown below shows where.';
    }

    return 'Below where you want to be before the exam. The weakest topic is at the top of the list.';
}
