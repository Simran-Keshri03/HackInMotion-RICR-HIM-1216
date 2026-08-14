/**
 * The learner's calendar day.
 *
 * Everything in this app that counts days — a streak, whether a revision is due, whether today's
 * session was missed — has to agree with the day the learner thinks they are in. `new Date()
 * .toISOString().slice(0, 10)` does not: it gives the UTC date, and for the timezone this app is
 * built for that is a different day for five and a half hours out of every twenty-four.
 *
 * The bug that produced this file: at 00:56 IST on 14 August the server believed the date was the
 * 13th. Two consequences, both silent. A learner studying at 01:00 and again at 10:00 on the same
 * morning crosses a UTC midnight in between, so it counts as two days — the streak inflates and the
 * spaced-repetition schedule steps twice for one sitting, pushing a topic away for having had one
 * good session. Nothing errors; the numbers are just wrong.
 *
 * `Intl.DateTimeFormat` is the platform's own timezone database, so this needs no dependency.
 * `en-CA` is used because its short date format is already YYYY-MM-DD.
 */

/**
 * Fallback when a profile has no timezone.
 *
 * The column is `not null default 'Asia/Kolkata'`, so this should be unreachable — but a date is not
 * worth throwing over, and UTC would be the one answer guaranteed to be wrong for these learners.
 */
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/** Today's date as the learner sees it, YYYY-MM-DD. */
export function todayIn(timezone: string | null | undefined, now = new Date()): string {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone ?? DEFAULT_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(now);
    } catch {
        // An unrecognised timezone string — a stored value from a client that made one up. Falling
        // back beats failing a submitted answer over a formatting call.
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: DEFAULT_TIMEZONE,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(now);
    }
}
