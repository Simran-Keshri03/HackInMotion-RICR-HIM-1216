import type { CurriculumRepository, SubjectRow } from '@/repositories/curriculumRepository.js';
import { CURRICULUM_SCHEMA, CURRICULUM_SYSTEM, curriculumPrompt } from '@/services/ai/prompts.js';
import type { IAIProvider } from '@/services/ai/IAIProvider.js';
import { toSlug, validateCurriculumReply } from '@/services/learning/curriculumValidator.js';
import { AppError } from '@/utils/http.js';

export interface ResolveOutcome {
    /** cached: already stored, no AI call and no cost. */
    status: 'cached' | 'created' | 'rejected';
    curriculum?: {
        id: string;
        slug: string;
        name: string;
        description: string | null;
        isAiGenerated: boolean;
    };
    subjects?: SubjectRow[];
    /** Present when rejected: what to show the learner. */
    message?: string;
}

/** Long enough for "class 12 physics and chemistry", short enough to bound the prompt. */
const MAX_GOAL_TEXT = 120;

/**
 * Turns what a learner typed into a syllabus they can study.
 *
 *   "class 10"   -> the class 10 syllabus, subjects and topics
 *   "dog"        -> rejected, with a message explaining why
 *
 * Order of operations, and each step is there for a reason:
 *
 * 1. Slug the text and look it up. A repeated goal costs nothing, and two learners typing the
 *    same thing share one syllabus, so the question bank accumulates against it instead of being
 *    split across near-identical copies.
 * 2. Ask the model to both judge and build in one call. Two calls would double the cost for no
 *    extra safety: deciding "is this studiable" and "what is its syllabus" are the same
 *    judgement.
 * 3. Validate the reply — shape, then business rules. The model is the only thing that can read
 *    free text, and the validator is the only thing that decides what gets stored.
 * 4. Store, then re-resolve by slug so a race between two learners typing the same goal ends with
 *    both using the row that won rather than one of them failing.
 */
export class CurriculumService {
    private readonly ai: IAIProvider;
    private readonly curricula: CurriculumRepository;

    constructor(ai: IAIProvider, curricula: CurriculumRepository) {
        this.ai = ai;
        this.curricula = curricula;
    }

    /** Subjects for a curriculum the learner already has. */
    async getSubjects(curriculumId: string): Promise<SubjectRow[]> {
        return this.curricula.findSubjects(curriculumId);
    }

    /** The syllabus offered before a learner has set any goal. */
    async getDefault(): Promise<ResolveOutcome> {
        const curriculum = await this.curricula.findDefault();

        if (!curriculum) {
            throw new AppError(500, 'NO_DEFAULT_CURRICULUM', 'No default syllabus is available.');
        }

        return {
            status: 'cached',
            curriculum: this.toView(curriculum),
            subjects: await this.curricula.findSubjects(curriculum.id),
        };
    }

    async resolve(rawGoalText: string): Promise<ResolveOutcome> {
        const goalText = rawGoalText.trim().slice(0, MAX_GOAL_TEXT);

        if (goalText.length < 2) {
            return {
                status: 'rejected',
                message: 'Type what you are studying for — an exam, a class, or a subject.',
            };
        }

        // Step 1: free lookup before any paid call.
        const directSlug = toSlug(goalText);

        if (directSlug.length >= 2) {
            const existing = await this.curricula.findBySlug(directSlug);

            if (existing) {
                return {
                    status: 'cached',
                    curriculum: this.toView(existing),
                    subjects: await this.curricula.findSubjects(existing.id),
                };
            }
        }

        // Step 2: one call that judges and builds.
        const reply = await this.ai.generateJson({
            system: CURRICULUM_SYSTEM,
            prompt: curriculumPrompt(goalText),
            schema: CURRICULUM_SCHEMA,
            maxTokens: 6000,
        });

        // Step 3: the validator decides, not the model.
        const outcome = validateCurriculumReply(reply.data, goalText);

        if (!outcome.ok) {
            // Logged so a pattern of rejections can be reviewed without storing what learners
            // typed anywhere permanent.
            console.warn(
                `curriculum rejected for ${JSON.stringify(goalText)}: ${outcome.logDetail}`
            );

            return { status: 'rejected', message: outcome.learnerMessage };
        }

        // The model's normalised slug can differ from the learner's phrasing — "10th class" and
        // "class 10" both become "class-10" — so check again before writing.
        const settled = await this.curricula.findBySlug(outcome.curriculum.slug);

        if (settled) {
            return {
                status: 'cached',
                curriculum: this.toView(settled),
                subjects: await this.curricula.findSubjects(settled.id),
            };
        }

        // Step 4: store, then re-resolve so a concurrent writer does not turn into an error.
        try {
            const created = await this.curricula.create(outcome.curriculum);

            return {
                status: 'created',
                curriculum: this.toView(created),
                subjects: await this.curricula.findSubjects(created.id),
            };
        } catch (error) {
            const raced = await this.curricula.findBySlug(outcome.curriculum.slug);

            if (raced) {
                return {
                    status: 'cached',
                    curriculum: this.toView(raced),
                    subjects: await this.curricula.findSubjects(raced.id),
                };
            }

            throw error;
        }
    }

    private toView(row: {
        id: string;
        slug: string;
        name: string;
        description: string | null;
        is_ai_generated: boolean;
    }) {
        return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            description: row.description,
            isAiGenerated: row.is_ai_generated,
        };
    }
}
