/**
 * The shapes the backend sends. Written by hand rather than generated, so the frontend
 * declares what it actually depends on and a backend change that breaks it shows up as a
 * type error rather than as undefined at runtime.
 */

/** Every response from the API is one of these two. */
export type ApiResponse<T> =
    | { success: true; data: T; error: null }
    | { success: false; data: null; error: { code: string; message: string } };

export interface LearnerSummary {
    hasActivity: boolean;
    attempts: { total: number; correct: number; accuracyPercent: number | null };
    habits: {
        currentStreakDays: number;
        longestStreakDays: number;
        consistencyPercent: number | null;
        lastActiveDate: string | null;
        avgSecondsPerQuestion: number | null;
    };
    preferredDifficulty: 'easy' | 'medium' | 'hard' | null;
    weakestTopics: {
        topicId: string;
        name: string;
        masteryScore: number;
        attempts: number;
        accuracyPercent: number | null;
        recentAccuracyPercent: number | null;
    }[];
    computedAt: string | null;
}

export type LearningAction = 'learn_new' | 'practice' | 'revise' | 'mini_test';

export interface PracticeQuestion {
    id: string;
    topic_id: string;
    question_type: 'mcq' | 'msq' | 'numeric';
    body: string;
    options: string[] | null;
    difficulty: 'easy' | 'medium' | 'hard';
    marks: number;
}

export interface Recommendation {
    action: LearningAction;
    topic: { id: string; name: string };
    difficulty: 'easy' | 'medium' | 'hard';
    questionCount: number;
    estimatedMinutes: number;
    reason: string;
    signals: {
        masteryScore: number | null;
        recentAccuracyPercent: number | null;
        totalAttempts: number;
        daysSinceLastAttempt: number | null;
    };
    alternatives: {
        topicId: string;
        name: string;
        score: number;
        masteryScore: number | null;
    }[];
}

export interface NextSession {
    recommendation: Recommendation | null;
    questions: PracticeQuestion[];
    /** Present when the bank could not fill the request, so the UI can be honest. */
    bankNote?: string | null;
    /** Present when there is no recommendation to make. */
    reason?: string;
}

