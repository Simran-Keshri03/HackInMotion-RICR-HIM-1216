import { z } from 'zod';

/**
 * Where the AI's answer about a study goal stops being an answer and becomes a syllabus.
 *
 * Two gates, as everywhere else AI output is used: the schema check proves the reply has the
 * right shape, and the business check proves it is a usable syllabus. The second one matters
 * more. A reply can satisfy the schema perfectly and still be unusable — one subject containing
 * forty topics, the same topic listed twice, a subject called "Subject 1", a name that is
 * actually a sentence back at us, a weight of 900. None of that is malformed JSON, and all of it
 * would be visible to a learner if only the shape were checked.
 *
 * Nothing here calls the model or the database, so every rule is cheap to unit test.
 */

/**
 * Strict about structure, deliberately loose about contents.
 *
 * Contents are checked by the business rules below, which trim and drop what they cannot use. If
 * the schema enforced them instead, one sloppy field — a one-letter subject name, a weight of NaN,
 * a reason two sentences longer than expected — would fail the parse and throw away an otherwise
 * good reply. Validate the shape here; clean the contents there.
 *
 * That is not a stylistic preference. A tight cap on `reason` turned a correct rejection into a
 * fault: asked about "apple" the model answered, at length, that an apple is not something you
 * study; the reply overflowed the cap, the parse failed, and the learner was told "something went
 * wrong" instead of being told their goal was not valid. The feature looked broken while working
 * perfectly. The lengths below are generous bounds against a pathological reply, not judgements
 * about what a good one looks like — the reply is already bounded by the request's token limit.
 */
export const curriculumReplySchema = z.object({
    isStudyGoal: z.boolean(),
    reason: z.string().max(4000),
    name: z.string().max(2000),
    slug: z.string().max(2000),
    description: z.string().max(20_000),
    subjects: z
        .array(
            z.object({
                name: z.string().max(2000),
                // Not z.number(): that rejects NaN, and a model being loose about one number is
                // not a reason to discard the syllabus. Clamped below instead.
                weight: z.unknown(),
                topics: z.array(z.string().max(2000)).max(400),
            })
        )
        .max(200),
});

/** Longest description worth storing. Past this it is prose, not a summary. */
const MAX_DESCRIPTION = 2000;

/** How much of the model's reason to show a learner. Long enough to be a reason, not a lecture. */
const MAX_SHOWN_REASON = 240;

export type CurriculumReply = z.infer<typeof curriculumReplySchema>;

/** Limits chosen so a syllabus is big enough to be real and small enough to be plannable. */
export const CURRICULUM_LIMITS = {
    minSubjects: 1,
    maxSubjects: 12,
    minTopicsPerSubject: 2,
    maxTopicsPerSubject: 15,
    /** Beyond this a day-by-day plan spreads too thin to mean anything. */
    maxTotalTopics: 90,
    minWeight: 0.5,
    maxWeight: 3,
} as const;

export interface ResolvedCurriculum {
    slug: string;
    name: string;
    description: string;
    subjects: { name: string; weight: number; topics: string[] }[];
}

export type CurriculumOutcome =
    | { ok: true; curriculum: ResolvedCurriculum }
    /** `learnerMessage` is shown to the learner; `logDetail` explains it to us. */
    | { ok: false; learnerMessage: string; logDetail: string };

/**
 * Turns free text into a lookup key.
 *
 * Exported and used on the way in as well as on the way out: the incoming goal text is slugged
 * to check whether this syllabus already exists, which means a repeated goal costs nothing and
 * two learners typing the same thing share one syllabus.
 */
export function toSlug(text: string): string {
    return text
        .toLowerCase()
        .normalize('NFKD')
        // Drop accents, so "mathématiques" and "mathematiques" are one key.
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80)
        .replace(/-+$/g, '');
}

/** Trims, collapses runs of whitespace, and strips characters a syllabus label never needs. */
function tidy(text: string): string {
    return text
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Truncate at a word boundary, or at a sentence end if one falls close enough to the limit.
 *
 * Cutting mid-word reads as a bug to the person reading it, which matters most where this is used:
 * the text explaining why their goal was refused.
 */
function shorten(text: string, limit: number): string {
    if (text.length <= limit) return text;

    const cut = text.slice(0, limit);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));

    if (sentenceEnd > limit * 0.5) return cut.slice(0, sentenceEnd + 1);

    const lastSpace = cut.lastIndexOf(' ');
    return `${lastSpace > limit * 0.5 ? cut.slice(0, lastSpace) : cut.trimEnd()}…`;
}

/**
 * A name that is really a sentence, an instruction, or the model talking to us rather than
 * labelling a subject. Cheap heuristics, applied only to short label fields.
 */
