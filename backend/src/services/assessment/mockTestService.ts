import type { AttemptRepository } from '@/repositories/attemptRepository.js';
import type { LearnerRepository } from '@/repositories/learnerRepository.js';
import type {
    MockTestRepository,
    MockTestRow,
} from '@/repositories/mockTestRepository.js';
import type { PlanRepository } from '@/repositories/planRepository.js';
import type { PracticeQuestion } from '@/repositories/questionRepository.js';
import {
    MOCK_TEST_CONFIG,
    type MockTestResult,
    type MockTestTopic,
    markMockTest,
    planMockTest,
} from '@/services/assessment/mockTestEngine.js';
import { type GivenAnswer, gradeAnswer } from '@/services/practice/grader.js';
import { AppError } from '@/utils/http.js';

export interface MockTestView {
    id: string;
    title: string;
    source: string;
    status: string;
    totalQuestions: number;
    durationMinutes: number;
    startedAt: string;
    submittedAt: string | null;
    correctCount: number | null;
    scorePercent: number | null;
    /** Only while the test is open. Absent once submitted, because the paper is over. */
    questions?: PracticeQuestion[];
    /** Only once submitted. */
    result?: MockTestResult & {
        byTopic: (MockTestResult['byTopic'][number] & { name: string })[];
    };
    /** Which topics the test covers and why, shown before it starts. */
    coverage?: { name: string; subjectName: string | null; questionCount: number; reason: string }[];
    omitted?: { name: string; reason: string }[];
}

export interface SubmittedAnswer {
    questionId: string;
    /** Absent for a question the learner skipped — different from getting it wrong. */
    answer?: GivenAnswer;
}

/**
 * Mock tests: generate one from the study plan, serve it without answers, mark it at the end.
 *
 * The rule this service exists to hold: **the correct answer never leaves the server until the test is
 * submitted.** Nothing here returns `correct_answer`, and marking happens in one pass over every
 * answer at the end. Doing it per question — reusing the ordinary attempts endpoint — would put the
 * answer in the response mid-test, and hiding it in the client would be theatre: it would still be in
 * devtools.
 *
 * Answers are also written to `question_attempts` with `source: 'mock_test'`, so a test moves mastery
 * like any other evidence. It should: a question answered under test conditions is better evidence of
 * knowledge than one answered with the explanation a click away.
 */
export class MockTestService {
    private readonly tests: MockTestRepository;
    private readonly plans: PlanRepository;
    private readonly learners: LearnerRepository;
    private readonly attempts: AttemptRepository;

    constructor(
        tests: MockTestRepository,
        plans: PlanRepository,
        learners: LearnerRepository,
        attempts: AttemptRepository
    ) {
        this.tests = tests;
        this.plans = plans;
        this.learners = learners;
        this.attempts = attempts;
    }

    async listRecent(userId: string): Promise<MockTestView[]> {
        const rows = await this.tests.findRecent(userId);
        return rows.map(toView);
    }

    /** The test the learner walked away from, if there is one. */
    async getOpen(userId: string): Promise<MockTestView | null> {
        const open = await this.tests.findOpenTest(userId);
        if (!open) return null;

        return this.getOne(userId, open.id);
    }

    /**
     * One test.
     *
     * While it is open this returns the question bodies and no answers. Once submitted it returns the
     * result and *not* the questions — the paper is over, and the review screen is the breakdown.
     */
    async getOne(userId: string, testId: string): Promise<MockTestView> {
        const test = await this.tests.findTest(testId, userId);

        if (!test) {
            // 404 rather than 403: confirming a test exists but is not yours is itself a leak.
            throw new AppError(404, 'TEST_NOT_FOUND', 'That test does not exist.');
        }

        const rows = await this.tests.findTestQuestions(test.id);

        if (test.status === 'submitted') {
            const details = await this.tests.findTopicDetails(
                [...new Set(rows.map((row) => row.topic_id).filter(Boolean))] as string[]
            );

            const names = new Map(
                [...details.entries()].map(([id, detail]) => [id, detail.name])
            );

            const marked = markMockTest(
                rows.map((row) => ({
                    topicId: row.topic_id,
                    isCorrect: row.is_correct === true,
                    answered: row.given_answer !== null,
                })),
                names
            );

            return {
                ...toView(test),
                result: {
                    ...marked,
                    byTopic: marked.byTopic.map((entry) => ({
                        ...entry,
                        name: names.get(entry.topicId) ?? 'Topic',
                    })),
                },
            };
        }

        // Open: bodies in the test's own order, and nothing else.
        const bodies = await this.tests.findQuestionBodies(
            rows.map((row) => row.question_id)
        );

        const byId = new Map(bodies.map((body) => [body.id, body]));

        return {
            ...toView(test),
            questions: rows
                .map((row) => byId.get(row.question_id))
                .filter((body): body is PracticeQuestion => body !== undefined),
        };
    }

