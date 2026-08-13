/**
 * Turns a learner's answers on one topic into a mastery estimate between 0 and 100.
 *
 * Deterministic and pure. Same evidence in, same number out, no database, no AI. That
 * matters because this number drives the study plan, the next recommendation and the
 * readiness score, and all three have to be explainable to the person using them.
 *
 * Honest about what it is: an estimate from a handful of answers, not a measurement of
 * knowledge. Two things keep it from overclaiming:
 *
 *   shrinkage  with little evidence the score is pulled towards a neutral middle, so
 *              three lucky answers do not read as mastery
 *   decay      a topic untouched for weeks scores slightly lower than the raw numbers
 *              say, because knowledge fades
 *
 * Every constant lives in MASTERY_CONFIG so the weights can be tuned in one place
 * without hunting through the logic.
 */

export const MASTERY_CONFIG = {
    /**
     * How the four components are combined. Must add up to 1.
     *
     * Recent performance leads, because someone who has just revised a topic knows it
     * better than their six-week-old average suggests. History is kept as a counterweight
     * so one good session cannot erase a long weak record.
     */
    weights: {
        recentAccuracy: 0.4,
        historicalAccuracy: 0.25,
        difficultyHandling: 0.25,
        consistency: 0.1,
    },

    /** How many of the latest attempts count as "recent". */
    recentWindow: 10,

    /**
     * Harder questions say more. A learner who only ever answers easy questions correctly
     * should not reach the same score as one clearing hard ones.
     */
    difficultyWeights: { easy: 1, medium: 2, hard: 3 },

    /**
     * How much of the difficulty component a learner can earn without ever leaving easy
     * questions. Weighting accuracy by difficulty is not enough on its own: someone who
     * only answers easy questions and gets them all right has perfect weighted accuracy,
     * which would read the same as clearing hard ones. This floor caps what an easy-only
     * record can demonstrate, while still not treating an unattempted level as a failure.
     */
    difficultyLevelFloor: 0.6,

    /** A correct run of this length counts as full marks for consistency. */
    streakForFullConsistency: 5,

    /**
     * Shrinkage. With `attempts` answers, the score is
     *   attempts / (attempts + evidenceHalfWeight)
     * of the way from the neutral prior towards the raw score. At 5 attempts it sits
     * halfway, at 20 it is 80 percent of the way there.
     */
    evidenceHalfWeight: 5,

    /** Where an unproven topic sits: neither known nor unknown. */
    neutralPrior: 0.35,

    /** Decay: after this many idle days the full penalty applies. */
    decayAfterDays: 30,

    /** The most decay can ever take away. Retention risk handles the rest separately. */
    maxDecay: 0.15,
} as const;

export interface DifficultyBucket {
    attempts: number;
    correct: number;
}

/** Everything the formula is allowed to look at. */
export interface TopicEvidence {
    totalAttempts: number;
    correctAttempts: number;
    recentAttempts: number;
    recentCorrect: number;
    easy: DifficultyBucket;
    medium: DifficultyBucket;
    hard: DifficultyBucket;
    correctStreak: number;
    /** Null when the topic has never been attempted. */
    daysSinceLastAttempt: number | null;
}

/** The score plus the parts it was built from, so a screen can explain it. */
export interface MasteryResult {
    score: number;
    breakdown: {
        recentAccuracy: number | null;
        historicalAccuracy: number | null;
        difficultyHandling: number | null;
        consistency: number;
        rawScore: number;
        confidence: number;
        decayFactor: number;
    };
}

