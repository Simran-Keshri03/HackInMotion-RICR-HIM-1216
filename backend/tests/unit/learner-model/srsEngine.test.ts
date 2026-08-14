import { describe, expect, it } from 'vitest';
import {
    SRS_CONFIG,
    addDays,
    daysOverdue,
    firstSchedule,
    isDue,
    nextReview,
    type ReviewState,
} from '@/services/learner/srsEngine.js';

/**
 * The scheduler that decides when a topic comes back.
 *
 * Getting this wrong is quiet: intervals that grow too fast let a learner forget a topic and never be
 * told, and intervals that grow too slowly fill the plan with things they already know, crowding out
 * what is actually at risk. Neither shows up as an error, so the boundaries are tested directly.
 *
 * The exam ceiling gets the most attention here, because it is the part that is not SM-2 and
 * therefore the part with no prior art to be right by accident.
 */

const TODAY = '2026-08-14';

function state(overrides: Partial<ReviewState> = {}): ReviewState {
    return {
        intervalDays: 3,
        easeFactor: 2.5,
        reviewCount: 1,
        lapses: 0,
        lastReviewedOn: '2026-08-11',
        ...overrides,
    };
}

function outcome(accuracyPercent: number, overrides = {}) {
    return {
        reviewedOn: TODAY,
        accuracyPercent,
        questionsAnswered: 5,
        daysUntilExam: 180,
        ...overrides,
    };
}

describe('addDays and overdue arithmetic', () => {
    it('crosses month and year boundaries', () => {
        expect(addDays('2026-08-30', 3)).toBe('2026-09-02');
        expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    });

    it('reports how overdue a topic is', () => {
        expect(daysOverdue('2026-08-10', TODAY)).toBe(4);
        expect(daysOverdue(TODAY, TODAY)).toBe(0);
        expect(daysOverdue('2026-08-20', TODAY)).toBe(-6);
    });

    it('treats a topic due today as due', () => {
        // Due "today" has to mean now, not tomorrow — otherwise every topic is a day late.
        expect(isDue(TODAY, TODAY)).toBe(true);
        expect(isDue('2026-08-10', TODAY)).toBe(true);
        expect(isDue('2026-08-20', TODAY)).toBe(false);
    });
});

describe('firstSchedule', () => {
    it('brings a newly studied topic back tomorrow', () => {
        // The first forgetting happens fastest, so the first gap is the shortest.
        const first = firstSchedule(TODAY, 180);

        expect(first.dueOn).toBe('2026-08-15');
        expect(first.intervalDays).toBe(1);
        expect(first.reviewCount).toBe(0);
        expect(first.finishedForThisGoal).toBe(false);
    });

    it('does not schedule a review a learner has no time for', () => {
        const first = firstSchedule(TODAY, 1);

        expect(first.finishedForThisGoal).toBe(true);
    });
});

describe('nextReview — passing', () => {
    it('uses the standard fixed second gap rather than multiplying immediately', () => {
        // Ease applied to the first interval would jump 1 day to 3 with no evidence behind it. SM-2
        // uses fixed opening steps for the same reason.
        const next = nextReview(
            state({ intervalDays: 1, reviewCount: 0 }),
            outcome(100)
        );

        expect(next.intervalDays).toBe(SRS_CONFIG.secondIntervalDays);
        expect(next.reviewCount).toBe(1);
        expect(next.lapsed).toBe(false);
    });

    it('multiplies by ease from the third review onward', () => {
        const next = nextReview(
            state({ intervalDays: 6, easeFactor: 2.5, reviewCount: 2 }),
            outcome(100)
        );

        expect(next.intervalDays).toBe(15);
        expect(next.dueOn).toBe(addDays(TODAY, 15));
    });

    it('raises ease when reviews keep going well, so easy topics recede', () => {
        const next = nextReview(
            state({ reviewCount: 3, easeFactor: 2.5 }),
            outcome(100)
        );

        expect(next.easeFactor).toBeGreaterThan(2.5);
        expect(next.easeFactor).toBeLessThanOrEqual(SRS_CONFIG.maxEase);
    });

    it('never lets ease run away', () => {
        let current = state({ reviewCount: 5, easeFactor: 2.95 });

        for (let i = 0; i < 10; i += 1) {
            const next = nextReview(current, outcome(100));
            current = { ...current, ...next, reviewCount: next.reviewCount };
        }

        expect(current.easeFactor).toBeLessThanOrEqual(SRS_CONFIG.maxEase);
    });

    it('caps the interval so a topic is revised, not parked', () => {
        const next = nextReview(
            state({ intervalDays: 55, easeFactor: 2.8, reviewCount: 6 }),
            outcome(100, { daysUntilExam: 365 })
        );

        expect(next.intervalDays).toBeLessThanOrEqual(SRS_CONFIG.maxIntervalDays);
    });
});