    /**
     * Builds a test from the learner's plan.
     *
     * An open test is abandoned rather than blocking this. Somebody asking for a new test has decided
     * the old one is over, and refusing them until they finish a paper they walked away from is the
     * app arguing with them.
     */
    async generate(
        userId: string,
        requestedQuestions: number
    ): Promise<MockTestView> {
        const plan = await this.plans.findActivePlan(userId);

        const candidates = plan
            ? await this.topicsFromPlan(userId, plan.id)
            : await this.topicsFromGoal(userId);

        if (candidates.length === 0) {
            throw new AppError(
                400,
                'NOTHING_TO_TEST',
                plan
                    ? 'Your plan has no topics with questions yet. Practise a little first, then come back.'
                    : 'Set a learning goal and build a plan first — a test is drawn from what you are scheduled to study.'
            );
        }

        const profile = await this.learners.findProfile(userId);

        const built = planMockTest(
            candidates,
            requestedQuestions,
            profile?.avg_seconds_per_question
                ? Number(profile.avg_seconds_per_question)
                : null
        );

        if (built.allocations.length === 0) {
            throw new AppError(
                400,
                'NOTHING_TO_TEST',
                'There are not enough questions on your topics to make a test yet.'
            );
        }

        // Pull the ids per topic, then interleave — see `interleave` for why the order matters.
        const perTopic = await Promise.all(
            built.allocations.map(async (allocation) => {
                const rows = await this.tests.findQuestionsForTopic(
                    allocation.topicId,
                    allocation.questionCount
                );

                return rows.map((row) => row.id);
            })
        );

        const questionIds = interleave(perTopic);

        if (questionIds.length === 0) {
            throw new AppError(
                400,
                'NOTHING_TO_TEST',
                'There are not enough questions on your topics to make a test yet.'
            );
        }

        await this.tests.abandonOpenTests(userId);

        const test = await this.tests.createTest({
            userId,
            planId: plan?.id ?? null,
            title: titleFor(built.allocations.length, questionIds.length),
            source: plan ? 'plan' : 'goal',
            // From the ids actually found, not from what was asked for. A test that says 15 and serves
            // 12 is a test whose score cannot be compared with the last one.
            totalQuestions: questionIds.length,
            durationMinutes: built.durationMinutes,
        });

        await this.tests.addQuestions(test.id, questionIds);

        const view = await this.getOne(userId, test.id);

        return {
            ...view,
            coverage: built.allocations.map((allocation) => ({
                name: allocation.name,
                subjectName: allocation.subjectName,
                questionCount: allocation.questionCount,
                reason: allocation.reason,
            })),
            ...(built.omitted.length > 0 ? { omitted: built.omitted } : {}),
        };
    }

    /**
     * Marks the whole paper.
     *
     * Every answer arrives at once, which is what makes withholding the answers possible. Questions
     * the learner did not send are recorded as skipped rather than wrong — the score treats them the
     * same, but the result reports them separately so "40% having answered everything" and "40% having
     * answered half" can be told apart.
     */
    async submit(
        userId: string,
        testId: string,
        answers: SubmittedAnswer[],
        secondsTaken: number
    ): Promise<MockTestView> {
        const test = await this.tests.findTest(testId, userId);

        if (!test) {
            throw new AppError(404, 'TEST_NOT_FOUND', 'That test does not exist.');
        }

        if (test.status === 'submitted') {
            // Idempotent: a double-tapped submit button returns the result rather than an error, and
            // re-marking would write a second set of attempts for the same questions.
            return this.getOne(userId, testId);
        }

        const rows = await this.tests.findTestQuestions(test.id);
        const given = new Map(answers.map((answer) => [answer.questionId, answer.answer]));

        const marks: { questionId: string; givenAnswer: unknown; isCorrect: boolean }[] = [];

        for (const row of rows) {
            const answer = given.get(row.question_id);
            if (answer === undefined) continue;

            // The correct answer is read here, on the server, for the first time in this test's life.
            const question = await this.attempts.findForGrading(row.question_id);

            let isCorrect = false;

            try {
                isCorrect = gradeAnswer(
                    {
                        questionType: question.question_type,
                        correctAnswer: question.correct_answer,
                    },
                    answer
                ).isCorrect;
            } catch {
                // A malformed answer for this question type marks as wrong rather than failing the
                // whole submission. Losing a finished paper over one bad field would be worse.
                isCorrect = false;
            }

            marks.push({ questionId: row.question_id, givenAnswer: answer, isCorrect });

            // Recorded as a real attempt, so the test moves mastery like any other evidence. Its own
            // source, so a later analysis can separate test performance from practice.
            await this.attempts.insert({
                userId,
                questionId: row.question_id,
                isCorrect,
                givenAnswer: answer,
                // Per-question timing is not tracked in a test — the learner moves back and forth —
                // so this is left out rather than guessed at by dividing the total.
                timeTakenSeconds: null,
                source: 'mock_test',
            });
        }

        await this.tests.markQuestions(test.id, marks);

        const details = await this.tests.findTopicDetails(
            [...new Set(rows.map((row) => row.topic_id).filter(Boolean))] as string[]
        );

        const marked = markMockTest(
            rows.map((row) => {
                const mark = marks.find((entry) => entry.questionId === row.question_id);

                return {
                    topicId: row.topic_id,
                    isCorrect: mark?.isCorrect === true,
                    answered: mark !== undefined,
                };
            }),
            new Map([...details.entries()].map(([id, detail]) => [id, detail.name]))
        );

        await this.tests.submitTest(test.id, {
            correctCount: marked.correctCount,
            scorePercent: marked.scorePercent,
            secondsTaken: Math.max(0, Math.min(86_400, Math.round(secondsTaken))),
        });

        return this.getOne(userId, test.id);
    }

