import type { AttemptRepository } from '@/repositories/attemptRepository.js';
import type { LearnerRepository } from '@/repositories/learnerRepository.js';
import type { MasteryRepository } from '@/repositories/masteryRepository.js';
import type { RevisionRepository } from '@/repositories/revisionRepository.js';
import {
    type AttemptRecord,
    computeMastery,
    summariseAttempts,
} from '@/services/learner/masteryEngine.js';
import { SRS_CONFIG, firstSchedule, nextReview } from '@/services/learner/srsEngine.js';
import { todayIn } from '@/utils/dates.js';
import { type GivenAnswer, gradeAnswer } from '@/services/practice/grader.js';

export interface SubmitAttemptInput {
    userId: string;
    questionId: string;
    answer: GivenAnswer;
    timeTakenSeconds: number | null;
    source: 'practice' | 'assessment' | 'topic_test' | 'mock_test' | 'revision';
    /**
     * Whole days to the exam, so a review is never scheduled past it.
     *
     * Null when the learner has no goal, in which case the ordinary interval ceiling applies.
     */
    daysUntilExam?: number | null;
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
    private readonly revision: RevisionRepository;

    constructor(
        attempts: AttemptRepository,
        mastery: MasteryRepository,
        learners: LearnerRepository,
        revision: RevisionRepository
    ) {
        this.attempts = attempts;
        this.mastery = mastery;
        this.learners = learners;
        this.revision = revision;
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

        const scoreBefore = await this.mastery.findScore(input.userId, question.topic_id);

        const attempt = await this.attempts.insert({
            userId: input.userId,
            questionId: input.questionId,
            isCorrect,
            givenAnswer: input.answer,
            timeTakenSeconds: input.timeTakenSeconds,
            source: input.source,
        });

        // The learner's own calendar day, not the server's. Read once and used for the streak, the
        // revision schedule and the grading of today's answers, because all three must agree about
        // when "today" was — a streak that counts a day the schedule does not is two features
        // disagreeing about the same morning.
        const timezone = await this.timezoneOf(input.userId);
        const today = todayIn(timezone);

        const recomputed = await this.recomputeMastery(
            input.userId,
            attempt.topicId,
            today,
            timezone
        );

        await this.updateRevisionSchedule(
            input.userId,
            attempt.topicId,
            today,
            recomputed.answeredToday,
            recomputed.correctToday,
            input.daysUntilExam ?? null
        );

        // The learner-level counters are a convenience cache; if this ever fails the
        // attempt is still recorded and a rebuild will fix the numbers.
        await this.learners.recordAttemptOnProfile(
            input.userId,
            isCorrect,
            today,
            input.timeTakenSeconds ?? null
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

    /**
     * The learner's timezone, or null to let the caller fall back.
     *
     * Swallows its own failure: this is one column read in service of a date, and losing a submitted
     * answer over it would trade something that matters for something that does not.
     */
    private async timezoneOf(userId: string): Promise<string | null> {
        try {
            return await this.learners.findTimezone(userId);
        } catch {
            return null;
        }
    }

    /** Rebuilds one topic's mastery row from the attempt log. */
    private async recomputeMastery(
        userId: string,
        topicId: string,
        today: string,
        timezone: string | null
    ): Promise<{
        score: number;
        attemptsOnTopic: number;
        /**
         * Answers given on this topic *today*, which is what grades the review.
         *
         * Not the rolling recent-accuracy window. That was tried first and was wrong in a way only a
         * live run showed: three consecutive wrong answers produced a 50% rolling score, because
         * older correct answers diluted them, and the interval *grew* from 30 days to 36. SM-2 grades
         * the review that just happened; the history is already carried by the interval and the ease
         * factor, so folding it into the grade as well counts it twice and makes the schedule
         * unresponsive exactly when the learner needs it to react.
         */
        answeredToday: number;
        correctToday: number;
    }> {
        const rows = await this.attempts.findTopicAttempts(userId, topicId);

        // `attempted_at` is stored in UTC; `today` is the learner's own date, so the comparison is
        // made in their timezone rather than by slicing the timestamp.
        const todayRows = rows.filter(
            (row) => todayIn(timezone, new Date(row.attempted_at)) === today
        );

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
        const lastCorrectAt = rows.find((row) => row.is_correct)?.attempted_at ?? null;

        await this.mastery.save(userId, topicId, evidence, mastery, lastAttemptAt, lastCorrectAt);

        return {
            score: mastery.score,
            attemptsOnTopic: evidence.totalAttempts,
            answeredToday: todayRows.length,
            correctToday: todayRows.filter((row) => row.is_correct).length,
        };
    }

    /**
     * Moves the topic's place in the spaced-repetition schedule.
     *
     * **Graded on today's answers.** SM-2 asks the learner to rate their own recall; the app measures
     * it instead, which is better evidence — people are poor judges of what they know, the same
     * reason session completion is read from attempts rather than from a checkbox.
     *
     * **Once per topic per day, and the step only ever gets worse within that day.** SM-2 steps per
     * *review*, and a review here is a session rather than one question: stepping on every answer
     * would multiply the interval five times in a sitting and push a topic months out for one good
     * ten minutes. So the first answer of the day settles the review — and then a later answer the
     * same day may still collapse it, if the session has by then turned into a failure.
     *
     * That asymmetry is deliberate. It means a session opening with a lucky right answer cannot lock
     * in a long interval that the next four wrong answers would have destroyed, while a session
     * opening badly cannot be talked back up. It errs toward revising more, which is the safe
     * direction for a scheduler to be wrong in.
     *
     * Never throws. The answer is already recorded and mastery is already updated; a schedule that
     * failed to move is a topic that comes back a little late, which is not worth failing a
     * submission over.
     */
    private async updateRevisionSchedule(
        userId: string,
        topicId: string,
        today: string,
        answeredToday: number,
        correctToday: number,
        daysUntilExam: number | null
    ): Promise<void> {
        try {
            const state = await this.revision.findState(userId, topicId);

            const accuracyPercent = answeredToday > 0 ? (correctToday / answeredToday) * 100 : 0;

            const settledToday = state?.lastReviewedOn === today;

            if (settledToday) {
                // The session has turned into a failure since it was settled. Collapsing now is the
                // one same-day change allowed; anything else would let one answer's worth of luck
                // decide the whole interval.
                const failing = accuracyPercent < SRS_CONFIG.lapseAccuracyPercent;

                if (!failing || state.intervalDays <= 1) return;

                await this.revision.save(
                    userId,
                    topicId,
                    nextReview(
                        { ...state, intervalDays: state.intervalDays },
                        {
                            reviewedOn: today,
                            accuracyPercent,
                            questionsAnswered: answeredToday,
                            daysUntilExam,
                        }
                    )
                );
                return;
            }

            // A topic with no schedule and only today's first answer behind it is being learned, not
            // reviewed: there is no interval to grow and no ease to adjust, so it gets its first
            // short gap.
            if (state === null && answeredToday <= 1) {
                await this.revision.save(userId, topicId, firstSchedule(today, daysUntilExam));
                return;
            }

            await this.revision.save(
                userId,
                topicId,
                nextReview(state, {
                    reviewedOn: today,
                    accuracyPercent,
                    questionsAnswered: answeredToday,
                    daysUntilExam,
                })
            );
        } catch (error) {
            console.warn(
                `could not update the revision schedule for topic ${topicId}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }
    }
}
