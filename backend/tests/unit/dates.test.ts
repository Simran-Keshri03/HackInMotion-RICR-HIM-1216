import { describe, expect, it } from 'vitest';
import { todayIn } from '@/utils/dates.js';

/**
 * The learner's calendar day.
 *
 * Written after a real bug: at 00:56 IST on 14 August the server believed the date was the 13th,
 * because it was reading the UTC date. Nothing errored. What broke was quieter — a learner studying
 * at 01:00 and again at 10:00 on the same morning crosses UTC midnight in between, so it counted as
 * two days: the streak inflated, and the revision schedule stepped twice for one sitting, pushing a
 * topic weeks away for having had a single good session.
 *
 * The instant used below, 2026-08-13T19:30:00Z, is exactly that morning — 01:00 IST on the 14th.
 */

/** 01:00 on 14 August in India, which is still 13 August in UTC. */
const EARLY_MORNING_IST = new Date('2026-08-13T19:30:00.000Z');

describe('todayIn', () => {
    it("gives the learner their own date, not the server's", () => {
        expect(todayIn('Asia/Kolkata', EARLY_MORNING_IST)).toBe('2026-08-14');

        // The bug, stated as a fact: UTC disagrees, and following UTC is what was wrong.
        expect(EARLY_MORNING_IST.toISOString().slice(0, 10)).toBe('2026-08-13');
    });

    it('keeps one Indian day as one day across UTC midnight', () => {
        // 01:00 and 10:00 IST on the same morning. These are different UTC dates, and treating them
        // as two days is what inflated streaks and double-stepped the revision schedule.
        const oneAm = todayIn('Asia/Kolkata', new Date('2026-08-13T19:30:00.000Z'));
        const tenAm = todayIn('Asia/Kolkata', new Date('2026-08-14T04:30:00.000Z'));

        expect(oneAm).toBe(tenAm);
    });

    it("rolls over at the learner's midnight, not at UTC midnight", () => {
        // 23:59 IST on the 14th, and one minute later.
        expect(todayIn('Asia/Kolkata', new Date('2026-08-14T18:29:00.000Z'))).toBe('2026-08-14');
        expect(todayIn('Asia/Kolkata', new Date('2026-08-14T18:31:00.000Z'))).toBe('2026-08-15');
    });

    it('always returns a date the database will accept', () => {
        // Every caller writes this into a `date` column or compares it as a string, so the format is
        // load-bearing rather than cosmetic.
        for (const zone of ['Asia/Kolkata', 'UTC', 'America/New_York', 'Pacific/Kiritimati']) {
            expect(todayIn(zone, EARLY_MORNING_IST)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        }
    });

    it('handles the zones either side of the date line', () => {
        // Not for this product, but it is what proves the formatter is doing the work rather than an
        // offset being hardcoded somewhere.
        expect(todayIn('Pacific/Kiritimati', EARLY_MORNING_IST)).toBe('2026-08-14');
        expect(todayIn('Pacific/Midway', EARLY_MORNING_IST)).toBe('2026-08-13');
    });

    it('falls back rather than throwing on a missing or nonsense timezone', () => {
        // The column is `not null default 'Asia/Kolkata'`, so these should be unreachable — but an
        // answer must not be lost because a stored timezone string was junk.
        expect(todayIn(null, EARLY_MORNING_IST)).toBe('2026-08-14');
        expect(todayIn(undefined, EARLY_MORNING_IST)).toBe('2026-08-14');
        expect(todayIn('Mars/Olympus_Mons', EARLY_MORNING_IST)).toBe('2026-08-14');
    });
});