    /** Plan topics, enriched with mastery, names and how many questions each has. */
    private async topicsFromPlan(
        userId: string,
        planId: string
    ): Promise<MockTestTopic[]> {
        const planned = await this.tests.findPlanTopics(planId);
        if (planned.length === 0) return [];

        const topicIds = planned.map((entry) => entry.topicId);

        const [details, counts, performance] = await Promise.all([
            this.tests.findTopicDetails(topicIds),
            this.tests.countQuestionsByTopic(topicIds),
            this.plans.findTopicPerformance(userId, topicIds),
        ]);

        const mastery = new Map(
            performance.map((entry) => [entry.topicId, entry.masteryScore])
        );

        return planned.flatMap((entry) => {
            const detail = details.get(entry.topicId);
            if (!detail) return [];

            return [
                {
                    topicId: entry.topicId,
                    name: detail.name,
                    subjectName: detail.subjectName,
                    weight: detail.weight,
                    masteryScore: mastery.get(entry.topicId) ?? null,
                    plannedSessions: entry.plannedSessions,
                    availableQuestions: counts.get(entry.topicId) ?? 0,
                },
            ];
        });
    }

    /**
     * Fallback when there is no plan: the goal's own topics.
     *
     * Worth having rather than refusing. Somebody who set a goal and practised without building a plan
     * can still be tested on what they chose to study, and `source: 'goal'` records that the test was
     * not measuring a plan.
     */
    private async topicsFromGoal(userId: string): Promise<MockTestTopic[]> {
        const subjects = await this.learners.findGoalSubjects(userId);
        if (subjects.length === 0) return [];

        const scopeIds = subjects.map((subject) => subject.id);
        const plannable = await this.plans.findPlannableTopics(userId, scopeIds);
        if (plannable.length === 0) return [];

        const counts = await this.tests.countQuestionsByTopic(
            plannable.map((topic) => topic.topicId)
        );

        return plannable.map((topic) => ({
            topicId: topic.topicId,
            name: topic.name,
            subjectName: topic.subjectName,
            weight: topic.weight,
            masteryScore: topic.masteryScore,
            // No plan, so nothing is scheduled — every topic gets the same neutral standing and the
            // ranking falls to mastery and weight.
            plannedSessions: 0,
            availableQuestions: counts.get(topic.topicId) ?? 0,
        }));
    }
}

/**
 * Round-robins the per-topic question lists into one paper.
 *
 * Not concatenation. A paper grouped by topic lets a learner settle into one subject and coast, which
 * is not what an exam does — and worse, somebody who runs out of time loses whole topics from their
 * breakdown rather than a few questions spread across it.
 */
function interleave(groups: string[][]): string[] {
    const out: string[] = [];
    const longest = Math.max(0, ...groups.map((group) => group.length));

    for (let index = 0; index < longest; index += 1) {
        for (const group of groups) {
            const id = group[index];
            if (id) out.push(id);
        }
    }

    return out;
}

function titleFor(topicCount: number, questionCount: number): string {
    return `${questionCount}-question test across ${topicCount} topic${topicCount === 1 ? '' : 's'}`;
}

function toView(test: MockTestRow): MockTestView {
    return {
        id: test.id,
        title: test.title,
        source: test.source,
        status: test.status,
        totalQuestions: test.total_questions,
        durationMinutes: test.duration_minutes,
        startedAt: test.started_at,
        submittedAt: test.submitted_at,
        correctCount: test.correct_count,
        scorePercent:
            test.score_percent === null ? null : Number(test.score_percent),
    };
}

export { MOCK_TEST_CONFIG };
