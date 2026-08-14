/**
 * Exam readiness: one number, and the arithmetic behind it.
 *
 * The number is the easy part. The reason this is a pure function with a published breakdown is that
 * a readiness score nobody can interrogate is a horoscope — a learner told "you are 61% ready" three
 * weeks before an exam will either ignore it or panic at it, and neither is useful. So every
 * component is returned alongside the total, with the weight it carried and a sentence naming what
 * would move it.
 *
 * No model is called. Dividing exam weight by measured mastery is arithmetic, and arithmetic that a
 * learner can check by hand is worth more here than a fluent paragraph they cannot.
 */

/** A topic in the goal's scope, with what the learner has demonstrated on it. */
export interface ReadinessTopic {
    topicId: string;
    name: string;
    subjectName: string | null;
    /** Exam importance from the syllabus. Higher means more of the paper. */
    weight: number;
    /** 0-100, or null for a topic never attempted. */
    masteryScore: number | null;
    attempts: number;
}

/** A mock test that was actually finished. Open tests tell us nothing yet. */
export interface ReadinessMock {
    scorePercent: number;
    submittedAt: string;
}

export interface ReadinessInput {
    topics: ReadinessTopic[];
    mocks: ReadinessMock[];
    /** Whole days from today to the exam. Zero or negative means the exam is here. */
    daysRemaining: number;
    dailyMinutes: number;
}

export type ReadinessBand = 'not_ready' | 'building' | 'on_track' | 'ready';

/** How much the score should be trusted, which is a different question from what it is. */
export type ReadinessConfidence = 'low' | 'medium' | 'high';

export interface ReadinessComponent {
    key: 'mastery' | 'coverage' | 'mock' | 'time';
    label: string;
    /** 0-100. */
    score: number;
    /** Share of the total this component actually carried, after any omissions. */
    weight: number;
    detail: string;
}

/** A topic costing the most readiness: heavy on the paper and far from mastered. */
export interface ReadinessGap {
    topicId: string;
    name: string;
    subjectName: string | null;
    masteryScore: number | null;
    /** Weight × distance from target. The ranking key, exposed so the order is checkable. */
    cost: number;
}

export interface ReadinessResult {
    /** 0-100. */
    score: number;
    band: ReadinessBand;
    confidence: ReadinessConfidence;
    /** One sentence a learner can act on. */
    verdict: string;
    components: ReadinessComponent[];
    /**
     * Topics answered and still short of the target, worst first. Measured, so this is evidence.
     * At most `maxGaps`.
     */
    gaps: ReadinessGap[];
    /**
     * Heaviest topics not attempted at all. Kept apart from `gaps` because their cost assumes a
     * mastery of zero rather than measuring one. At most `maxGaps`.
     */
    notStarted: ReadinessGap[];
    daysRemaining: number;
    topicsInScope: number;
    topicsAttempted: number;
    topicsMastered: number;
    mocksTaken: number;
}

export const READINESS_CONFIG = {
    /**
     * Mastery carries the most because it is the only component measured question by question.
     * Coverage is deliberately smaller than mastery: having touched every topic once is a much
     * weaker claim than having got them right, and a coverage-heavy score would let a learner feel
     * ready for skimming the syllabus.
     */
    weights: { mastery: 0.45, coverage: 0.2, mock: 0.25, time: 0.1 },

    /** The mastery a topic is treated as finished at. Matches the planner's own target. */
    masteryTarget: 85,

    /** Band thresholds on the final score. */
    readyAt: 75,
    onTrackAt: 55,
    buildingAt: 30,

    /** Only the most recent few mocks count — a paper from six weeks ago is not current form. */
    mockLookback: 3,

    /** Rough minutes to move one weighted mastery point. Only the time component uses this. */
    minutesPerMasteryPoint: 1.2,

    /** Below this many attempts in total, the score is a first impression rather than a measurement. */
    thinEvidenceAttempts: 25,
    /** At or above this, and with a mock sat, the score has enough behind it to lean on. */
    solidEvidenceAttempts: 120,

    maxGaps: 5,
} as const;