function ratio(correct: number, attempts: number): number | null {
    return attempts > 0 ? correct / attempts : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * How well the learner handles difficulty, in two parts.
 *
 * First, accuracy weighted so harder questions count for more. Buckets with no attempts
 * are left out rather than counted as zeros, because never trying a hard question is not
 * the same as failing every hard question.
 *
 * Second, a factor for the level actually attempted. Without it, a learner who only ever
 * answers easy questions correctly scores the same as one clearing hard ones, since both
 * have perfect weighted accuracy. The floor keeps an easy-only record from reaching full
 * marks while still not punishing it as though the hard questions were failed.
 */
function difficultyHandling(evidence: TopicEvidence): number | null {
    const { difficultyWeights, difficultyLevelFloor } = MASTERY_CONFIG;

    const buckets = [
        { bucket: evidence.easy, weight: difficultyWeights.easy },
        { bucket: evidence.medium, weight: difficultyWeights.medium },
        { bucket: evidence.hard, weight: difficultyWeights.hard },
    ].filter((entry) => entry.bucket.attempts > 0);

    if (buckets.length === 0) return null;

    const weightedSum = buckets.reduce(
        (sum, { bucket, weight }) =>
            sum + weight * (bucket.correct / bucket.attempts),
        0
    );
    const totalWeight = buckets.reduce((sum, { weight }) => sum + weight, 0);
    const weightedAccuracy = weightedSum / totalWeight;

    // Average difficulty attempted, as a fraction of the hardest level available:
    // easy only gives 1/3, hard only gives 1.
    const attemptCount = buckets.reduce((sum, { bucket }) => sum + bucket.attempts, 0);
    const hardestWeight = Math.max(...Object.values(difficultyWeights));
    const attemptedLevel =
        buckets.reduce((sum, { bucket, weight }) => sum + weight * bucket.attempts, 0) /
        (attemptCount * hardestWeight);

    const levelFactor =
        difficultyLevelFloor + (1 - difficultyLevelFloor) * attemptedLevel;

    return weightedAccuracy * levelFactor;
}

export function computeMastery(evidence: TopicEvidence): MasteryResult {
    const { weights, streakForFullConsistency, evidenceHalfWeight, neutralPrior, decayAfterDays, maxDecay } =
        MASTERY_CONFIG;

    const recent = ratio(evidence.recentCorrect, evidence.recentAttempts);
    const historical = ratio(evidence.correctAttempts, evidence.totalAttempts);
    const difficulty = difficultyHandling(evidence);
    const consistency = clamp(
        evidence.correctStreak / streakForFullConsistency,
        0,
        1
    );

    // Components with no evidence are dropped and the remaining weights are rescaled, so
    // a missing component cannot silently drag the score towards zero.
    const allComponents: { value: number | null; weight: number }[] = [
        { value: recent, weight: weights.recentAccuracy },
        { value: historical, weight: weights.historicalAccuracy },
        { value: difficulty, weight: weights.difficultyHandling },
        { value: consistency, weight: weights.consistency },
    ];

    const components = allComponents.filter(
        (component): component is { value: number; weight: number } =>
            component.value !== null
    );

    const usedWeight = components.reduce((sum, c) => sum + c.weight, 0);

    const rawScore =
        usedWeight > 0
            ? components.reduce((sum, c) => sum + c.weight * c.value, 0) /
              usedWeight
            : neutralPrior;

    // Shrinkage towards the neutral prior when the evidence is thin.
    const confidence =
        evidence.totalAttempts / (evidence.totalAttempts + evidenceHalfWeight);

    const shrunk = rawScore * confidence + neutralPrior * (1 - confidence);

    // Mild decay for a topic left alone. Full decay is capped, because a well-learned
    // topic does not become unknown in a month.
    const idleDays = evidence.daysSinceLastAttempt ?? 0;
    const decayFactor =
        1 - clamp(idleDays / decayAfterDays, 0, 1) * maxDecay;

    return {
        score: round2(clamp(shrunk * decayFactor * 100, 0, 100)),
        breakdown: {
            recentAccuracy: recent === null ? null : round2(recent),
            historicalAccuracy: historical === null ? null : round2(historical),
            difficultyHandling: difficulty === null ? null : round2(difficulty),
            consistency: round2(consistency),
            rawScore: round2(rawScore),
            confidence: round2(confidence),
            decayFactor: round2(decayFactor),
        },
    };
}

/** One answered question, as the recompute reads it back out of the attempt log. */
export interface AttemptRecord {
    isCorrect: boolean;
    difficulty: 'easy' | 'medium' | 'hard';
    attemptedAt: string;
}

/**
 * Folds an attempt log into the evidence the formula needs.
 *
 * Mastery is recomputed from the log rather than nudged in place. It costs one query per
 * submitted answer and removes a whole class of bug: a cache that drifts from the history
 * it claims to summarise. The log stays the single source of truth.
 *
 * `attempts` must be newest first.
 */
export function summariseAttempts(
    attempts: AttemptRecord[],
    now: Date
): TopicEvidence {
    const empty = (): DifficultyBucket => ({ attempts: 0, correct: 0 });
    const evidence: TopicEvidence = {
        totalAttempts: attempts.length,
        correctAttempts: 0,
        recentAttempts: Math.min(attempts.length, MASTERY_CONFIG.recentWindow),
        recentCorrect: 0,
        easy: empty(),
        medium: empty(),
        hard: empty(),
        correctStreak: 0,
        daysSinceLastAttempt: null,
    };

    if (attempts.length === 0) return evidence;

    attempts.forEach((attempt, index) => {
        const bucket = evidence[attempt.difficulty];
        bucket.attempts += 1;

        if (attempt.isCorrect) {
            evidence.correctAttempts += 1;
            bucket.correct += 1;
            if (index < MASTERY_CONFIG.recentWindow) evidence.recentCorrect += 1;
        }
    });

    // The run of correct answers ending at the most recent attempt.
    for (const attempt of attempts) {
        if (!attempt.isCorrect) break;
        evidence.correctStreak += 1;
    }

    const latest = attempts[0];
    if (latest) {
        const millisecondsPerDay = 86_400_000;
        evidence.daysSinceLastAttempt = Math.max(
            0,
            (now.getTime() - new Date(latest.attemptedAt).getTime()) /
                millisecondsPerDay
        );
    }

    return evidence;
}