describe('nextReview — failing', () => {
    it('collapses the interval to tomorrow and counts a lapse', () => {
        const next = nextReview(
            state({ intervalDays: 30, reviewCount: 4, lapses: 1 }),
            outcome(20)
        );

        expect(next.intervalDays).toBe(1);
        expect(next.dueOn).toBe(addDays(TODAY, 1));
        expect(next.lapsed).toBe(true);
        expect(next.lapses).toBe(2);
    });

    it('lowers ease, so a topic this learner finds hard keeps coming back sooner', () => {
        const next = nextReview(state({ easeFactor: 2.5 }), outcome(20));

        expect(next.easeFactor).toBeLessThan(2.5);
    });

    it('never lets ease fall below the floor', () => {
        let current = state({ easeFactor: 1.4, reviewCount: 5, lapses: 2 });

        for (let i = 0; i < 10; i += 1) {
            const next = nextReview(current, outcome(10));
            current = { ...current, ...next };
        }

        // Below the floor the interval barely grows and the schedule is the wrong tool — that is a
        // topic needing to be taught differently, which `lapses` is there to surface.
        expect(current.easeFactor).toBeGreaterThanOrEqual(SRS_CONFIG.minEase);
    });

    it('keeps lapses within the review count, as the database requires', () => {
        // A CHECK constraint enforces lapses <= review_count; violating it would silently lose the
        // whole schedule update.
        let current = state({ reviewCount: 0, lapses: 0 });

        for (let i = 0; i < 6; i += 1) {
            const next = nextReview(current, outcome(10));
            expect(next.lapses).toBeLessThanOrEqual(next.reviewCount);
            current = { ...current, ...next };
        }
    });
});

describe('nextReview — the shaky middle', () => {
    it('grows the interval a little when some of it stuck', () => {
        const next = nextReview(
            state({ intervalDays: 10, reviewCount: 3 }),
            outcome(65)
        );

        // Neither a reset nor a full step is honest about 65%.
        expect(next.intervalDays).toBeGreaterThan(10);
        expect(next.intervalDays).toBeLessThan(25);
        expect(next.lapsed).toBe(false);
    });

    it('leaves ease alone in the middle', () => {
        const next = nextReview(state({ easeFactor: 2.5 }), outcome(65));

        expect(next.easeFactor).toBe(2.5);
    });
});

describe('nextReview — thin evidence', () => {
    it('does not compound a full step off one or two answers', () => {
        const generous = nextReview(
            state({ intervalDays: 10, reviewCount: 3, easeFactor: 2.5 }),
            outcome(100, { questionsAnswered: 5 })
        );
        const thin = nextReview(
            state({ intervalDays: 10, reviewCount: 3, easeFactor: 2.5 }),
            outcome(100, { questionsAnswered: 2 })
        );

        // Two out of two is encouraging, not proof.
        expect(thin.intervalDays).toBeLessThan(generous.intervalDays);
    });

    it('still lowers ease on a failure with thin evidence', () => {
        // Getting one of two wrong is still getting it wrong; being cautious here would let a topic
        // escape by being briefly reviewed.
        const next = nextReview(
            state({ easeFactor: 2.5 }),
            outcome(0, { questionsAnswered: 1 })
        );

        expect(next.easeFactor).toBeLessThan(2.5);
        expect(next.lapsed).toBe(true);
    });
});

