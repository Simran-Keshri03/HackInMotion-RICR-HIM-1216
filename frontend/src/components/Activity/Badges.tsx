import type { Badge, BadgeProgress } from '@/types/api';

/**
 * The shelf of what has been earned, and the next thing within reach.
 *
 * Both halves are shown together on purpose. A shelf on its own is a record of the past; "two more
 * days" is a reason to open the app tomorrow, which is what the challenge actually asks for. Showing
 * only earned badges is the version that looks finished and motivates nobody.
 *
 * Earned badges are outlined in green, targets are not, so which is which is obvious without reading.
 */

/** One emoji per family. Cheaper than five image files and legible at any size. */
const FAMILY_ICON: Record<string, string> = {
    streak: '🔥',
    volume: '📚',
    mastery: '🎯',
    accuracy: '✅',
    revision: '🔁',
};

function icon(family: string): string {
    return FAMILY_ICON[family] ?? '🏅';
}

export function Badges({ badges, upcoming }: { badges: Badge[]; upcoming: BadgeProgress[] }) {
    return (
        <div className="card stack" style={{ gap: 12 }}>
            <div className="spread">
                <span className="label">Badges</span>
                <span className="faint">{badges.length} earned</span>
            </div>

            {badges.length === 0 ? (
                <p className="muted" style={{ margin: 0 }}>
                    Nothing yet. The first one is three days in a row.
                </p>
            ) : (
                <div className="badges">
                    {badges.map((badge) => (
                        <div key={badge.id} className="badge badge--earned">
                            <span className="badge__name">
                                {icon(badge.family)} {badge.name}
                            </span>
                            <span className="badge__meta">{badge.description}</span>
                            {/* Only streak badges can say when they were earned; the others would
                                need a stored award date, and storing one would let a badge drift
                                from the attempts behind it. */}
                            {badge.earnedOn && (
                                <span className="badge__meta">{badge.earnedOn}</span>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {upcoming.length > 0 && (
                <>
                    <span className="label">Next up</span>
                    <div className="badges">
                        {upcoming.slice(0, 3).map((next) => (
                            <div key={next.id} className="badge">
                                <span className="badge__name">
                                    {icon(next.family)} {next.name}
                                </span>
                                <span className="badge__meta">
                                    {next.current} / {next.target}
                                </span>
                                <div className="badge__bar">
                                    <span
                                        style={{
                                            width: `${Math.min(100, Math.round((next.current / next.target) * 100))}%`,
                                        }}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}
