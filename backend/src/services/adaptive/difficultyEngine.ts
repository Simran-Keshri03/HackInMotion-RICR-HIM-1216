/**
 * Picks the difficulty to serve next for one topic.
 *
 * The goal is to keep the learner just past comfortable. Questions that are too easy teach
 * nothing and inflate the mastery score; questions that are too hard produce a string of
 * wrong answers, which teaches little and is discouraging. So difficulty follows mastery,
 * with one override: if recent answers are going badly, step back regardless of the score.
 *
 * Pure and deterministic, so the choice can be explained and unit tested.
 */

export const DIFFICULTY_CONFIG = {
    /** Below this mastery, stay on easy questions. */
    easyBelow: 40,

    /** At or above this mastery, move to hard questions. */
    hardAtOrAbove: 70,

    /**
     * If recent accuracy has fallen below this, drop one level even when mastery looks
     * healthy. A score built weeks ago should not keep serving hard questions to somebody
     * who is currently struggling.
     */
    stepBackBelowRecentAccuracy: 0.4,

    /** Recent accuracy this high earns a step up, once there is enough evidence for it. */
    stepUpAboveRecentAccuracy: 0.85,

    /** Fewer recent answers than this and we do not read anything into them. */
    minRecentAttemptsToAdjust: 4,
} as const;

export type Difficulty = 'easy' | 'medium' | 'hard';

const LADDER: Difficulty[] = ['easy', 'medium', 'hard'];

function step(current: Difficulty, direction: -1 | 1): Difficulty {
    const index = LADDER.indexOf(current);
    return LADDER[Math.min(LADDER.length - 1, Math.max(0, index + direction))]!;
}

export interface DifficultySignals {
    masteryScore: number;
    /** 0 to 1, or null when the topic has not been attempted recently. */
    recentAccuracy: number | null;
    recentAttempts: number;
}

export interface DifficultyChoice {
    difficulty: Difficulty;
    /** Whether recent form overrode what mastery alone would have picked. */
    adjustment: 'none' | 'stepped_back' | 'stepped_up';
    /** Recent accuracy as a percentage, when it was the deciding factor. */
    recentAccuracyPercent: number | null;
    /** Why, in words. Null when mastery alone decided and there is nothing to add. */
    reason: string | null;
}

export function chooseDifficulty(signals: DifficultySignals): DifficultyChoice {
    const config = DIFFICULTY_CONFIG;

    // Start from where mastery says the learner is.
    let difficulty: Difficulty =
        signals.masteryScore < config.easyBelow
            ? 'easy'
            : signals.masteryScore >= config.hardAtOrAbove
              ? 'hard'
              : 'medium';

    let adjustment: DifficultyChoice['adjustment'] = 'none';
    let reason: string | null = null;
    let recentAccuracyPercent: number | null = null;

    // Then let recent form override it, but only with enough answers to mean something.
    const hasSignal =
        signals.recentAccuracy !== null &&
        signals.recentAttempts >= config.minRecentAttemptsToAdjust;

    if (hasSignal) {
        const recent = signals.recentAccuracy as number;
        const percent = Math.round(recent * 100);

        if (recent < config.stepBackBelowRecentAccuracy) {
            difficulty = step(difficulty, -1);
            adjustment = 'stepped_back';
            recentAccuracyPercent = percent;
            reason = `recent accuracy is only ${percent}%, so stepping back to ${difficulty}`;
        } else if (recent > config.stepUpAboveRecentAccuracy) {
            difficulty = step(difficulty, 1);
            adjustment = 'stepped_up';
            recentAccuracyPercent = percent;
            reason = `recent accuracy is ${percent}%, so stepping up to ${difficulty}`;
        }
    }

    return { difficulty, adjustment, recentAccuracyPercent, reason };
}
