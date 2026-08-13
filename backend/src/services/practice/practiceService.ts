import type { AttemptRepository } from '@/repositories/attemptRepository.js';
import type { LearnerRepository } from '@/repositories/learnerRepository.js';
import type { MasteryRepository } from '@/repositories/masteryRepository.js';
import {
    type AttemptRecord,
    computeMastery,
    summariseAttempts,
} from '@/services/learner/masteryEngine.js';
import { type GivenAnswer, gradeAnswer } from '@/services/practice/grader.js';

export interface SubmitAttemptInput {
    userId: string;
    questionId: string;
    answer: GivenAnswer;
    timeTakenSeconds: number | null;
    source: 'practice' | 'assessment' | 'topic_test' | 'mock_test' | 'revision';
}

export interface SubmitAttemptResult {
    attemptId: string;
    isCorrect: boolean;
    /** Released only now that the answer is committed. */
    correctAnswer: unknown;
    explanation: string | null;
    mastery: {
        topicId: string;
        before: number | null;
        after: number;
        change: number | null;
        attemptsOnTopic: number;
    };
}

/**
 * One submitted answer, start to finish. This is the loop the whole product turns on:
 *
 *   grade  ->  record  ->  recompute mastery  ->  hand back what changed
 *
 * Order matters. Grading happens before anything is written, so a malformed question fails
 * without leaving a half-recorded attempt. Mastery is recomputed from the attempt log
 * afterwards rather than nudged, so the score always matches the history behind it.
 */
export class PracticeService {
    private readonly attempts: AttemptRepository;
    private readonly mastery: MasteryRepository;
    private readonly learners: LearnerRepository;

    constructor(
        attempts: AttemptRepository,
        mastery: MasteryRepository,
        learners: LearnerRepository
    ) {
        this.attempts = attempts;
        this.mastery = mastery;
        this.learners = learners;
    }

    async submit(input: SubmitAttemptInput): Promise<SubmitAttemptResult> {
        const question = await this.attempts.findForGrading(input.questionId);

        const { isCorrect } = gradeAnswer(
            {
                questionType: question.question_type,
                correctAnswer: question.correct_answer,
            },
            input.answer
        );

        const scoreBefore = await this.mastery.findScore(
            input.userId,
            question.topic_id
        );

        const attempt = await this.attempts.insert({
            userId: input.userId,
            questionId: input.questionId,
            isCorrect,
            givenAnswer: input.answer,
            timeTakenSeconds: input.timeTakenSeconds,
            source: input.source,
        });

        const recomputed = await this.recomputeMastery(
            input.userId,
            attempt.topicId
        );

        // The learner-level counters are a convenience cache; if this ever fails the
        // attempt is still recorded and a rebuild will fix the numbers.
        await this.learners.recordAttemptOnProfile(
            input.userId,
            isCorrect,
            new Date().toISOString().slice(0, 10)
        );

        return {
            attemptId: attempt.id,
            isCorrect,
            correctAnswer: question.correct_answer,
            explanation: question.explanation,
            mastery: {
                topicId: attempt.topicId,
                before: scoreBefore,
                after: recomputed.score,
                change:
                    scoreBefore === null
                        ? null
                        : Math.round((recomputed.score - scoreBefore) * 100) / 100,
                attemptsOnTopic: recomputed.attemptsOnTopic,
            },
        };
    }

    /** Rebuilds one topic's mastery row from the attempt log. */
    private async recomputeMastery(
        userId: string,
        topicId: string
    ): Promise<{ score: number; attemptsOnTopic: number }> {
        const rows = await this.attempts.findTopicAttempts(userId, topicId);

        const records: AttemptRecord[] = rows.map((row) => ({
            isCorrect: row.is_correct,
            // Every question has a difficulty; medium is a safe read if a join ever
            // returns nothing, and it keeps the buckets adding up to the total.
            difficulty: row.questions?.difficulty ?? 'medium',
            attemptedAt: row.attempted_at,
        }));

        const evidence = summariseAttempts(records, new Date());
        const mastery = computeMastery(evidence);

        const lastAttemptAt = rows[0]?.attempted_at ?? new Date().toISOString();
        const lastCorrectAt =
            rows.find((row) => row.is_correct)?.attempted_at ?? null;

        await this.mastery.save(
            userId,
            topicId,
            evidence,
            mastery,
            lastAttemptAt,
            lastCorrectAt
        );

        return { score: mastery.score, attemptsOnTopic: evidence.totalAttempts };
    }
}
