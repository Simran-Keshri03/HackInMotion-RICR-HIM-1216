import type { ActivityCalendar } from '@/types/api';

/**
 * A year of study as one grid — the shape GitHub and LeetCode use.
 *
 * 365 divs and a CSS grid. No charting library: a calendar-heatmap package would have weighed more
 * gzipped than this app's entire own code, and the target device is a phone with 2-4 GB of RAM. The
 * layout is `grid-auto-flow: column` with seven rows, which means the cells can be emitted in plain
 * date order and the browser does the week-bucketing — no date maths in JS at all.
 *
 * Leading blanks matter. The first column has to start on the right weekday or every square in the
 * year sits one row off, which is subtle enough to ship unnoticed and wrong enough to make the grid
 * meaningless.
 */

/** Weekday index of a YYYY-MM-DD date, 0 = Sunday, read in UTC so it cannot shift by timezone. */
function weekdayOf(date: string): number {
    return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function monthLabel(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
        month: 'short',
        timeZone: 'UTC',
    });
}

/**
 * Month names under the grid, one per month the window covers.
 *
 * Taken from the days themselves rather than generated, so the labels cannot drift out of step with
 * the squares above them.
 */
function monthsIn(days: { date: string }[]): string[] {
    const seen: string[] = [];

    for (const day of days) {
        const key = day.date.slice(0, 7);
        if (!seen.includes(key)) seen.push(key);
    }

    return seen.map((key) => monthLabel(`${key}-01`));
}

export function ActivityHeatmap({
    calendar,
}: {
    calendar: ActivityCalendar;
}) {
    const first = calendar.days[0];
    if (!first) return null;

    // Empty cells so the first real day lands on its own weekday row.
    const leadingBlanks = weekdayOf(first.date);

    return (
        <div className="card stack" style={{ gap: 10 }}>
            <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
                <div>
                    <span className="label">Activity</span>
                    <div style={{ marginTop: 4 }}>
                        <strong>{calendar.totalAnswered}</strong>{' '}
                        <span className="faint">
                            {calendar.totalAnswered === 1 ? 'question' : 'questions'} in
                            the past year
                        </span>
                    </div>
                </div>

                <div className="row" style={{ gap: 18 }}>
                    <span className="faint">
                        Active days: <strong>{calendar.activeDays}</strong>
                    </span>
                    <span className="faint">
                        Max streak: <strong>{calendar.maxStreak}</strong>
                    </span>
                </div>
            </div>

            <div className="heatmap__scroll">
                <div className="heatmap">
                    {Array.from({ length: leadingBlanks }, (_, i) => (
                        // Placeholders, not data. Hidden from screen readers, which would otherwise
                        // announce a row of nothing before the year starts.
                        <div key={`blank-${i}`} aria-hidden="true" />
                    ))}

                    {calendar.days.map((day) => (
                        <div
                            key={day.date}
                            className="heatmap__cell"
                            data-level={day.level}
                            // The only way to read a single square. `title` rather than a custom
                            // tooltip: the browser already has one, and it works on hover and on
                            // focus without any JS.
                            title={`${day.count === 0 ? 'No questions' : `${day.count} question${day.count === 1 ? '' : 's'}`} on ${day.date}`}
                        />
                    ))}
                </div>

                <div className="heatmap__months">
                    {monthsIn(calendar.days).map((month, i) => (
                        <span key={`${month}-${i}`}>{month}</span>
                    ))}
                </div>
            </div>

            <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
                <span className="faint">
                    {calendar.currentStreak > 0
                        ? `${calendar.currentStreak} day${calendar.currentStreak === 1 ? '' : 's'} in a row right now.`
                        : 'Answer something today to start a streak.'}
                </span>

                <div className="heatmap__legend">
                    <span>Less</span>
                    {[0, 1, 2, 3, 4].map((level) => (
                        <div
                            key={level}
                            className="heatmap__cell"
                            data-level={level}
                            aria-hidden="true"
                        />
                    ))}
                    <span>More</span>
                </div>
            </div>
        </div>
    );
}
