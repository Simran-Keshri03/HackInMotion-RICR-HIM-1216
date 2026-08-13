import {
    type Difficulty,
    chooseDifficulty,
} from '@/services/adaptive/difficultyEngine.js';

/**
 * Decides the single next best thing for a learner to do.
 *
 * This is the part that makes Adigam an assistant rather than a question list. Given every
 * topic in the learner's goal and what is known about each, it ranks them and turns the
 * winner into a concrete instruction: this topic, this many questions, at this difficulty,
 * for about this long, and here is why.
 *
 * Deterministic. No AI is involved in the decision -- Claude is only ever asked to explain
 * a decision that has already been made here, so the reasoning stays inspectable and the
 * same inputs always give the same answer.
 */

export const ADAPTIVE_CONFIG = {
    /**
     * How the ranking score is built. Both parts are 0 to 1 and are then multiplied by the
     * topic's own exam weight, so an important topic outranks a trivial one at equal need.
     */
    weights: {
        /** How far mastery is from complete. The main driver. */
        masteryGap: 0.7,
        /** How long since the learner touched it. Stops one topic hogging every session. */
        staleness: 0.3,
    },

    /** Days without practice at which staleness counts as maximum. */
    stalenessSaturatesAtDays: 14,

    /** A topic at or above this mastery is considered learned for planning purposes. */
    masteryConsideredSolid: 75,

    /**
     * Finish what you started. An unattempted topic scores maximum on both need and
     * staleness -- nothing is known about it and it has been waiting since day one -- so
     * without this rule the engine opens a new topic every session and never returns to
     * fix a weak one. While any started topic sits below this mastery, new topics wait.
     *
     * Initial breadth is the diagnostic assessment's job, not the session engine's.
     */
    masteryFloorBeforeNewTopics: 50,

    /**
     * Revision territory: mastery is solid, but it has been sitting untouched this long.
     * Practising it again is worth more than pushing a topic that is already fine.
     */
    reviseAfterIdleDays: 10,

    /** How many questions each kind of session serves. */
    questionCounts: {
        learnNew: 3,
        practice: 5,
        revise: 4,
        miniTest: 10,
    },

    /** Fallback pace when we do not yet know how fast this learner answers. */
    defaultSecondsPerQuestion: 90,

    /** Never promise a session shorter than this; rounding to zero minutes looks broken. */
    minEstimatedMinutes: 2,

    /** How many runners-up to hand back alongside the recommendation. */
    alternativesReturned: 2,
} as const;

export type LearningAction = 'learn_new' | 'practice' | 'revise' | 'mini_test';

/** One topic in the learner's scope, with whatever is known about it. */
export interface TopicCandidate {
    topicId: string;
    name: string;
    /** The topic's exam importance, straight from topics.weight. */
    weight: number;
    /** Null when the learner has never attempted this topic. */
    masteryScore: number | null;
    recentAccuracy: number | null;
    recentAttempts: number;
    totalAttempts: number;
    daysSinceLastAttempt: number | null;
}

export interface RecommendationInput {
    candidates: TopicCandidate[];
    /** From the learner profile; null until they have answered enough to measure. */
    secondsPerQuestion: number | null;
    /** Minutes the learner says they have right now, if they said. */
    availableMinutes: number | null;
}

export interface RankedTopic {
    topicId: string;
    name: string;
    score: number;
    masteryScore: number | null;
}

