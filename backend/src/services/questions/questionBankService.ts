import type { QuestionRepository } from '@/repositories/questionRepository.js';
import type { IAIProvider } from '@/services/ai/IAIProvider.js';
import {
    ANSWER_CHECK_SCHEMA,
    GENERATED_QUESTIONS_SCHEMA,
    QUESTION_AUTHOR_SYSTEM,
    QUESTION_CHECKER_SYSTEM,
    answerCheckPrompt,
    questionGenerationPrompt,
} from '@/services/ai/prompts.js';
import {
    agreesWithProposedAnswer,
    answerCheckSchema,
    validateGeneratedQuestions,
} from '@/services/ai/responseValidator.js';
import { AppError } from '@/utils/http.js';

export interface GenerateQuestionsInput {
    topicId: string;
    difficulty: 'easy' | 'medium' | 'hard';
    count: number;
    /**
     * The learner who asked, recorded as the author. Null for seed or bulk runs that are
     * not attributable to one person.
     */
    userId: string | null;
}

export interface GeneratedQuestionOutcome {
    body: string;
    difficulty: 'easy' | 'medium' | 'hard';
    /** Whether a learner will ever see this question. */
    verified: boolean;
    /** Why it was or was not verified, in words. */
    reason: string;
    stored: boolean;
}

export interface GenerateQuestionsResult {
    topic: string;
    requested: number;
    outcomes: GeneratedQuestionOutcome[];
    /** Questions the model produced that never reached the database, and why. */
    discarded: { reason: string }[];
    usage: { inputTokens: number; outputTokens: number; calls: number };
}

/**
 * Grows the question bank with AI-written questions.
 *
 * The pipeline, and the reason for each step:
 *
 *   generate            ask for N questions on a topic, constrained to a JSON schema
 *   schema validation   is the reply the shape we asked for
 *   business validation is each question actually usable
 *   independent check   solve each question again, WITHOUT showing the proposed answer
 *   store               verified only if the second answer agreed with the first
 *
 * The independent check is the part that matters. Structural validation proves a question
 * is well-formed; it cannot tell whether the marked answer is right. A question with a
 * wrong answer key is worse than no question at all -- it marks a learner wrong for being
 * right, and then the mastery engine records that as evidence. So the answer is checked by
 * a separate request that has not seen it, and a question only becomes visible when the two
 * agree.
 *
 * Questions that fail the check are kept but stay hidden. They cost nothing sitting there
 * and can be reviewed by a person later; deleting them would throw away the evidence of
 * what the model got wrong.
 */
export class QuestionBankService {
    private readonly ai: IAIProvider;
    private readonly questions: QuestionRepository;

    constructor(ai: IAIProvider, questions: QuestionRepository) {
        this.ai = ai;
        this.questions = questions;
    }

    async generateForTopic(
        input: GenerateQuestionsInput
    ): Promise<GenerateQuestionsResult> {
        const topic = await this.questions.findTopicWithSubject(input.topicId);

        if (!topic) {
            throw new AppError(404, 'TOPIC_NOT_FOUND', 'That topic does not exist.');
        }

        const existing = await this.questions.findBodiesForTopic(input.topicId);

        const generated = await this.ai.generateJson({
            system: QUESTION_AUTHOR_SYSTEM,
            prompt: questionGenerationPrompt({
                subjectName: topic.subjectName,
                topicName: topic.name,
                difficulty: input.difficulty,
                count: input.count,
                existingQuestions: existing,
            }),
            schema: GENERATED_QUESTIONS_SCHEMA,
        });

        const { accepted, rejected } = validateGeneratedQuestions(generated.data);

        const usage = {
            inputTokens: generated.usage.inputTokens,
            outputTokens: generated.usage.outputTokens,
            calls: 1,
        };

        const outcomes: GeneratedQuestionOutcome[] = [];

        // Lower-cased existing bodies, so a question we already have is recognised before
        // we pay to verify it.
        const known = new Set(existing.map((body) => body.trim().toLowerCase()));

        for (const question of accepted) {
            // The verification call costs money. Spending it on a question that cannot be
            // stored is pure waste, and the model does re-suggest what it was shown.
            if (known.has(question.body.trim().toLowerCase())) {
                outcomes.push({
                    body: question.body,
                    difficulty: question.difficulty,
                    verified: false,
                    reason: 'this question already exists on the topic, so it was not checked',
                    stored: false,
                });
                continue;
            }

            const check = await this.checkAnswer(question);
            usage.inputTokens += check.usage.inputTokens;
            usage.outputTokens += check.usage.outputTokens;
            usage.calls += 1;

            const stored = await this.questions.insertGenerated({
                topicId: input.topicId,
                questionType: question.questionType,
                body: question.body,
                options: question.options,
                correctOptionIndexes: question.correctOptionIndexes,
                explanation: question.explanation,
                difficulty: question.difficulty,
                isVerified: check.verified,
                createdBy: input.userId,
            });

            outcomes.push({
                body: question.body,
                difficulty: question.difficulty,
                verified: check.verified,
                reason: stored
                    ? check.reason
                    : 'a question with this text already exists on this topic',
                stored: stored !== null,
            });
        }

        return {
            topic: topic.name,
            requested: input.count,
            outcomes,
            discarded: rejected.map(({ reason }) => ({ reason })),
            usage,
        };
    }

    /**
     * Solves the question in a fresh request that has never seen the proposed answer, then
     * compares. A checker failure is not a crash: the question simply stays unverified.
     */
    private async checkAnswer(question: {
        body: string;
        options: string[];
        correctOptionIndexes: number[];
    }): Promise<{
        verified: boolean;
        reason: string;
        usage: { inputTokens: number; outputTokens: number };
    }> {
        const empty = { inputTokens: 0, outputTokens: 0 };

        try {
            const response = await this.ai.generateJson({
                system: QUESTION_CHECKER_SYSTEM,
                prompt: answerCheckPrompt(question),
                schema: ANSWER_CHECK_SCHEMA,
                maxTokens: 2000,
            });

            const parsed = answerCheckSchema.safeParse(response.data);

            if (!parsed.success) {
                return {
                    verified: false,
                    reason: 'the answer check came back in an unusable shape',
                    usage: response.usage,
                };
            }

            const verdict = agreesWithProposedAnswer(
                question.correctOptionIndexes,
                parsed.data
            );

            return { ...verdict, usage: response.usage };
        } catch {
            // The AI being unavailable must not turn into a verified question.
            return {
                verified: false,
                reason: 'the answer could not be independently checked',
                usage: empty,
            };
        }
    }
}
