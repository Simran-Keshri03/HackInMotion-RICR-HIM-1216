import type { AssessmentRepository, AssessmentRow } from '@/repositories/assessmentRepository.js';
import type { AttemptRepository } from '@/repositories/attemptRepository.js';
import type { MasteryRepository } from '@/repositories/masteryRepository.js';
import type { PracticeQuestion } from '@/repositories/questionRepository.js';
import {
    DIAGNOSTIC_CONFIG,
    type DiagnosticResult,
    planDiagnostic,
    summariseDiagnostic,
} from '@/services/assessment/diagnosticEngine.js';
import {
    type AttemptRecord,
    computeMastery,
    summariseAttempts,
} from '@/services/learner/masteryEngine.js';
import { type GivenAnswer, gradeAnswer } from '@/services/practice/grader.js';
import { AppError } from '@/utils/http.js';

export interface AssessmentView {
    id: string;
    status: string;
    questionCount: number;
    durationMinutes: number;
    startedAt: string;
    completedAt: string | null;
    /** Only while open. Never with the answers. */
    questions?: PracticeQuestion[];
    /** Only once completed. */
    result?: DiagnosticResult;
    /** Which subjects the paper covers, shown before it starts. */
    coverage?: { subjectName: string; questionCount: number }[];
    uncovered?: { subjectName: string; reason: string }[];
}

export interface DiagnosticAnswerInput {
    questionId: string;
    answer?: GivenAnswer;
}

/**
 * The diagnostic assessment: measure what a learner knows, so the study plan can prioritise.
 *
 * The important design decision is what this writes. It does **not** store an "assessed knowledge
 * level" of its own. Every answer is recorded as an ordinary `question_attempts` row with
 * `source: 'assessment'`, and mastery is then recomputed from the attempt log through the same formula
 * every other answer goes through.
 *
 * That matters because a stored level would be a second source of truth. It could disagree with the
 * attempts behind it — after a formula change, after a re-test, after any recompute — and then two
 * screens would tell a learner different things about the same subject. Feeding the existing pipeline
 * means the plan improves for exactly one reason: there is now evidence where there was none.
 *
 * Marking happens in one pass at submission, for the same reason a mock test does: revealing an answer
 * mid-paper changes the answers that follow, and a diagnostic whose result depends on that is not a
 * measurement.
 */
export class AssessmentService {
    private readonly assessments: AssessmentRepository;
    private readonly attempts: AttemptRepository;
    private readonly mastery: MasteryRepository;

    constructor(
        assessments: AssessmentRepository,
        attempts: AttemptRepository,
        mastery: MasteryRepository
    ) {
        this.assessments = assessments;
        this.attempts = attempts;
        this.mastery = mastery;
    }

    /** The diagnostic for this goal, or null if it has never been sat. */
    async getForGoal(userId: string, goalId: string): Promise<AssessmentView | null> {
        const row = await this.assessments.findForGoal(userId, goalId);
        if (!row) return null;

        return this.view(userId, row);
    }

    async getOne(userId: string, assessmentId: string): Promise<AssessmentView> {
        const row = await this.assessments.find(assessmentId, userId);

        if (!row) {
            // 404 rather than 403: confirming it exists but is not yours is itself a leak.
            throw new AppError(404, 'ASSESSMENT_NOT_FOUND', 'That assessment does not exist.');
        }

        return this.view(userId, row);
    }

    /**
     * Builds a diagnostic for the learner's goal.
     *
     * An unfinished one is abandoned rather than blocking this: somebody starting again has decided the
     * old attempt is over, and refusing them until they finish a paper they walked away from is the app
     * arguing with them.
     */
    async start(
        userId: string,
        goalId: string,
        requestedQuestions: number
    ): Promise<AssessmentView> {
        const topics = await this.assessments.findAssessableTopics(goalId);

        if (topics.length === 0) {
            throw new AppError(
                400,
                'NOTHING_TO_ASSESS',
                'There are no topics with questions in your subjects yet, so there is nothing to assess.'
            );
        }

        const plan = planDiagnostic(topics, requestedQuestions);

        if (plan.picks.length === 0) {
            throw new AppError(
                400,
                'NOTHING_TO_ASSESS',
                'None of your subjects have questions yet. Practise a little first and the assessment will have something to ask.'
            );
        }

        // One question per chosen topic. Sequential rather than parallel: the list is at most 25 and
        // the order has to match the picks so the breakdown lines up.
        const questionIds: string[] = [];

        for (const pick of plan.picks) {
            const id = await this.assessments.findOneQuestionForTopic(pick.topicId);
            if (id) questionIds.push(id);
        }

        if (questionIds.length === 0) {
            throw new AppError(
                400,
                'NOTHING_TO_ASSESS',
                'None of your subjects have questions yet.'
            );
        }

        await this.assessments.abandonOpen(userId, goalId);

        const row = await this.assessments.create({
            userId,
            goalId,
            // From what was actually found, not what was asked for. A paper that says 15 and serves 12
            // makes its own progress indicator wrong.
            questionCount: questionIds.length,
        });

        await this.assessments.addQuestions(row.id, questionIds);

        const view = await this.view(userId, row);

        return {
            ...view,
            coverage: plan.coverage.map((entry) => ({
                subjectName: entry.subjectName,
                questionCount: entry.questionCount,
            })),
            ...(plan.uncovered.length > 0 ? { uncovered: plan.uncovered } : {}),
        };
    }

