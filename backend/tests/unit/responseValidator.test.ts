import { describe, expect, it } from 'vitest';
import {
    type GeneratedQuestion,
    agreesWithProposedAnswer,
    businessCheck,
    validateGeneratedQuestions,
} from '@/services/ai/responseValidator.js';

/**
 * These tests are the safety net on AI-generated content. Every case here is something a
 * model has plausibly produced: a shape that is fine but a question that is not.
 */

function question(overrides: Partial<GeneratedQuestion> = {}): GeneratedQuestion {
    return {
        questionType: 'mcq',
        body: 'Which data structure gives constant-time lookup by key?',
        options: ['Linked list', 'Hash table', 'Sorted array', 'Stack'],
        correctOptionIndexes: [1],
        explanation:
            'A hash table computes the position from the key itself, so the work does not grow with the number of entries.',
        difficulty: 'easy',
        ...overrides,
    };
}

describe('businessCheck - accepts a good question', () => {
    it('passes a well-formed single-answer question', () => {
        expect(businessCheck(question())).toBeNull();
    });

    it('passes a well-formed multi-answer question', () => {
        expect(
            businessCheck(question({ questionType: 'msq', correctOptionIndexes: [0, 2] }))
        ).toBeNull();
    });
});

describe('businessCheck - rejects what the schema cannot catch', () => {
    it('THE IMPORTANT ONE: an answer index past the end of the options', () => {
        // This is the failure that would mark a learner wrong for being right.
        expect(businessCheck(question({ correctOptionIndexes: [7] }))).toMatch(/does not exist/i);
    });

    it('a single-answer question with two answers', () => {
        expect(businessCheck(question({ correctOptionIndexes: [1, 2] }))).toMatch(
            /more than one correct/i
        );
    });

    it('a multi-answer question with only one answer', () => {
        expect(businessCheck(question({ questionType: 'msq', correctOptionIndexes: [1] }))).toMatch(
            /fewer than two/i
        );
    });

    it('the same option marked correct twice', () => {
        expect(
            businessCheck(question({ questionType: 'msq', correctOptionIndexes: [1, 1] }))
        ).toMatch(/correct twice/i);
    });

    it('every option marked correct', () => {
        expect(
            businessCheck(
                question({
                    questionType: 'msq',
                    options: ['a', 'b'],
                    correctOptionIndexes: [0, 1],
                })
            )
        ).toMatch(/every option/i);
    });

    it('two identical options', () => {
        expect(
            businessCheck(question({ options: ['Hash table', 'hash table ', 'Stack', 'Queue'] }))
        ).toMatch(/identical/i);
    });

    it('"all of the above", which breaks when options are shuffled', () => {
        expect(
            businessCheck(
                question({
                    options: ['Hash table', 'Stack', 'Queue', 'All of the above'],
                })
            )
        ).toMatch(/own ordering/i);
    });

    it('a question that refers to something the learner cannot see', () => {
        expect(
            businessCheck(question({ body: 'Based on the figure, which traversal is shown?' }))
        ).toMatch(/cannot see/i);
    });

    it('an explanation that just repeats the question', () => {
        const body = 'Which data structure gives constant-time lookup by key?';
        expect(businessCheck(question({ body, explanation: body }))).toMatch(
            /repeats the question/i
        );
    });

    it('a question that gives its own answer away', () => {
        expect(
            businessCheck(
                question({
                    body: 'Which structure is a hash table with constant-time lookup by key?',
                    options: [
                        'a hash table with constant-time lookup by key',
                        'Linked list',
                        'Stack',
                        'Queue',
                    ],
                    correctOptionIndexes: [0],
                })
            )
        ).toMatch(/contains the correct answer/i);
    });
});

describe('validateGeneratedQuestions', () => {
    it('rejects a reply that is not the shape we asked for', () => {
        const result = validateGeneratedQuestions({ questions: 'four of them' });

        expect(result.accepted).toHaveLength(0);
        expect(result.rejected[0]?.reason).toMatch(/shape/i);
    });

    it('rejects a reply that is not an object at all', () => {
        expect(validateGeneratedQuestions('sorry, I cannot').accepted).toHaveLength(0);
        expect(validateGeneratedQuestions(null).accepted).toHaveLength(0);
    });

    it('keeps the good questions and reports the bad ones', () => {
        const result = validateGeneratedQuestions({
            questions: [
                question(),
                question({ body: 'A second perfectly fine question about hashing?' }),
                question({ correctOptionIndexes: [9] }),
            ],
        });

        expect(result.accepted).toHaveLength(2);
        expect(result.rejected).toHaveLength(1);
        expect(result.rejected[0]?.index).toBe(2);
    });

    it('drops a question the model repeated inside one batch', () => {
        const result = validateGeneratedQuestions({
            questions: [question(), question()],
        });

        expect(result.accepted).toHaveLength(1);
        expect(result.rejected[0]?.reason).toMatch(/duplicate/i);
    });
});

describe('agreesWithProposedAnswer', () => {
    const confident = { confidence: 'high' as const, unanswerable: false };

    it('verifies when the independent check agrees', () => {
        expect(
            agreesWithProposedAnswer([1], { ...confident, correctOptionIndexes: [1] }).verified
        ).toBe(true);
    });

    it('ignores ordering when comparing multi-answer questions', () => {
        expect(
            agreesWithProposedAnswer([2, 0], {
                ...confident,
                correctOptionIndexes: [0, 2],
            }).verified
        ).toBe(true);
    });

    it('THE IMPORTANT ONE: refuses when the check answered differently', () => {
        const result = agreesWithProposedAnswer([1], {
            ...confident,
            correctOptionIndexes: [2],
        });

        expect(result.verified).toBe(false);
        expect(result.reason).toMatch(/answered \[2\]/);
    });

    it('refuses when the checker called the question unanswerable', () => {
        const result = agreesWithProposedAnswer([1], {
            correctOptionIndexes: [1],
            confidence: 'high',
            unanswerable: true,
        });

        expect(result.verified).toBe(false);
        expect(result.reason).toMatch(/unanswerable/i);
    });

    it('refuses when the checker was not confident, even if it agreed', () => {
        const result = agreesWithProposedAnswer([1], {
            correctOptionIndexes: [1],
            confidence: 'low',
            unanswerable: false,
        });

        expect(result.verified).toBe(false);
        expect(result.reason).toMatch(/not confident/i);
    });
});