function looksLikeProse(name: string): boolean {
    return (
        name.length > 60 ||
        /[.!?;:]{1}\s|["'`]|\b(sorry|cannot|as an ai|here is|i have|note that)\b/i.test(
            name
        ) ||
        // "Subject 1", "Topic 3" — filler the model produces when it has run out of real content.
        /^(subject|topic|chapter|unit)\s*\d+$/i.test(name)
    );
}

/**
 * Validates a reply and normalises it into something insertable.
 *
 * Returns the learner-facing message rather than throwing, because "that is not a study goal" is
 * a normal outcome of this endpoint and not an error.
 */
export function validateCurriculumReply(
    raw: unknown,
    originalGoalText: string
): CurriculumOutcome {
    const parsed = curriculumReplySchema.safeParse(raw);

    if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
            ok: false,
            learnerMessage:
                'Something went wrong working out that goal. Try rewording it.',
            logDetail: `reply failed the schema: ${
                issue ? `${issue.path.join('.')} ${issue.message}` : 'unknown'
            }`,
        };
    }

    const reply = parsed.data;

    // The model's own verdict comes first: it saw the text and we did not.
    if (!reply.isStudyGoal) {
        const detail = shorten(tidy(reply.reason), MAX_SHOWN_REASON);

        return {
            ok: false,
            learnerMessage: detail
                ? `That does not look like something to study. ${detail}`
                : `"${tidy(originalGoalText).slice(0, 60)}" does not look like something to study. Try an exam, a class, or a subject — for example "class 10", "GATE CSE", or "learn python".`,
            logDetail: `model rejected the goal: ${detail || 'no reason given'}`,
        };
    }

    const name = tidy(reply.name);
    const description = shorten(tidy(reply.description), MAX_DESCRIPTION);

    if (name.length < 2 || looksLikeProse(name)) {
        return {
            ok: false,
            learnerMessage:
                'Could not work out a clear syllabus for that. Try naming the exam or class directly.',
            logDetail: `curriculum name unusable: ${JSON.stringify(reply.name)}`,
        };
    }

    // The model's slug is a suggestion; ours is the one that has to satisfy the database's shape
    // constraint, so it is regenerated rather than trusted. Falling back to the learner's text
    // keeps a key even when the model returns a slug we cannot use.
    const slug = toSlug(reply.slug) || toSlug(name) || toSlug(originalGoalText);

    if (slug.length < 2) {
        return {
            ok: false,
            learnerMessage: 'Could not work out a syllabus for that. Try rewording it.',
            logDetail: `no usable slug from ${JSON.stringify(reply.slug)}`,
        };
    }

    const limits = CURRICULUM_LIMITS;
    const subjects: ResolvedCurriculum['subjects'] = [];
    const seenSubjects = new Set<string>();
    let totalTopics = 0;

    for (const subject of reply.subjects) {
        const subjectName = tidy(subject.name);

        if (subjectName.length < 2 || looksLikeProse(subjectName)) continue;

        // Two subjects with the same name would violate the topics table's uniqueness constraint,
        // and mean nothing to a learner either.
        const key = subjectName.toLowerCase();
        if (seenSubjects.has(key)) continue;

        const seenTopics = new Set<string>();
        const topics: string[] = [];

        for (const rawTopic of subject.topics) {
            const topic = tidy(rawTopic);
            if (topic.length < 2 || looksLikeProse(topic)) continue;

            const topicKey = topic.toLowerCase();
            if (seenTopics.has(topicKey)) continue;

            seenTopics.add(topicKey);
            topics.push(topic);

            if (topics.length >= limits.maxTopicsPerSubject) break;
        }

        // A subject with one topic is not a subject; it is a topic that ended up a level too high.
        if (topics.length < limits.minTopicsPerSubject) continue;

        if (totalTopics + topics.length > limits.maxTotalTopics) break;

        seenSubjects.add(key);
        totalTopics += topics.length;

        subjects.push({
            name: subjectName,
            // Clamped rather than rejected: a weight outside the range is the model being loose
            // about a number, not evidence the whole syllabus is wrong.
            // Number(undefined) and Number('abc') are both NaN, and NaN fails every comparison,
            // so the `|| 1` fallback catches a missing or unparseable weight as well as zero.
            weight: Math.min(
                limits.maxWeight,
                Math.max(limits.minWeight, Number(subject.weight) || 1)
            ),
            topics,
        });

        if (subjects.length >= limits.maxSubjects) break;
    }

    if (subjects.length < limits.minSubjects) {
        return {
            ok: false,
            learnerMessage:
                'Could not build a usable syllabus for that. Try being more specific — for example "class 10 science" rather than "science".',
            logDetail: `no subject survived validation (model returned ${reply.subjects.length})`,
        };
    }

    return {
        ok: true,
        curriculum: {
            slug,
            name,
            description: description.slice(0, 500),
            subjects,
        },
    };
}
