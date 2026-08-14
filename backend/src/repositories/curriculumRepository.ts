import type { SupabaseClient } from '@supabase/supabase-js';
import type { ResolvedCurriculum } from '@/services/learning/curriculumValidator.js';

export interface CurriculumRow {
    id: string;
    slug: string;
    name: string;
    description: string | null;
    is_ai_generated: boolean;
}

export interface SubjectRow {
    id: string;
    name: string;
    weight: number;
    topicCount: number;
}

/**
 * Curricula and their subject trees.
 *
 * Reads work with either client; writes need the elevated one, because `curricula` and `topics`
 * grant SELECT to learners and nothing else. A syllabus is only ever written after the goal text
 * has been validated and the AI reply has passed both gates, and routing that through the API is
 * what makes those checks unskippable.
 */
export class CurriculumRepository {
    private readonly db: SupabaseClient;

    constructor(db: SupabaseClient) {
        this.db = db;
    }

    async findBySlug(slug: string): Promise<CurriculumRow | null> {
        const { data, error } = await this.db
            .from('curricula')
            .select('id, slug, name, description, is_ai_generated')
            .eq('slug', slug)
            .maybeSingle();

        if (error) throw error;
        return data as CurriculumRow | null;
    }

    async findById(id: string): Promise<CurriculumRow | null> {
        const { data, error } = await this.db
            .from('curricula')
            .select('id, slug, name, description, is_ai_generated')
            .eq('id', id)
            .maybeSingle();

        if (error) throw error;
        return data as CurriculumRow | null;
    }

    /** The default syllabus, used when a learner has no goal yet. */
    async findDefault(): Promise<CurriculumRow | null> {
        return this.findBySlug('computer-science-fundamentals');
    }

    /** Subjects of one curriculum, each with how many topics it holds. */
    async findSubjects(curriculumId: string): Promise<SubjectRow[]> {
        const { data, error } = await this.db
            .from('topics')
            .select('id, name, weight, parent_id')
            .eq('curriculum_id', curriculumId)
            .order('sort_order');

        if (error) throw error;

        const rows = (data ?? []) as {
            id: string;
            name: string;
            weight: number;
            parent_id: string | null;
        }[];

        const childCount = new Map<string, number>();
        for (const row of rows) {
            if (row.parent_id) {
                childCount.set(row.parent_id, (childCount.get(row.parent_id) ?? 0) + 1);
            }
        }

        return rows
            .filter((row) => row.parent_id === null)
            .map((row) => ({
                id: row.id,
                name: row.name,
                weight: Number(row.weight),
                topicCount: childCount.get(row.id) ?? 0,
            }));
    }

    /**
     * Writes a validated syllabus: the curriculum, then its subjects, then their topics.
     *
     * Three round trips rather than one transaction, because Supabase's HTTP client has no
     * transaction. The failure that matters — a curriculum row with no topics under it — is
     * handled by the caller re-resolving the slug, and `insert` on a subject that already exists
     * is refused by the uniqueness constraint rather than duplicated.
     *
     * ponytail: a partially written syllabus after a mid-insert failure stays in the table. Move
     * this into a SQL function if it ever happens in practice; a wasted row is cheaper than a
     * stored procedure nobody can read.
     */
    async create(curriculum: ResolvedCurriculum): Promise<CurriculumRow> {
        const { data: created, error } = await this.db
            .from('curricula')
            .insert({
                slug: curriculum.slug,
                name: curriculum.name,
                description: curriculum.description || null,
                is_ai_generated: true,
            })
            .select('id, slug, name, description, is_ai_generated')
            .single();

        if (error) throw error;

        const row = created as CurriculumRow;

        // sort_order carries the order the model returned, which is the order a syllabus is
        // taught in. Losing it would make "learn the next new concept" alphabetical.
        const { data: subjects, error: subjectError } = await this.db
            .from('topics')
            .insert(
                curriculum.subjects.map((subject, index) => ({
                    curriculum_id: row.id,
                    parent_id: null,
                    name: subject.name,
                    weight: subject.weight,
                    sort_order: index + 1,
                }))
            )
            .select('id, name');

        if (subjectError) throw subjectError;

        const subjectIdByName = new Map(
            ((subjects ?? []) as { id: string; name: string }[]).map((s) => [s.name, s.id])
        );

        const topicRows = curriculum.subjects.flatMap((subject) => {
            const parentId = subjectIdByName.get(subject.name);
            if (!parentId) return [];

            return subject.topics.map((topic, index) => ({
                curriculum_id: row.id,
                parent_id: parentId,
                name: topic,
                // Topics inherit their subject's weight: the model weighted subjects, and a topic
                // is only as important as the subject it belongs to until evidence says otherwise.
                weight: subject.weight,
                sort_order: index + 1,
            }));
        });

        if (topicRows.length > 0) {
            const { error: topicError } = await this.db.from('topics').insert(topicRows);

            if (topicError) throw topicError;
        }

        return row;
    }
}
