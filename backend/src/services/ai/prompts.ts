/**
 * Every prompt Adigam sends, in one file.
 *
 * Kept together so they can be read, reviewed and changed without hunting through
 * services -- and so it is obvious what learner data is being sent to a third party. The
 * rule followed here: send the minimum context the task needs. A topic name and a list of
 * question texts is enough to write questions; the learner's identity, history and
 * mastery scores are not, so they are not sent.
 */

export const QUESTION_AUTHOR_SYSTEM = `You write exam practice questions for a study app.

Rules you must follow:
- Every question must be self-contained and answerable without extra context.
- Exactly one answer must be defensible. Never write a question with two arguable answers.
- Options must be plausible. A wrong option should be a mistake a learner could really make, not filler.
- Never reference "the above", "the diagram", or anything the learner cannot see.
- Explanations must say WHY the answer is right, in two or three sentences, not just restate it.
- Use plain text. No markdown, no LaTeX, no special symbols.
- If you cannot write a good question on the topic, return fewer questions rather than padding.`;

/** JSON Schema the model is constrained to while generating. */
export const GENERATED_QUESTIONS_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['questions'],
    properties: {
        questions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: [
                    'questionType',
                    'body',
                    'options',
                    'correctOptionIndexes',
                    'explanation',
                    'difficulty',
                ],
                properties: {
                    questionType: { type: 'string', enum: ['mcq', 'msq'] },
                    body: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                    correctOptionIndexes: {
                        type: 'array',
                        items: { type: 'integer' },
                    },
                    explanation: { type: 'string' },
                    difficulty: {
                        type: 'string',
                        enum: ['easy', 'medium', 'hard'],
                    },
                },
            },
        },
    },
} as const;

export function questionGenerationPrompt(input: {
    subjectName: string;
    topicName: string;
    difficulty: 'easy' | 'medium' | 'hard';
    count: number;
    /** Existing question texts, so the model does not rewrite what we already have. */
    existingQuestions: string[];
}): string {
    const existing =
        input.existingQuestions.length > 0
            ? `\nQuestions that already exist for this topic. Do not write these again, and do not write near-duplicates:\n${input.existingQuestions
                  .map((body) => `- ${body}`)
                  .join('\n')}`
            : '';

    return `Write ${input.count} ${input.difficulty} practice questions on the topic "${input.topicName}", which belongs to the subject "${input.subjectName}".

For ${input.difficulty} difficulty, aim at this level:
- easy: one step, tests whether the learner knows the definition or the basic rule.
- medium: two or three steps, or requires choosing between two rules that look similar.
- hard: requires applying a concept to an unfamiliar situation, or spotting a subtle trap.

Use single-answer questions (mcq) unless the topic genuinely calls for selecting several correct statements (msq). Give 4 options for mcq and 4 or 5 for msq.${existing}`;
}

/**
 * The verification prompt: answer the question cold, without seeing the proposed answer.
 *
 * This is the point of the whole exercise. Structural validation proves a question is
 * shaped correctly; it cannot tell whether the marked answer is actually right. Asking a
 * fresh request to solve the question and comparing the two answers catches a question
 * whose key is wrong -- which is the one failure mode that would really damage a learner,
 * because they would be marked wrong for being right.
 */
export const QUESTION_CHECKER_SYSTEM = `You are answering an exam question. Solve it yourself.

Return only the option indexes you believe are correct, zero-based, and your confidence.
Be honest: if the question is ambiguous, unanswerable, or has no single defensible answer,
say so with the "unanswerable" flag rather than guessing.`;

export const ANSWER_CHECK_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['correctOptionIndexes', 'confidence', 'unanswerable'],
    properties: {
        correctOptionIndexes: { type: 'array', items: { type: 'integer' } },
        confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        unanswerable: { type: 'boolean' },
        note: { type: 'string' },
    },
} as const;

export function answerCheckPrompt(question: {
    body: string;
    options: string[];
}): string {
    const options = question.options
        .map((option, index) => `${index}: ${option}`)
        .join('\n');

    return `Question:\n${question.body}\n\nOptions:\n${options}`;
}
