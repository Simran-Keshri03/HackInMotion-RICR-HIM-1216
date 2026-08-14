import { describe, expect, it } from 'vitest';
import {
    DIAGNOSTIC_CONFIG,
    type DiagnosticTopic,
    planDiagnostic,
    summariseDiagnostic,
} from '@/services/assessment/diagnosticEngine.js';

/**
 * The diagnostic's job is to find out *where* a learner is weak, so the property that matters is
 * breadth. A paper that spends itself on one subject is not a worse diagnostic — it is not a diagnostic
 * at all, because the plan it feeds will have nothing to say about every subject it skipped.
 *
 * Most of these tests are therefore about coverage rather than about scoring.
 */

function topic(overrides: Partial<DiagnosticTopic> = {}): DiagnosticTopic {
    return {
        topicId: 't1',
        name: 'Topic',
        subjectId: 's1',
        subjectName: 'Subject',
        subjectWeight: 1,
        availableQuestions: 5,
        ...overrides,
    };
}

/** `count` topics inside one subject. */
function subject(
    subjectId: string,
    name: string,
    weight: number,
    count: number,
    available = 5
): DiagnosticTopic[] {
    return Array.from({ length: count }, (_, i) =>
        topic({
            topicId: `${subjectId}-t${i}`,
            name: `${name} topic ${i}`,
            subjectId,
            subjectName: name,
            subjectWeight: weight,
            availableQuestions: available,
        })
    );
}

describe('planDiagnostic — breadth is the whole point', () => {
    const syllabus = [
        ...subject('s1', 'Algorithms', 1.5, 8),
        ...subject('s2', 'Digital Logic', 1.0, 6),
        ...subject('s3', 'Databases', 1.2, 5),
        ...subject('s4', 'Aptitude', 0.8, 4),
    ];

    it('never asks two questions on the same topic', () => {
        // Depth is what practice is for. Two questions on Trees tell you about Trees and nothing about
        // the topic they displaced.
        const plan = planDiagnostic(syllabus, 15);
        const ids = plan.picks.map((pick) => pick.topicId);

        expect(new Set(ids).size).toBe(ids.length);
    });

    it('covers every subject rather than filling up on the deepest one', () => {
        const plan = planDiagnostic(syllabus, 15);
        const covered = new Set(plan.picks.map((pick) => pick.subjectId));

        expect(covered.size).toBe(4);
    });

    it('caps how much of the paper one subject can take', () => {
        // A syllabus with one deep subject and several thin ones would otherwise report nothing about
        // the thin ones — the exact failure a diagnostic exists to prevent.
        const lopsided = [
            ...subject('deep', 'Deep', 1.5, 20),
            ...subject('thin1', 'Thin one', 1.0, 1),
            ...subject('thin2', 'Thin two', 1.0, 1),
        ];

        const plan = planDiagnostic(lopsided, 15);
        const perSubject = new Map<string, number>();

        for (const pick of plan.picks) {
            perSubject.set(pick.subjectId, (perSubject.get(pick.subjectId) ?? 0) + 1);
        }

        expect(perSubject.get('deep')).toBeLessThanOrEqual(DIAGNOSTIC_CONFIG.maxPerSubject);
        expect(perSubject.get('thin1')).toBe(1);
        expect(perSubject.get('thin2')).toBe(1);
    });

    it('measures the heaviest subjects when there are more subjects than questions', () => {
        const many = [
            ...subject('heavy', 'Heavy', 2.0, 3),
            ...subject('mid', 'Middle', 1.2, 3),
            ...subject('light', 'Light', 0.4, 3),
        ];

        // Only room for two questions: they should go to the two subjects that matter most.
        const plan = planDiagnostic(many, 6).picks.slice(0, 2);

        expect(plan.map((pick) => pick.subjectName)).toEqual(['Heavy', 'Middle']);
    });

    it('spreads across subjects before doubling up on any', () => {
        const plan = planDiagnostic(syllabus, 15);
        const firstFour = plan.picks.slice(0, 4).map((pick) => pick.subjectId);

        // One pass over the subjects before anybody gets a second question.
        expect(new Set(firstFour).size).toBe(4);
    });

    it('numbers the questions from one, in order', () => {
        const plan = planDiagnostic(syllabus, 12);

        expect(plan.picks.map((pick) => pick.position)).toEqual(plan.picks.map((_, i) => i + 1));
    });

    it('skips topics with no questions and names the subjects it could not assess', () => {
        const withEmpty = [
            ...subject('s1', 'Algorithms', 1.5, 4),
            ...subject('empty', 'Compiler Design', 1.0, 3, 0),
        ];

        const plan = planDiagnostic(withEmpty, 12);

        expect(plan.picks.every((pick) => pick.subjectId === 's1')).toBe(true);
        expect(plan.uncovered).toHaveLength(1);
        expect(plan.uncovered[0]!.subjectName).toBe('Compiler Design');
        expect(plan.uncovered[0]!.reason).toMatch(/no questions/i);
    });

    it('returns a shorter paper rather than a padded one', () => {
        const thin = subject('s1', 'Only', 1.0, 3);

        // Three topics, one question each, cap of one per topic. Fifteen is not available and pretending
        // otherwise would mean asking a topic twice.
        expect(planDiagnostic(thin, 15).picks).toHaveLength(3);
    });

    it('clamps a silly requested length', () => {
        expect(planDiagnostic(syllabus, 500).picks.length).toBeLessThanOrEqual(
            DIAGNOSTIC_CONFIG.maxQuestions
        );
    });

    it('returns nothing to sit when nothing can be measured', () => {
        expect(planDiagnostic([], 15).picks).toEqual([]);
        expect(planDiagnostic(subject('s1', 'Empty', 1, 3, 0), 15).picks).toEqual([]);
    });

    it('reports how many questions each subject got', () => {
        const plan = planDiagnostic(syllabus, 12);
        const total = plan.coverage.reduce((sum, c) => sum + c.questionCount, 0);

        expect(total).toBe(plan.picks.length);
        expect(plan.coverage.every((c) => c.subjectName.length > 0)).toBe(true);
    });
});

