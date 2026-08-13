import { describe, expect, it } from 'vitest';
import {
    type CurriculumReply,
    toSlug,
    validateCurriculumReply,
} from '@/services/learning/curriculumValidator.js';

/**
 * The safety net on AI-written syllabi. Every case here is something a model plausibly returns:
 * a shape that is fine but a syllabus that is not.
 */

function reply(overrides: Partial<CurriculumReply> = {}): CurriculumReply {
    return {
        isStudyGoal: true,
        reason: '',
        name: 'Class 10 (CBSE)',
        slug: 'class-10-cbse',
        description: 'The CBSE class 10 syllabus.',
        subjects: [
            {
                name: 'Mathematics',
                weight: 1.5,
                topics: ['Real Numbers', 'Quadratic Equations', 'Trigonometry'],
            },
            {
                name: 'Science',
                weight: 1.5,
                topics: ['Chemical Reactions', 'Light', 'Life Processes'],
            },
        ],
        ...overrides,
    };
}

describe('toSlug', () => {
    it('normalises the variations of one goal to a single key', () => {
        // The point of the slug: these must all hit the same stored syllabus rather than
        // generating three copies of it.
        expect(toSlug('class 10')).toBe('class-10');
        expect(toSlug('Class 10')).toBe('class-10');
        expect(toSlug('  CLASS   10  ')).toBe('class-10');
    });

    it('strips punctuation and accents', () => {
        expect(toSlug('12th Physics!')).toBe('12th-physics');
        expect(toSlug('Mathématiques')).toBe('mathematiques');
    });

    it('never produces a slug the database would reject', () => {
        // The column requires ^[a-z0-9][a-z0-9-]{1,79}$.
        for (const input of ['---', '!!!', 'GATE — CSE', 'a'.repeat(200)]) {
            const slug = toSlug(input);
            if (slug.length >= 2) {
                expect(slug).toMatch(/^[a-z0-9][a-z0-9-]{1,79}$/);
            }
        }
    });

    it('returns empty for text with nothing usable in it', () => {
        expect(toSlug('!!!')).toBe('');
        expect(toSlug('   ')).toBe('');
    });
});

describe('validateCurriculumReply — rejects what is not a study goal', () => {
    it('rejects the model saying no, and passes its reason to the learner', () => {
        const result = validateCurriculumReply(
            reply({
                isStudyGoal: false,
                reason: 'A dog is an animal, not a subject.',
                name: '',
                slug: '',
                subjects: [],
            }),
            'dog'
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.learnerMessage).toMatch(/not look like something to study/i);
            expect(result.learnerMessage).toContain('A dog is an animal');
        }
    });

    it('still says something useful when the model gives no reason', () => {
        const result = validateCurriculumReply(
            reply({ isStudyGoal: false, reason: '', name: '', slug: '', subjects: [] }),
            'apple'
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
            // Suggests what a valid goal looks like rather than only refusing.
            expect(result.learnerMessage).toContain('apple');
            expect(result.learnerMessage).toMatch(/class 10|GATE|python/i);
        }
    });

    it('rejects a reply that is not the shape we asked for', () => {
        expect(validateCurriculumReply({ isStudyGoal: 'yes' }, 'x').ok).toBe(false);
        expect(validateCurriculumReply('sorry, I cannot', 'x').ok).toBe(false);
        expect(validateCurriculumReply(null, 'x').ok).toBe(false);
    });
});

describe('validateCurriculumReply — accepts and normalises a good syllabus', () => {
    it('accepts a realistic syllabus', () => {
        const result = validateCurriculumReply(reply(), 'class 10');

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.curriculum.name).toBe('Class 10 (CBSE)');
            expect(result.curriculum.slug).toBe('class-10-cbse');
            expect(result.curriculum.subjects).toHaveLength(2);
        }
    });

    it('regenerates the slug rather than trusting the model to make a valid one', () => {
        const result = validateCurriculumReply(
            reply({ slug: 'Class 10 !! CBSE' }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.curriculum.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,79}$/);
        }
    });

    it('falls back to the learner text when the model returns no usable slug', () => {
        const result = validateCurriculumReply(
            reply({ slug: '', name: 'Class 10' }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.curriculum.slug).toBe('class-10');
    });

    it('collapses whitespace in names instead of storing it', () => {
        const result = validateCurriculumReply(
            reply({ name: '  Class   10  \n' }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.curriculum.name).toBe('Class 10');
    });
});