    /**
     * Marks the paper and lets it move mastery.
     *
     * Every answer becomes an attempt, then each touched topic's mastery is recomputed from its full
     * attempt log. After this returns, the study plan generator has something to prioritise with — which
     * is the entire point of the feature.
     */
    async submit(
        userId: string,
        assessmentId: string,
        answers: DiagnosticAnswerInput[]
    ): Promise<AssessmentView> {
        const row = await this.assessments.find(assessmentId, userId);

        if (!row) {
            throw new AppError(404, 'ASSESSMENT_NOT_FOUND', 'That assessment does not exist.');
        }

        if (row.status === 'completed') {
            // Idempotent: a double-tapped submit returns the result rather than writing a second set of
            // attempts for the same questions, which would double-count the evidence.
            return this.view(userId, row);
        }

        const questions = await this.assessments.findQuestions(row.id);
        const given = new Map(answers.map((entry) => [entry.questionId, entry.answer]));

        let correct = 0;
        const touchedTopics = new Set<string>();

        for (const question of questions) {
            const answer = given.get(question.question_id);
            if (answer === undefined) continue;

            // The correct answer is read here, on the server, for the first time in this paper's life.
            const gradable = await this.attempts.findForGrading(question.question_id);

            let isCorrect = false;

            try {
                isCorrect = gradeAnswer(
                    {
                        questionType: gradable.question_type,
                        correctAnswer: gradable.correct_answer,
                    },
                    answer
                ).isCorrect;
            } catch {
                // A malformed answer for this question type marks wrong rather than failing the whole
                // submission. Losing a finished paper over one bad field would be worse.
                isCorrect = false;
            }

            if (isCorrect) correct += 1;

            const attempt = await this.attempts.insert({
                userId,
                questionId: question.question_id,
                isCorrect,
                givenAnswer: answer,
                // Per-question timing is not tracked in an assessment — the learner moves back and
                // forth — so it is left out rather than guessed at by dividing the total.
                timeTakenSeconds: null,
                source: 'assessment',
            });

            await this.assessments.linkAttempt(row.id, question.question_id, attempt.id);
            touchedTopics.add(attempt.topicId);
        }

        // This is the step that makes the plan personalised. Without it the attempts exist and no
        // mastery row does, so the planner still sees a learner it knows nothing about.
        for (const topicId of touchedTopics) {
            await this.recomputeMastery(userId, topicId);
        }

        const completed = await this.assessments.complete(row.id, correct);

        return this.view(userId, completed);
    }

    /** Open papers carry questions; completed ones carry the result. */
    private async view(userId: string, row: AssessmentRow): Promise<AssessmentView> {
        const base: AssessmentView = {
            id: row.id,
            status: row.status,
            questionCount: row.question_count,
            durationMinutes: Math.max(
                1,
                Math.round((row.question_count * DIAGNOSTIC_CONFIG.secondsPerQuestion) / 60)
            ),
            startedAt: row.started_at,
            completedAt: row.completed_at,
        };

        const questions = await this.assessments.findQuestions(row.id);

        if (row.status !== 'completed') {
            const bodies = await this.assessments.findQuestionBodies(
                questions.map((entry) => entry.question_id)
            );

            const byId = new Map(bodies.map((body) => [body.id, body]));

            return {
                ...base,
                questions: questions
                    .map((entry) => byId.get(entry.question_id))
                    .filter((body): body is PracticeQuestion => body !== undefined),
            };
        }

        // Completed: rebuild the per-subject breakdown from the attempts the paper produced.
        const answered = questions.filter((entry) => entry.attempt_id !== null);

        const attempts = await this.attempts.findByIds(
            answered.map((entry) => entry.attempt_id as string)
        );

        const subjects = await this.assessments.findTopicSubjects([
            ...new Set(attempts.map((attempt) => attempt.topic_id)),
        ]);

        const answers = questions.map((entry) => {
            const attempt = attempts.find((a) => a.id === entry.attempt_id);
            const subject = attempt ? subjects.get(attempt.topic_id) : undefined;

            return {
                topicId: attempt?.topic_id ?? '',
                subjectId: subject?.subjectId ?? 'unknown',
                subjectName: subject?.subjectName ?? 'Subject',
                isCorrect: attempt?.is_correct === true,
                answered: attempt !== undefined,
            };
        });

        return { ...base, result: summariseDiagnostic(answers) };
    }

    /** Rebuilds one topic's mastery from its attempt log — the same path practice uses. */
    private async recomputeMastery(userId: string, topicId: string): Promise<void> {
        const rows = await this.attempts.findTopicAttempts(userId, topicId);

        const records: AttemptRecord[] = rows.map((row) => ({
            isCorrect: row.is_correct,
            difficulty: row.questions?.difficulty ?? 'medium',
            attemptedAt: row.attempted_at,
        }));

        const evidence = summariseAttempts(records, new Date());
        const mastery = computeMastery(evidence);

        await this.mastery.save(
            userId,
            topicId,
            evidence,
            mastery,
            rows[0]?.attempted_at ?? new Date().toISOString(),
            rows.find((row) => row.is_correct)?.attempted_at ?? null
        );
    }
}

export { DIAGNOSTIC_CONFIG };
