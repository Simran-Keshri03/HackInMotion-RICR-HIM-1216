import { z } from 'zod';
import { AppError } from '@/utils/http.js';

/**
 * Decides whether an answer is right. Pure: same inputs, same result, no database.
 *
 * This runs on the server because the correct answer never leaves it. The browser is not
 * granted the correct_answer column at all, so grading here is not a policy choice, it is
 * the only place it can happen.
 */

export type QuestionType = 'mcq' | 'msq' | 'numeric';

export interface GradableQuestion {
    questionType: QuestionType;
    /** Straight from the database, so its shape is checked rather than trusted. */
    correctAnswer: unknown;
}

/** What the learner sent. Options for choice questions, a number for numeric ones. */
export type GivenAnswer =
    | { selectedOptions: number[] }
    | { value: number };

// The stored shapes, as documented in 003_questions.sql. AI-generated rows could carry
// something else, so every read is validated rather than cast.
const choiceAnswerSchema = z.array(z.number().int().min(0)).min(1);
const numericAnswerSchema = z.object({
    value: z.number(),
    tol: z.number().min(0),
});

function malformed(detail: string): AppError {
    return new AppError(
        500,
        'QUESTION_MALFORMED',
        `This question cannot be graded: ${detail}`
    );
}

export function gradeAnswer(
    question: GradableQuestion,
    given: GivenAnswer
): { isCorrect: boolean } {
    switch (question.questionType) {
        case 'mcq':
        case 'msq': {
            if (!('selectedOptions' in given)) {
                throw new AppError(
                    400,
                    'INVALID_ANSWER',
                    'This question needs selected options.'
                );
            }

            const parsed = choiceAnswerSchema.safeParse(question.correctAnswer);
            if (!parsed.success) {
                throw malformed('its stored answer is not a list of option indexes');
            }

            const expected = parsed.data;

            if (question.questionType === 'mcq' && expected.length !== 1) {
                throw malformed('a single-answer question has more than one answer');
            }

            // Set comparison, so order does not matter and duplicates cannot pad a match.
            // No partial credit for msq: getting two of three correct options is not
            // knowing the concept, and half marks would flatter the mastery score.
            const chosen = new Set(given.selectedOptions);
            const correct = new Set(expected);

            return {
                isCorrect:
                    chosen.size === correct.size &&
                    [...correct].every((option) => chosen.has(option)),
            };
        }

        case 'numeric': {
            if (!('value' in given)) {
                throw new AppError(
                    400,
                    'INVALID_ANSWER',
                    'This question needs a numeric value.'
                );
            }

            const parsed = numericAnswerSchema.safeParse(question.correctAnswer);
            if (!parsed.success) {
                throw malformed('its stored answer is not a value with a tolerance');
            }

            // Tolerance rather than equality, because 1/3 typed as 0.33 is a right answer
            // and floating point equality would call it wrong.
            const difference = Math.abs(given.value - parsed.data.value);

            return { isCorrect: difference <= parsed.data.tol };
        }

        default: {
            throw malformed(`unknown question type ${String(question.questionType)}`);
        }
    }
}
