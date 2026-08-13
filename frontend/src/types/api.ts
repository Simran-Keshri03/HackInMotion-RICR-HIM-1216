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

export interface Goal {
    id: string;
    title: string;
    /** YYYY-MM-DD. */
    examDate: string;
    dailyMinutes: number;
    subjectIds: string[];
    /** Whole days from today. */
    daysRemaining: number;
    /** dailyMinutes x daysRemaining — the budget the planner divides work by. */
    totalMinutesAvailable: number;
}