export interface NextBestAction {
    action: LearningAction;
    topic: { id: string; name: string };
    difficulty: Difficulty;
    questionCount: number;
    estimatedMinutes: number;
    /** One sentence, assembled from the same numbers the decision used. */
    reason: string;
    signals: {
        masteryScore: number | null;
        recentAccuracyPercent: number | null;
        totalAttempts: number;
        daysSinceLastAttempt: number | null;
    };
    alternatives: RankedTopic[];
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/**
 * How badly this topic needs attention. An unattempted topic is treated as a full gap,
 * because unknown is not the same as fine.
 */
export function priorityScore(candidate: TopicCandidate): number {
    const { weights, stalenessSaturatesAtDays } = ADAPTIVE_CONFIG;

    const gap =
        candidate.masteryScore === null
            ? 1
            : clamp01((100 - candidate.masteryScore) / 100);

    // Never attempted counts as maximally stale: it has been waiting since day one.
    const staleness =
        candidate.daysSinceLastAttempt === null
            ? 1
            : clamp01(candidate.daysSinceLastAttempt / stalenessSaturatesAtDays);

    return (
        (weights.masteryGap * gap + weights.staleness * staleness) *
        candidate.weight
    );
}

/** Which kind of session this topic calls for. */
function chooseAction(candidate: TopicCandidate): LearningAction {
    const { masteryConsideredSolid, reviseAfterIdleDays } = ADAPTIVE_CONFIG;

    if (candidate.totalAttempts === 0) return 'learn_new';

    const isSolid = (candidate.masteryScore ?? 0) >= masteryConsideredSolid;
    const isIdle = (candidate.daysSinceLastAttempt ?? 0) >= reviseAfterIdleDays;

    if (isSolid && isIdle) return 'revise';

    // Solid and recently practised: a short test is more useful than more of the same.
    if (isSolid) return 'mini_test';

    return 'practice';
}

/**
 * Builds the sentence the learner reads.
 *
 * Written from the final numbers, not the requested ones. Promising five questions and
 * serving one is the kind of small dishonesty that makes people stop trusting the
 * recommendation, so the count here is always the count they will actually get.
 */
function sentenceFor(plan: SessionPlan, questionCount: number): string {
    const { candidate, action, difficulty, difficultyAdjustment, recentAccuracyPercent } =
        plan;
    const name = candidate.name;
    const mastery = Math.round(candidate.masteryScore ?? 0);
    const questions = questionCount === 1 ? '1 question' : `${questionCount} questions`;

    switch (action) {
        case 'learn_new':
            return `You have not attempted ${name} yet, so start with ${questions} at ${difficulty} level to find where you stand.`;

        case 'revise':
            return `${name} is one of your stronger areas but you last practised it ${Math.round(candidate.daysSinceLastAttempt ?? 0)} days ago, so ${questions} will keep it fresh.`;

        case 'mini_test':
            return `${name} looks solid at mastery ${mastery}, so a short test of ${questions} will confirm it under time pressure.`;

        case 'practice': {
            if (difficultyAdjustment === 'stepped_back') {
                return `${name} is at mastery ${mastery} but your recent accuracy is only ${recentAccuracyPercent}%, so ${questions} at ${difficulty} level will rebuild the basics.`;
            }
            if (difficultyAdjustment === 'stepped_up') {
                return `${name} is at mastery ${mastery} and your recent accuracy is ${recentAccuracyPercent}%, so ${questions} at ${difficulty} level will push you further.`;
            }
            return `${name} is at mastery ${mastery}, so ${questions} at ${difficulty} level should move it most.`;
        }
    }
}

/**
 * The decision, before the question bank has had its say. Split out because the number of
 * questions actually available is only known after the topic and difficulty are chosen,
 * and both the time estimate and the sentence depend on it.
 */
export interface SessionPlan {
    candidate: TopicCandidate;
    action: LearningAction;
    difficulty: Difficulty;
    difficultyAdjustment: 'none' | 'stepped_back' | 'stepped_up';
    recentAccuracyPercent: number | null;
    /** What the engine would like to serve, before checking the bank. */
    requestedQuestionCount: number;
    secondsPerQuestion: number;
    alternatives: RankedTopic[];
}

/**
 * Which topics are allowed to compete this session.
 *
 * Unfinished work comes first: while something already started is still below the floor,
 * untouched topics are held back. Once everything in progress is reasonable, the whole
 * scope competes again and the syllabus opens up.
 */
export function eligibleCandidates(
    candidates: TopicCandidate[]
): TopicCandidate[] {
    const started = candidates.filter((c) => c.totalAttempts > 0);

    const unfinished = started.filter(
        (c) => (c.masteryScore ?? 0) < ADAPTIVE_CONFIG.masteryFloorBeforeNewTopics
    );

    return unfinished.length > 0 ? unfinished : candidates;
}

/** Phase one: choose the topic, the kind of session and the difficulty. */
export function planSession(input: RecommendationInput): SessionPlan | null {
    if (input.candidates.length === 0) return null;

    const ranked = eligibleCandidates(input.candidates)
        .map((candidate) => ({ candidate, score: priorityScore(candidate) }))
        // Tie-break on name so the same inputs always produce the same order.
        .sort(
            (a, b) =>
                b.score - a.score ||
                a.candidate.name.localeCompare(b.candidate.name)
        );

    const winner = ranked[0]!.candidate;
    const action = chooseAction(winner);

    const difficultyChoice = chooseDifficulty({
        masteryScore: winner.masteryScore ?? 0,
        recentAccuracy: winner.recentAccuracy,
        recentAttempts: winner.recentAttempts,
    });

    const counts = ADAPTIVE_CONFIG.questionCounts;
    const baseCount =
        action === 'learn_new'
            ? counts.learnNew
            : action === 'revise'
              ? counts.revise
              : action === 'mini_test'
                ? counts.miniTest
                : counts.practice;

    const secondsPerQuestion =
        input.secondsPerQuestion ?? ADAPTIVE_CONFIG.defaultSecondsPerQuestion;

    // Respect the time the learner actually has. Promising a 15 minute session to somebody
    // with 5 minutes free is how a plan stops being followed.
    const requestedQuestionCount =
        input.availableMinutes === null
            ? baseCount
            : Math.max(
                  1,
                  Math.min(
                      baseCount,
                      Math.floor((input.availableMinutes * 60) / secondsPerQuestion)
                  )
              );

    return {
        candidate: winner,
        action,
        difficulty: difficultyChoice.difficulty,
        difficultyAdjustment: difficultyChoice.adjustment,
        recentAccuracyPercent: difficultyChoice.recentAccuracyPercent,
        requestedQuestionCount,
        secondsPerQuestion,
        alternatives: ranked
            .slice(1, 1 + ADAPTIVE_CONFIG.alternativesReturned)
            .map(({ candidate, score }) => ({
                topicId: candidate.topicId,
                name: candidate.name,
                score: Math.round(score * 1000) / 1000,
                masteryScore: candidate.masteryScore,
            })),
    };
}

/**
 * Phase two: fix the plan to the number of questions the bank could actually supply, and
 * write the sentence from those final numbers.
 */
export function finaliseAction(
    plan: SessionPlan,
    availableQuestionCount: number
): NextBestAction {
    const questionCount = Math.min(
        plan.requestedQuestionCount,
        availableQuestionCount
    );

    const estimatedMinutes = Math.max(
        ADAPTIVE_CONFIG.minEstimatedMinutes,
        Math.round((questionCount * plan.secondsPerQuestion) / 60)
    );

    const { candidate } = plan;

    return {
        action: plan.action,
        topic: { id: candidate.topicId, name: candidate.name },
        difficulty: plan.difficulty,
        questionCount,
        estimatedMinutes,
        reason: sentenceFor(plan, questionCount),
        signals: {
            masteryScore: candidate.masteryScore,
            recentAccuracyPercent:
                candidate.recentAccuracy === null
                    ? null
                    : Math.round(candidate.recentAccuracy * 100),
            totalAttempts: candidate.totalAttempts,
            daysSinceLastAttempt:
                candidate.daysSinceLastAttempt === null
                    ? null
                    : Math.round(candidate.daysSinceLastAttempt),
        },
        alternatives: plan.alternatives,
    };
}

/** Both phases, for callers that already know the bank can fill the request. */
export function recommendNextAction(
    input: RecommendationInput
): NextBestAction | null {
    const plan = planSession(input);
    return plan ? finaliseAction(plan, plan.requestedQuestionCount) : null;
}