function clamp(value: number, min = 0, max = 100): number {
    return Math.max(min, Math.min(max, value));
}

function round(value: number, places = 1): number {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

/**
 * A never-attempted topic scores zero here, and that is the opposite of what the planner does.
 *
 * The planner gives an unmeasured topic a neutral prior, because its question is "where should the
 * next hour go" and treating unknown as hopeless would send every hour to topics that might already
 * be fine. Readiness asks a different question — "what has this learner been shown to be able to
 * do" — and for that, silence is not evidence. Scoring an untouched syllabus as half-ready is how a
 * dashboard tells somebody they are on track for an exam they have not started studying for.
 */
function masteryOf(topic: ReadinessTopic): number {
    return topic.masteryScore ?? 0;
}

/** Weighted average mastery, expressed against the target rather than against 100. */
function masteryComponent(topics: ReadinessTopic[]): { score: number; detail: string } {
    const totalWeight = topics.reduce((sum, t) => sum + t.weight, 0);

    if (totalWeight === 0) {
        return { score: 0, detail: 'No topics in scope yet.' };
    }

    const weighted = topics.reduce((sum, t) => sum + t.weight * masteryOf(t), 0) / totalWeight;
    // Against the target, not against 100: a paper averaging the target is ready, not 85% ready.
    const score = clamp((weighted / READINESS_CONFIG.masteryTarget) * 100);

    return {
        score,
        detail: `Weighted mastery across the syllabus is ${round(weighted)} against a target of ${
            READINESS_CONFIG.masteryTarget
        }.`,
    };
}

/** Share of the exam, by weight, that has been attempted at all. */
function coverageComponent(topics: ReadinessTopic[]): { score: number; detail: string } {
    const totalWeight = topics.reduce((sum, t) => sum + t.weight, 0);

    if (totalWeight === 0) {
        return { score: 0, detail: 'No topics in scope yet.' };
    }

    const touched = topics.filter((t) => t.attempts > 0);
    const touchedWeight = touched.reduce((sum, t) => sum + t.weight, 0);
    const score = clamp((touchedWeight / totalWeight) * 100);
    const untouched = topics.length - touched.length;

    return {
        score,
        detail:
            untouched === 0
                ? 'Every topic in the syllabus has been attempted.'
                : `${untouched} of ${topics.length} topics have not been attempted yet.`,
    };
}

/** Recent mock form, or null when no paper has been finished. */
function mockComponent(mocks: ReadinessMock[]): { score: number; detail: string } | null {
    if (mocks.length === 0) return null;

    // Most recent first, then the lookback window. Sorting here rather than trusting the caller:
    // the component is meaningless if "recent" is actually "whatever order the database returned".
    const recent = [...mocks]
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
        .slice(0, READINESS_CONFIG.mockLookback);

    const average = recent.reduce((sum, m) => sum + m.scorePercent, 0) / recent.length;

    return {
        score: clamp(average),
        detail:
            recent.length === 1
                ? `One mock test, scored ${round(average)}%.`
                : `Average of the last ${recent.length} mock tests: ${round(average)}%.`,
    };
}

/**
 * Whether the time left is enough to close the remaining gap at the current daily budget.
 *
 * Omitted rather than scored when the exam has arrived or no budget is set — a learner sitting the
 * exam tomorrow is not "0% ready because there is no time left", they are as ready as their answers
 * say they are, and time has stopped being a thing they can change.
 *
 * Also omitted when nothing is in scope. An empty syllabus has a remaining gap of zero, which is
 * arithmetically "nothing left to close" and semantically the opposite — and because time would then
 * be the only surviving component, it scored a learner with no goal at all as fully ready.
 */
function timeComponent(
    topics: ReadinessTopic[],
    daysRemaining: number,
    dailyMinutes: number
): { score: number; detail: string } | null {
    if (topics.length === 0) return null;
    if (daysRemaining <= 0 || dailyMinutes <= 0) return null;

    const gap = topics.reduce(
        (sum, t) => sum + t.weight * Math.max(0, READINESS_CONFIG.masteryTarget - masteryOf(t)),
        0
    );

    const availableMinutes = daysRemaining * dailyMinutes;

    // Nothing left to close: time is not a constraint, so it should not drag the score down.
    if (gap === 0) {
        return { score: 100, detail: 'Every topic is already at the target.' };
    }

    const neededMinutes = gap * READINESS_CONFIG.minutesPerMasteryPoint;
    const score = clamp((availableMinutes / neededMinutes) * 100);
    const neededHours = Math.round(neededMinutes / 60);
    const availableHours = Math.round(availableMinutes / 60);

    return {
        score,
        detail: `Closing the remaining gap needs roughly ${neededHours}h; ${daysRemaining} days at ${dailyMinutes} min gives about ${availableHours}h.`,
    };
}

function bandFor(score: number): ReadinessBand {
    if (score >= READINESS_CONFIG.readyAt) return 'ready';
    if (score >= READINESS_CONFIG.onTrackAt) return 'on_track';
    if (score >= READINESS_CONFIG.buildingAt) return 'building';
    return 'not_ready';
}

function confidenceFor(totalAttempts: number, mocksTaken: number): ReadinessConfidence {
    if (totalAttempts < READINESS_CONFIG.thinEvidenceAttempts) return 'low';
    if (totalAttempts >= READINESS_CONFIG.solidEvidenceAttempts && mocksTaken > 0) return 'high';
    return 'medium';
}

function toGap(topic: ReadinessTopic): ReadinessGap {
    return {
        topicId: topic.topicId,
        name: topic.name,
        subjectName: topic.subjectName,
        masteryScore: topic.masteryScore,
        cost: round(
            topic.weight * Math.max(0, READINESS_CONFIG.masteryTarget - masteryOf(topic)),
            2
        ),
    };
}

/**
 * Measured weaknesses: topics the learner has answered and is still short on, worst first.
 *
 * Deliberately excludes topics never attempted, even though those cost the score more. Their cost is
 * an assumption rather than a measurement — an untouched topic is scored against a mastery of zero,
 * but its real mastery is unknown and might be fine. Ranking the two together put the assumptions on
 * top, and because every untouched topic of one exam weight costs exactly the same, the order among
 * them came down to spelling: on a real 90-topic goal the list read "Divide and Conquer, Dynamic
 * Programming, Eigenvalues…", which is the alphabet rather than a finding.
 *
 * What is not started is a real part of the picture, so it is reported separately by `notStarted`
 * and counted by the coverage component. Kept apart because they are different kinds of claim and a
 * screen should not present them as if they were one.
 */
function measuredGapsFor(topics: ReadinessTopic[]): ReadinessGap[] {
    return topics
        .filter((t) => t.attempts > 0 && masteryOf(t) < READINESS_CONFIG.masteryTarget)
        .map(toGap)
        .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
        .slice(0, READINESS_CONFIG.maxGaps);
}

/**
 * Heaviest topics not started at all, by exam weight.
 *
 * Ordering within one weight is alphabetical and that is honest here, because the claim is only
 * "these are heavy and untouched" — any five of an equally-weighted set are a fair answer to that.
 */
function notStartedFor(topics: ReadinessTopic[]): ReadinessGap[] {
    return topics
        .filter((t) => t.attempts === 0)
        .map(toGap)
        .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
        .slice(0, READINESS_CONFIG.maxGaps);
}

/**
 * The verdict names the thing most worth doing next, which is why it is derived from the weakest
 * component rather than from the total. "You are 48% ready" tells a learner nothing they can act on;
 * "three subjects are untouched" does.
 */
function verdictFor(
    band: ReadinessBand,
    components: ReadinessComponent[],
    gaps: ReadinessGap[],
    notStarted: ReadinessGap[],
    confidence: ReadinessConfidence,
    daysRemaining: number
): string {
    if (components.length === 0) {
        return 'Set a goal and answer a few questions, and this will start to mean something.';
    }

    if (confidence === 'low') {
        // Measured weakness first if there is one; otherwise the heaviest thing not started. A
        // learner this early usually has nothing measured at all, so falling back matters.
        const first = gaps[0] ?? notStarted[0];
        return first
            ? `Too early to call — there is not enough answered yet to measure this. Practising ${first.name} would be a useful start.`
            : 'Too early to call — there is not enough answered yet to measure this.';
    }

    const weakest = [...components].sort((a, b) => a.score - b.score)[0]!;
    const days = daysRemaining > 0 ? ` with ${daysRemaining} days left` : '';

    const lead: Record<ReadinessBand, string> = {
        ready: `On course${days}.`,
        on_track: `Broadly on track${days}.`,
        building: `Coming along, but not there yet${days}.`,
        not_ready: `Not ready yet${days}.`,
    };

    const push: Record<ReadinessComponent['key'], string> = {
        mastery: gaps[0]
            ? `Accuracy is what is holding it back most — ${gaps[0].name} is costing the most.`
            : 'Accuracy is what is holding it back most.',
        coverage: notStarted[0]
            ? `The biggest gain is starting the topics not touched at all — ${notStarted[0].name} is the heaviest of them.`
            : 'The biggest gain is starting the topics that have not been touched at all.',
        mock: 'Mock scores are the weakest part — sitting a full paper is the fastest way to move this.',
        time: 'Time is the binding constraint; raising the daily budget matters more than any single topic now.',
    };

    return `${lead[band]} ${push[weakest.key]}`;
}

/**
 * Scores exam readiness from what the learner has actually done.
 *
 * Components that cannot be measured are dropped and the rest reweighted, never scored as zero. A
 * learner who has not sat a mock is not less ready than one who sat one and failed it, and a scheme
 * that says otherwise rewards avoiding the measurement.
 */
export function scoreReadiness(input: ReadinessInput): ReadinessResult {
    const { topics, mocks, daysRemaining, dailyMinutes } = input;

    const parts: ReadinessComponent[] = [];
    const push = (
        key: ReadinessComponent['key'],
        label: string,
        computed: { score: number; detail: string } | null
    ) => {
        if (!computed) return;
        parts.push({
            key,
            label,
            score: round(computed.score),
            weight: READINESS_CONFIG.weights[key],
            detail: computed.detail,
        });
    };

    if (topics.length > 0) {
        push('mastery', 'Mastery', masteryComponent(topics));
        push('coverage', 'Syllabus covered', coverageComponent(topics));
    }
    push('mock', 'Mock tests', mockComponent(mocks));
    push('time', 'Time available', timeComponent(topics, daysRemaining, dailyMinutes));

    // Reweight over the components that survived, so the total is always out of 100.
    const presentWeight = parts.reduce((sum, p) => sum + p.weight, 0);
    const score =
        presentWeight === 0
            ? 0
            : round(parts.reduce((sum, p) => sum + p.score * p.weight, 0) / presentWeight);

    const components = parts.map((p) => ({
        ...p,
        weight: presentWeight === 0 ? 0 : round(p.weight / presentWeight, 3),
    }));

    const totalAttempts = topics.reduce((sum, t) => sum + t.attempts, 0);
    const confidence = confidenceFor(totalAttempts, mocks.length);
    const band = bandFor(score);
    const gaps = measuredGapsFor(topics);
    const notStarted = notStartedFor(topics);

    return {
        score,
        band,
        confidence,
        verdict: verdictFor(band, components, gaps, notStarted, confidence, daysRemaining),
        components,
        gaps,
        notStarted,
        daysRemaining,
        topicsInScope: topics.length,
        topicsAttempted: topics.filter((t) => t.attempts > 0).length,
        topicsMastered: topics.filter((t) => masteryOf(t) >= READINESS_CONFIG.masteryTarget).length,
        mocksTaken: mocks.length,
    };
}