export interface AttemptResult {
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

export interface Subject {
    id: string;
    name: string;
    /** Exam importance; the planner and readiness score multiply by this. */
    weight: number;
    topicCount: number;
}

/** A syllabus: what "class 10" or "GATE CSE" actually contains. */
export interface Curriculum {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    /** False for the syllabus that ships with the app, true for one the model worked out. */
    isAiGenerated: boolean;
}

/**
 * What came back from asking the model to make sense of what the learner typed.
 *
 * `rejected` arrives as a normal 200 — "dog is not a study goal" is a correct answer to a
 * well-formed request, so it is not modelled as an error.
 */
export interface ResolveOutcome {
    status: 'cached' | 'created' | 'rejected';
    curriculum?: Curriculum;
    subjects?: Subject[];
    /** Present when rejected: what to show the learner. */
    message?: string;
}

export interface Goal {
    id: string;
    title: string;
    /** The syllabus this goal draws its subjects and topics from. */
    curriculumId: string | null;
    /** YYYY-MM-DD. */
    examDate: string;
    dailyMinutes: number;
    subjectIds: string[];
    /** Whole days from today. */
    daysRemaining: number;
    /** dailyMinutes x daysRemaining — the budget the planner divides work by. */
    totalMinutesAvailable: number;
}

export interface ConversationSummary {
    id: string;
    title: string;
    topicId: string | null;
    lastMessageAt: string;
    /** False when the question was saved but the model never answered — an outage. */
    answered: boolean;
}

export interface TutorMessage {
    role: 'learner' | 'tutor';
    content: string;
    createdAt: string;
}

export interface TutorReply {
    conversationId: string;
    title: string;
    answer: string;
    messages: TutorMessage[];
    usage: { inputTokens: number; outputTokens: number; model: string };
}

/** One planned block: a topic, a length, and why. */
export interface PlannedSession {
    id: string;
    topicId: string;
    topicName: string;
    plannedMinutes: number;
    plannedQuestions: number;
    kind: string;
    /** Written by the planner, so a learner can argue with the plan rather than just obey it. */
    reason: string | null;
    status: string;
}

export interface StudyPlan {
    id: string;
    /** Increments on every rebuild; the old plan is kept, not overwritten. */
    version: number;
    examDate: string;
    dailyMinutes: number;
    daysRemaining: number;
    totalMinutesPlanned: number;
    topicsCovered: number;
    reason: string;
    createdAt: string;
    days: { date: string; totalMinutes: number; sessions: PlannedSession[] }[];
    /** Present when the budget could not cover everything in the goal. */
    omittedTopics?: { name: string; reason: string }[];
}

/**
 * What the app changed about the plan on its own, and why.
 *
 * Present only on the read that actually rebuilt the plan. A plan that moves without saying why
 * reads as a bug, so this is the sentence the learner is owed.
 */
export interface PlanAdjustment {
    reason: 'missed_sessions' | 'poor_performance' | 'goal_changed' | 'requested';
    explanation: string;
}

/** One square in the activity grid. */
export interface ActivityDay {
    date: string;
    count: number;
    /** 0-4 for the colour ramp; 0 means nothing was answered. */
    level: 0 | 1 | 2 | 3 | 4;
}

export interface ActivityCalendar {
    /** Every day in the window, oldest first, gaps included. */
    days: ActivityDay[];
    totalAnswered: number;
    activeDays: number;
    maxStreak: number;
    currentStreak: number;
    from: string;
    to: string;
}

export interface Badge {
    id: string;
    name: string;
    family: string;
    description: string;
    /** Only recoverable for streak badges; null for the rest. */
    earnedOn: string | null;
}

export interface BadgeProgress {
    id: string;
    name: string;
    family: string;
    current: number;
    target: number;
    description: string;
}

export interface ActivityResponse {
    calendar: ActivityCalendar;
    badges: Badge[];
    /** Next milestone per family, closest first. */
    upcoming: BadgeProgress[];
    latestBadge: Badge | null;
}

/** What one group member may know about another. The privacy boundary, mirrored from the backend. */
export interface GroupMemberProgress {
    userId: string;
    displayName: string;
    questionsAnswered: number;
    currentStreakDays: number;
    topicsMastered: number;
    isYou: boolean;
    /** Ties share a rank. */
    rank: number;
}

export interface GroupSummary {
    id: string;
    name: string;
    inviteCode: string;
    memberCount: number;
    role: string;
    createdAt: string;
}

export interface GroupDetail extends GroupSummary {
    comparison: {
        members: GroupMemberProgress[];
        yourRank: number | null;
        memberCount: number;
        totals: { questionsAnswered: number; topicsMastered: number };
        topStreak: { displayName: string; days: number } | null;
    };
}

export interface LearnerProfile {
    /** Null until the learner sets one; screens fall back rather than showing a blank. */
    displayName: string | null;
    email: string;
    /** IANA zone. Decides which calendar day their streaks and revision dates fall in. */
    timezone: string;
    createdAt: string;
}

/** A subject from the learner's goal, with how far through it they are. */
export interface GoalSubject {
    id: string;
    name: string;
    /** Exam importance. The planner and the ranking multiply by this. */
    weight: number;
    topicCount: number;
    /** Topics with at least one attempt — the honest number for a progress bar. */
    topicsStarted: number;
    topicsMastered: number;
    questionsAnswered: number;
    /** Over the topics actually attempted, or null with none. */
    averageMastery: number | null;
}

export interface MockTestResult {
    correctCount: number;
    /** Reported separately from correct: blank and wrong score the same but mean different things. */
    answeredCount: number;
    totalQuestions: number;
    scorePercent: number;
    passed: boolean;
    byTopic: {
        topicId: string;
        name: string;
        correct: number;
        total: number;
        percent: number;
    }[];
    /** One sentence naming what to do next. */
    verdict: string;
}

export interface MockTest {
    id: string;
    title: string;
    /** 'plan' when topics came from scheduled sessions, 'goal' when there was no plan. */
    source: string;
    status: string;
    totalQuestions: number;
    durationMinutes: number;
    startedAt: string;
    submittedAt: string | null;
    correctCount: number | null;
    scorePercent: number | null;
    /** Present only while the paper is open — and never with the correct answers. */
    questions?: PracticeQuestion[];
    /** Present only once submitted. */
    result?: MockTestResult;
    coverage?: {
        name: string;
        subjectName: string | null;
        questionCount: number;
        reason: string;
    }[];
    omitted?: { name: string; reason: string }[];
}

export interface MockTestList {
    tests: MockTest[];
    /** A paper left unfinished, offered rather than lost. */
    open: MockTest | null;
    limits: { min: number; max: number; default: number };
}

/** A subject's band after the diagnostic. Bands, not percentages — see the engine for why. */
export interface SubjectLevel {
    subjectId: string;
    subjectName: string;
    correct: number;
    total: number;
    percent: number;
    level: 'strong' | 'moderate' | 'weak' | 'unmeasured';
}

export interface DiagnosticResult {
    correctCount: number;
    /** Reported apart from correct: a half-finished paper is not a measurement. */
    answeredCount: number;
    totalQuestions: number;
    accuracyPercent: number;
    /** Weakest first — the order the plan will spend time in. */
    subjects: SubjectLevel[];
    verdict: string;
}

export interface Assessment {
    id: string;
    status: string;
    questionCount: number;
    durationMinutes: number;
    startedAt: string;
    completedAt: string | null;
    /** Present only while open, and never with the answers. */
    questions?: PracticeQuestion[];
    /** Present only once completed. */
    result?: DiagnosticResult;
    coverage?: { subjectName: string; questionCount: number }[];
    uncovered?: { subjectName: string; reason: string }[];
}

export interface DiagnosticList {
    /** Null when this goal has never been assessed. */
    assessment: Assessment | null;
    limits: { min: number; max: number; default: number };
}

export interface ReadinessComponent {
    key: 'mastery' | 'coverage' | 'mock' | 'time';
    label: string;
    /** 0-100. */
    score: number;
    /** Share of the total this component carried, after any omissions. Sums to 1. */
    weight: number;
    detail: string;
}

export interface ReadinessGap {
    topicId: string;
    name: string;
    subjectName: string | null;
    masteryScore: number | null;
    cost: number;
}

export interface Readiness {
    /** 0-100. */
    score: number;
    band: 'not_ready' | 'building' | 'on_track' | 'ready';
    /** How much the score should be trusted, which is not the same as what it is. */
    confidence: 'low' | 'medium' | 'high';
    verdict: string;
    components: ReadinessComponent[];
    /** Answered and still short of the target. Measured, so this is evidence. */
    gaps: ReadinessGap[];
    /** Heaviest topics never attempted. Cost assumes a mastery of zero rather than measuring one. */
    notStarted: ReadinessGap[];
    daysRemaining: number;
    topicsInScope: number;
    topicsAttempted: number;
    topicsMastered: number;
    mocksTaken: number;
}

export interface ReadinessResponse {
    /** Null when no goal is set, which is a normal state rather than an error. */
    goal: { title: string; examDate: string; daysRemaining: number; dailyMinutes: number } | null;
    readiness: Readiness | null;
    /** Band cut-offs, published by the engine so the screen never hard-codes its own. */
    thresholds?: { ready: number; onTrack: number; building: number; masteryTarget: number };
}
