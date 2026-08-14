import { describe, expect, it } from 'vitest';
import { gradeAnswer } from '@/services/practice/grader.js';

describe('gradeAnswer - single choice', () => {
    const question = { questionType: 'mcq' as const, correctAnswer: [2] };

    it('accepts the right option', () => {
        expect(gradeAnswer(question, { selectedOptions: [2] }).isCorrect).toBe(true);
    });

    it('rejects a wrong option', () => {
        expect(gradeAnswer(question, { selectedOptions: [1] }).isCorrect).toBe(false);
    });

    it('rejects picking the right option plus another', () => {
        expect(gradeAnswer(question, { selectedOptions: [2, 3] }).isCorrect).toBe(false);
    });

    it('rejects answering nothing', () => {
        expect(gradeAnswer(question, { selectedOptions: [] }).isCorrect).toBe(false);
    });
});

describe('gradeAnswer - multiple choice', () => {
    const question = { questionType: 'msq' as const, correctAnswer: [0, 2, 3] };

    it('accepts every correct option regardless of order', () => {
        expect(gradeAnswer(question, { selectedOptions: [3, 0, 2] }).isCorrect).toBe(true);
    });

    it('gives no credit for a partly right answer', () => {
        // Two of three correct is not knowing the concept, and half marks would flatter
        // the mastery score.
        expect(gradeAnswer(question, { selectedOptions: [0, 2] }).isCorrect).toBe(false);
    });

    it('rejects an extra wrong option alongside the right ones', () => {
        expect(gradeAnswer(question, { selectedOptions: [0, 1, 2, 3] }).isCorrect).toBe(false);
    });

    it('cannot be fooled by repeating one option', () => {
        expect(gradeAnswer(question, { selectedOptions: [0, 0, 0] }).isCorrect).toBe(false);
    });
});

describe('gradeAnswer - numeric', () => {
    const question = {
        questionType: 'numeric' as const,
        correctAnswer: { value: 0.5, tol: 0.01 },
    };

    it('accepts an exact answer', () => {
        expect(gradeAnswer(question, { value: 0.5 }).isCorrect).toBe(true);
    });

    it('accepts an answer inside the tolerance', () => {
        expect(gradeAnswer(question, { value: 0.505 }).isCorrect).toBe(true);
    });

    it('rejects an answer outside the tolerance', () => {
        expect(gradeAnswer(question, { value: 0.6 }).isCorrect).toBe(false);
    });

    it('accepts a tolerance-free answer that floating point would spoil', () => {
        const thirds = {
            questionType: 'numeric' as const,
            correctAnswer: { value: 1 / 3, tol: 0.01 },
        };
        expect(gradeAnswer(thirds, { value: 0.33 }).isCorrect).toBe(true);
    });
});

describe('gradeAnswer - refuses to guess', () => {
    it('rejects options sent for a numeric question', () => {
        expect(() =>
            gradeAnswer(
                { questionType: 'numeric', correctAnswer: { value: 1, tol: 0 } },
                { selectedOptions: [0] }
            )
        ).toThrowError(/numeric value/i);
    });

    it('rejects a number sent for a choice question', () => {
        expect(() =>
            gradeAnswer({ questionType: 'mcq', correctAnswer: [0] }, { value: 1 })
        ).toThrowError(/selected options/i);
    });

    it('refuses to grade a question whose stored answer is the wrong shape', () => {
        // An AI-generated question could store anything. Better to fail loudly than to
        // silently mark a learner wrong.
        expect(() =>
            gradeAnswer(
                { questionType: 'mcq', correctAnswer: 'option B' },
                { selectedOptions: [1] }
            )
        ).toThrowError(/cannot be graded/i);
    });

    it('refuses a single-choice question that stores two answers', () => {
        expect(() =>
            gradeAnswer({ questionType: 'mcq', correctAnswer: [0, 1] }, { selectedOptions: [0] })
        ).toThrowError(/cannot be graded/i);
    });
});