describe('validateCurriculumReply — cleans up what the schema cannot catch', () => {
    it('drops a duplicate subject, which the topics table would reject anyway', () => {
        const result = validateCurriculumReply(
            reply({
                subjects: [
                    { name: 'Maths', weight: 1, topics: ['A one', 'B two'] },
                    { name: 'maths', weight: 1, topics: ['C three', 'D four'] },
                ],
            }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.curriculum.subjects).toHaveLength(1);
    });

    it('drops a repeated topic within a subject', () => {
        const result = validateCurriculumReply(
            reply({
                subjects: [
                    {
                        name: 'Maths',
                        weight: 1,
                        topics: ['Trigonometry', 'trigonometry ', 'Algebra'],
                    },
                ],
            }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.curriculum.subjects[0]?.topics).toHaveLength(2);
    });

    it('drops a subject that has only one topic — that is a topic one level too high', () => {
        const result = validateCurriculumReply(
            reply({
                subjects: [
                    { name: 'Real Subject', weight: 1, topics: ['A one', 'B two'] },
                    { name: 'Stray', weight: 1, topics: ['Only one'] },
                ],
            }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.curriculum.subjects.map((s) => s.name)).toEqual([
                'Real Subject',
            ]);
        }
    });

    it('drops filler names the model produces when it runs out of content', () => {
        const result = validateCurriculumReply(
            reply({
                subjects: [
                    { name: 'Real Subject', weight: 1, topics: ['A one', 'B two'] },
                    { name: 'Subject 2', weight: 1, topics: ['C three', 'D four'] },
                ],
            }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.curriculum.subjects).toHaveLength(1);
    });

    it('drops a name that is really the model talking to us', () => {
        const result = validateCurriculumReply(
            reply({
                subjects: [
                    { name: 'Real Subject', weight: 1, topics: ['A one', 'B two'] },
                    {
                        name: "Sorry, I cannot build a syllabus for that request.",
                        weight: 1,
                        topics: ['C three', 'D four'],
                    },
                ],
            }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) expect(result.curriculum.subjects).toHaveLength(1);
    });

    it('clamps a nonsense weight rather than throwing the syllabus away', () => {
        // A loose number is the model being sloppy about one field, not evidence the whole
        // syllabus is wrong.
        const result = validateCurriculumReply(
            reply({
                subjects: [
                    { name: 'Huge', weight: 900, topics: ['A one', 'B two'] },
                    { name: 'Tiny', weight: -5, topics: ['C three', 'D four'] },
                    { name: 'Missing', weight: Number.NaN, topics: ['E five', 'F six'] },
                ],
            }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.curriculum.subjects.map((s) => s.weight)).toEqual([3, 0.5, 1]);
        }
    });

    it('caps a runaway syllabus instead of storing hundreds of topics', () => {
        const result = validateCurriculumReply(
            reply({
                subjects: Array.from({ length: 20 }, (_, s) => ({
                    name: `Subject named ${String.fromCharCode(65 + s)}`,
                    weight: 1,
                    topics: Array.from({ length: 30 }, (_, t) => `Topic ${s}-${t}`),
                })),
            }),
            'class 10'
        );

        expect(result.ok).toBe(true);
        if (result.ok) {
            const total = result.curriculum.subjects.reduce(
                (n, s) => n + s.topics.length,
                0
            );
            expect(result.curriculum.subjects.length).toBeLessThanOrEqual(12);
            expect(total).toBeLessThanOrEqual(90);
            for (const subject of result.curriculum.subjects) {
                expect(subject.topics.length).toBeLessThanOrEqual(15);
            }
        }
    });

    it('rejects the whole thing when no subject survives', () => {
        const result = validateCurriculumReply(
            reply({
                subjects: [
                    { name: 'Subject 1', weight: 1, topics: ['A one', 'B two'] },
                    // Too short to be a subject name, and only one topic — both dropped
                    // by the business rules rather than failing the whole parse.
                    { name: 'x', weight: 1, topics: ['C three'] },
                ],
            }),
            'class 10'
        );

        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.learnerMessage).toMatch(/more specific/i);
    });
});
