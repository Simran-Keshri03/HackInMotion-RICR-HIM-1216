import type {
    PracticeQuestion,
    QuestionRepository,
} from '@/repositories/questionRepository.js';

export interface SelectedQuestions {
    questions: PracticeQuestion[];
    /** True when the bank could not fill the request, so the UI can say so honestly. */
    short: boolean;
    /** Which fallback was needed, if any. Useful when a topic looks thin. */
    note: string | null;
}

/**
 * Turns "5 medium questions on Trees" into actual questions.
 *
 * Three tries, in order of preference:
 *   1. unseen questions at the difficulty the engine asked for
 *   2. unseen questions at any difficulty on that topic
 *   3. questions the learner has seen before
 *
 * Repeating a question is a real fallback rather than a failure -- answering something a
 * second time is how spaced repetition works -- but it is reported, because a topic that
 * always falls through to step 3 needs more questions in the bank.
 */
export class QuestionSelector {
    private readonly questions: QuestionRepository;

    constructor(questions: QuestionRepository) {
        this.questions = questions;
    }

    async select(options: {
        userId: string;
        topicId: string;
        difficulty: 'easy' | 'medium' | 'hard';
        count: number;
    }): Promise<SelectedQuestions> {
        const attempted = await this.questions.findAttemptedIds(
            options.userId,
            options.topicId
        );

        const chosen = await this.questions.findForPractice({
            topicId: options.topicId,
            difficulty: options.difficulty,
            exclude: attempted,
            limit: options.count,
        });

        let note: string | null = null;

        if (chosen.length < options.count) {
            const anyDifficulty = await this.questions.findForPractice({
                topicId: options.topicId,
                difficulty: null,
                exclude: [...attempted, ...chosen.map((q) => q.id)],
                limit: options.count - chosen.length,
            });

            if (anyDifficulty.length > 0) {
                note = `Not enough unseen ${options.difficulty} questions, so some are from other levels.`;
                chosen.push(...anyDifficulty);
            }
        }

        if (chosen.length < options.count && attempted.length > 0) {
            const seenAgain = await this.questions.findForPractice({
                topicId: options.topicId,
                difficulty: options.difficulty,
                exclude: chosen.map((q) => q.id),
                limit: options.count - chosen.length,
            });

            if (seenAgain.length > 0) {
                note =
                    'You have seen every question on this topic, so some are repeats.';
                chosen.push(...seenAgain);
            }
        }

        return {
            questions: chosen.slice(0, options.count),
            short: chosen.length < options.count,
            note,
        };
    }
}
