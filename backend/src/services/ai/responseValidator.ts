import { z } from 'zod';

/**
 * Where AI output stops being AI output and becomes data.
 *
 * Two gates, in order:
 *
 *   schema   is it the shape we asked for
 *   business is it a usable question
 *
 * The second gate is the one that matters. A reply can satisfy the schema perfectly and
 * still be unusable: five identical options, an answer index pointing past the end of the
 * list, an explanation that just repeats the question, a question that says "see the
 * diagram above". None of those are malformed JSON, and all of them would be visible to a
 * learner if we only checked the shape.
 *
 * Nothing here calls the model or the database, so every rule is cheap to unit test.
 */

const generatedQuestionSchema = z.object({
    questionType: z.enum(['mcq', 'msq']),
    body: z.string().min(15).max(2000),
    options: z.array(z.string().min(1).max(500)).min(2).max(6),
    correctOptionIndexes: z.array(z.number().int().min(0)).min(1),
    explanation: z.string().min(20).max(2000),
    difficulty: z.enum(['easy', 'medium', 'hard']),
});

export const generatedQuestionsSchema = z.object({
    questions: z.array(generatedQuestionSchema).min(1).max(20),
});

export type GeneratedQuestion = z.infer<typeof generatedQuestionSchema>;

export interface ValidationFailure {
    /** Index in the batch, so a log line points at the offending question. */
    index: number;
    reason: string;
}

export interface ValidationOutcome {
    accepted: GeneratedQuestion[];
    rejected: ValidationFailure[];
}

/** Phrases that mean the question depends on something the learner cannot see. */
const DANGLING_REFERENCES = [
    'the above',
    'shown above',
    'the following diagram',
    'the figure',
    'the image',
    'previous question',
    'as discussed',
];

/**
 * Business rules, applied per question. Returns null when the question is usable, or the
 * reason it is not.
 */
export function businessCheck(question: GeneratedQuestion): string | null {
    const { questionType, body, options, correctOptionIndexes, explanation } = question;

    // A single-answer question with two answers is a broken question, not a hard one.
    if (questionType === 'mcq' && correctOptionIndexes.length !== 1) {
        return 'single-answer question has more than one correct option';
    }

    if (questionType === 'msq' && correctOptionIndexes.length < 2) {
        return 'multi-answer question has fewer than two correct options';
    }

    // Every index must actually exist. This is the check that stops a learner being
    // marked wrong for the right answer.
    if (correctOptionIndexes.some((index) => index >= options.length)) {
        return 'correct answer points at an option that does not exist';
    }

    if (new Set(correctOptionIndexes).size !== correctOptionIndexes.length) {
        return 'the same option is listed as correct twice';
    }

    // Every option correct is not a question.
    if (correctOptionIndexes.length === options.length) {
        return 'every option is marked correct';
    }

    const trimmed = options.map((option) => option.trim().toLowerCase());

    if (new Set(trimmed).size !== trimmed.length) {
        return 'two options are identical';
    }

    // "All of the above" breaks when options get shuffled, which the UI is free to do.
    if (trimmed.some((option) => option.includes('of the above'))) {
        return 'options refer to their own ordering';
    }

    const lowerBody = body.toLowerCase();

    for (const phrase of DANGLING_REFERENCES) {
        if (lowerBody.includes(phrase)) {
            return `question refers to something the learner cannot see ("${phrase}")`;
        }
    }

    // An explanation that is just the question again teaches nothing.
    if (explanation.trim().toLowerCase() === lowerBody.trim()) {
        return 'explanation only repeats the question';
    }

    // A correct option that is quoted verbatim in the question gives the answer away.
    const correctTexts = correctOptionIndexes.map((index) => trimmed[index] ?? '');
    if (correctTexts.some((text) => text.length > 12 && lowerBody.includes(text))) {
        return 'the question text contains the correct answer';
    }

    return null;
}

/**
 * Runs both gates over a raw provider reply.
 *
 * A batch is never rejected wholesale for one bad question: the good ones are kept and the
 * bad ones are reported, because the model returning four usable questions and one dud is
 * the normal case, not an error.
 */
export function validateGeneratedQuestions(raw: unknown): ValidationOutcome {
    const parsed = generatedQuestionsSchema.safeParse(raw);

    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            accepted: [],
            rejected: [
                {
                    index: -1,
                    reason: `reply did not match the expected shape: ${
                        issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'
                    }`,
                },
            ],
        };
    }

    const accepted: GeneratedQuestion[] = [];
    const rejected: ValidationFailure[] = [];
    const seenBodies = new Set<string>();

    parsed.data.questions.forEach((question, index) => {
        const problem = businessCheck(question);

        if (problem) {
            rejected.push({ index, reason: problem });
            return;
        }

        // The model occasionally repeats itself inside one batch.
        const fingerprint = question.body.trim().toLowerCase();
        if (seenBodies.has(fingerprint)) {
            rejected.push({ index, reason: 'duplicate of another question in the batch' });
            return;
        }

        seenBodies.add(fingerprint);
        accepted.push(question);
    });

    return { accepted, rejected };
}

/** The independent answer check, validated the same way. */
export const answerCheckSchema = z.object({
    correctOptionIndexes: z.array(z.number().int().min(0)).max(6),
    confidence: z.enum(['low', 'medium', 'high']),
    unanswerable: z.boolean(),
    note: z.string().max(1000).optional(),
});

export type AnswerCheck = z.infer<typeof answerCheckSchema>;

/**
 * Decides whether a generated question may be shown to learners.
 *
 * The bar: a second, independent request solved the question without seeing the proposed
 * answer, agreed with it, was confident, and did not flag it as ambiguous. Anything less
 * and the question stays hidden -- it is not deleted, so it can be reviewed later, but no
 * learner sees a question whose answer we are not sure about.
 */
export function agreesWithProposedAnswer(
    proposed: number[],
    check: AnswerCheck
): { verified: boolean; reason: string } {
    if (check.unanswerable) {
        return { verified: false, reason: 'checker judged the question unanswerable' };
    }

    if (check.confidence === 'low') {
        return { verified: false, reason: 'checker was not confident in any answer' };
    }

    const a = [...new Set(proposed)].sort((x, y) => x - y).join(',');
    const b = [...new Set(check.correctOptionIndexes)].sort((x, y) => x - y).join(',');

    if (a !== b) {
        return {
            verified: false,
            reason: `checker answered [${b}] but the question claims [${a}]`,
        };
    }

    return { verified: true, reason: 'independent check agreed with the answer' };
}