describe('nextReview — the exam ceiling', () => {
    /**
     * This is the part that is not SM-2. Anki assumes you want to remember something forever, so its
     * intervals grow without limit. Here there is a date after which none of it matters, and a review
     * scheduled past it is not a schedule — it is dropping the topic without saying so.
     */
    it('never schedules a review after the exam', () => {
        const next = nextReview(
            state({ intervalDays: 20, easeFactor: 2.5, reviewCount: 4 }),
            outcome(100, { daysUntilExam: 10 })
        );

        expect(next.dueOn <= addDays(TODAY, 10)).toBe(true);
    });

    it('shortens the last review rather than dropping it', () => {
        const next = nextReview(
            state({ intervalDays: 30, easeFactor: 2.5, reviewCount: 4 }),
            outcome(100, { daysUntilExam: 6 })
        );

        // A pulled-in final review beats none at all.
        expect(next.intervalDays).toBeLessThan(30);
        expect(next.intervalDays).toBeGreaterThan(0);
        expect(next.finishedForThisGoal).toBe(false);
    });

    it('says a topic is finished when no review fits, rather than leaving it overdue forever', () => {
        const next = nextReview(state(), outcome(100, { daysUntilExam: 1 }));

        // Scheduling past the exam would leave it in the revision list looking permanently overdue.
        expect(next.finishedForThisGoal).toBe(true);
    });

    it('leaves the exam morning alone', () => {
        const next = nextReview(state(), outcome(100, { daysUntilExam: 2 }));

        expect(next.dueOn).not.toBe(addDays(TODAY, 2));
    });

    it('falls back to the ordinary ceiling when there is no goal', () => {
        const next = nextReview(
            state({ intervalDays: 20, reviewCount: 4 }),
            outcome(100, { daysUntilExam: null })
        );

        expect(next.intervalDays).toBeGreaterThan(20);
        expect(next.intervalDays).toBeLessThanOrEqual(SRS_CONFIG.maxIntervalDays);
        expect(next.finishedForThisGoal).toBe(false);
    });
});

describe('nextReview — topics from before this feature existed', () => {
    it('schedules a topic that has no row yet', () => {
        // Every topic practised before spaced repetition shipped is in this state, so it is a normal
        // path rather than an edge case.
        const next = nextReview(null, outcome(90));

        expect(next.reviewCount).toBe(1);
        expect(next.intervalDays).toBeGreaterThanOrEqual(1);
        expect(next.dueOn > TODAY).toBe(true);
    });
});

describe('the intervals a real learner would see', () => {
    it('grows a well-known topic to sensible gaps', () => {
        let current: ReviewState | null = null;
        let day = TODAY;
        const seen: number[] = [];

        for (let i = 0; i < 6; i += 1) {
            const next = nextReview(current, outcome(100, { reviewedOn: day }));
            seen.push(next.intervalDays);

            current = {
                intervalDays: next.intervalDays,
                easeFactor: next.easeFactor,
                reviewCount: next.reviewCount,
                lapses: next.lapses,
                lastReviewedOn: next.lastReviewedOn,
            };
            day = next.dueOn;
        }

        // Recognisably SM-2: short opening steps, then compounding, then the ceiling.
        expect(seen[0]).toBe(3);
        expect(seen).toEqual([...seen].sort((a, b) => a - b));
        expect(seen[seen.length - 1]).toBeLessThanOrEqual(SRS_CONFIG.maxIntervalDays);
    });
});