describe('summariseDiagnostic', () => {
    const answer = (
        subjectId: string,
        subjectName: string,
        isCorrect: boolean,
        answered = true
    ) => ({ topicId: `${subjectId}-t`, subjectId, subjectName, isCorrect, answered });

    it('bands a subject rather than reporting a false precision', () => {
        // Two to four questions per subject cannot support "63%". A learner reading a precise number
        // treats it as a verdict instead of a starting point.
        const result = summariseDiagnostic([
            answer('s1', 'Strong', true),
            answer('s1', 'Strong', true),
            answer('s1', 'Strong', true),
            answer('s1', 'Strong', true),
            answer('s2', 'Weak', false),
            answer('s2', 'Weak', false),
            answer('s2', 'Weak', false),
            answer('s2', 'Weak', true),
        ]);

        const byName = new Map(result.subjects.map((s) => [s.subjectName, s]));

        expect(byName.get('Strong')!.level).toBe('strong');
        expect(byName.get('Weak')!.level).toBe('weak');
    });

    it('puts the weakest subject first, because that is where the plan starts', () => {
        const result = summariseDiagnostic([
            answer('s1', 'Good', true),
            answer('s1', 'Good', true),
            answer('s2', 'Bad', false),
            answer('s2', 'Bad', false),
            answer('s3', 'Middling', true),
            answer('s3', 'Middling', false),
        ]);

        expect(result.subjects.map((s) => s.subjectName)).toEqual(['Bad', 'Middling', 'Good']);
    });

    it('names the weak subjects in the verdict, tied to what happens next', () => {
        const result = summariseDiagnostic([
            answer('s1', 'Digital Logic', false),
            answer('s1', 'Digital Logic', false),
            answer('s2', 'Algorithms', true),
            answer('s2', 'Algorithms', true),
        ]);

        expect(result.verdict).toContain('Digital Logic');
        // A result screen that does not connect to the plan is a score with nowhere to go.
        expect(result.verdict).toMatch(/plan/i);
    });

    it('scores a skipped question as wrong but says so separately', () => {
        const result = summariseDiagnostic([
            answer('s1', 'S', true),
            answer('s1', 'S', false, false),
            answer('s1', 'S', false, false),
        ]);

        // If blank raised the score, the winning strategy would be answering only what you are sure of.
        expect(result.accuracyPercent).toBeCloseTo(33.3, 1);
        expect(result.answeredCount).toBe(1);
        expect(result.verdict).toMatch(/blank/i);
    });

    it('does not read a half-finished paper as a measurement', () => {
        const result = summariseDiagnostic([
            answer('s1', 'S', false, false),
            answer('s1', 'S', false, false),
        ]);

        expect(result.verdict).toMatch(/nothing was answered/i);
    });

    it('says so when everything measured looks solid', () => {
        const result = summariseDiagnostic([
            answer('s1', 'A', true),
            answer('s1', 'A', true),
            answer('s2', 'B', true),
            answer('s2', 'B', true),
        ]);

        expect(result.subjects.every((s) => s.level === 'strong')).toBe(true);
        expect(result.verdict).toMatch(/already know|keep it that way/i);
    });

    it('handles an empty paper without inventing a result', () => {
        const result = summariseDiagnostic([]);

        expect(result.totalQuestions).toBe(0);
        expect(result.subjects).toEqual([]);
        expect(result.accuracyPercent).toBe(0);
    });
});
