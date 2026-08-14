import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '@/components/Icon/Icon';
import { Failed } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { api } from '@/lib/api';
import type { GroupDetail, GroupSummary } from '@/types/api';

/**
 * Study groups: classmates preparing for the same thing, comparing how much they have done.
 *
 * Every handler, request and validation rule below is unchanged from the plain version of this
 * screen — this is presentation only. What the layout adds is a right-hand rail that answers the
 * questions somebody has *before* they join, since the decision is not obvious: what does this
 * reveal about me, and why would I bother.
 *
 * Two things the screen has to be honest about, because a learner cannot check them:
 *
 * What their group can see — name, questions answered, streak, topics mastered — and what it cannot:
 * accuracy, weak topics, wrong answers, tutor conversations. That is on the page rather than in a
 * privacy policy, because somebody deciding whether to join needs it at the moment they decide.
 *
 * And that groups are joined by code, never discovered. There is no browse and no search — nobody
 * ends up in a group, or visible in one, without having been handed its code. **This is why there is
 * no "Trending Groups" card here.** A list of groups with Join buttons would require exposing groups
 * to people who are not in them and letting them join without a code, which is the one property this
 * feature is built around. The rail shows the learner's own open group instead.
 */

/** "GATE 2027 Batch" -> "G2". Initials from the first two words, digits kept. */
function initials(name: string): string {
    const words = name.trim().split(/\s+/).filter(Boolean);

    if (words.length === 0) return '?';
    if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();

    return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

export default function StudyGroups() {
    const groups = useApi<{ groups: GroupSummary[] }>(() =>
        api.get<{ groups: GroupSummary[] }>('/groups')
    );

    const [openId, setOpenId] = useState<string | null>(null);
    const [detail, setDetail] = useState<GroupDetail | null>(null);
    const [loadingDetail, setLoadingDetail] = useState(false);

    const [name, setName] = useState('');
    const [code, setCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [copied, setCopied] = useState<string | null>(null);

    async function open(groupId: string) {
        setOpenId(groupId);
        setDetail(null);
        setError(null);
        setLoadingDetail(true);

        try {
            const result = await api.get<{ group: GroupDetail }>(`/groups/${groupId}`);
            setDetail(result.group);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not open that group.');
        } finally {
            setLoadingDetail(false);
        }
    }

    async function create(event: FormEvent) {
        event.preventDefault();
        if (busy || name.trim().length < 2) return;

        setError(null);
        setBusy(true);

        try {
            const result = await api.post<{ group: GroupSummary }>('/groups', {
                name: name.trim(),
            });

            setName('');
            groups.reload();
            void open(result.group.id);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not create the group.');
        } finally {
            setBusy(false);
        }
    }

    async function join(event: FormEvent) {
        event.preventDefault();
        if (busy || code.trim().length < 4) return;

        setError(null);
        setBusy(true);

        try {
            const result = await api.post<{ group: GroupSummary }>('/groups/join', {
                inviteCode: code.trim(),
            });

            setCode('');
            groups.reload();
            void open(result.group.id);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not join.');
        } finally {
            setBusy(false);
        }
    }

    async function leave(groupId: string) {
        setError(null);
        setBusy(true);

        try {
            await api.post(`/groups/${groupId}/leave`, {});
            setOpenId(null);
            setDetail(null);
            groups.reload();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Could not leave.');
        } finally {
            setBusy(false);
        }
    }

    function copy(inviteCode: string) {
        void navigator.clipboard?.writeText(inviteCode).then(
            () => {
                setCopied(inviteCode);
                setTimeout(() => setCopied(null), 1500);
            },
            () => undefined
        );
    }

    const mine = groups.data?.groups ?? [];

    return (
        <div className="worksplit">
            <div className="stack">
                {/* ------------------------------------------------ header */}
                <div className="spread" style={{ alignItems: 'flex-start', gap: 16 }}>
                    <div style={{ minWidth: 0 }}>
                        <span className="label">Study groups</span>
                        <h1 style={{ marginBottom: 6 }}>Study with your classmates</h1>
                        <p className="muted" style={{ margin: 0, maxWidth: '52ch' }}>
                            Compare how much everybody has got through. Groups are joined by code —
                            they cannot be searched for or browsed.
                        </p>
                    </div>

                    {/* Decorative, and hidden on narrow screens where it would push the heading
                        into two awkward lines. */}
                    <span className="hero-mark" aria-hidden="true">
                        <Icon name="users" size={40} />
                    </span>
                </div>

                {error && <div className="banner banner--error">{error}</div>}

                {/* ------------------------------------------------ privacy */}
                <div className="card card--glow stack" style={{ gap: 10 }}>
                    <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                        <span className="tile tile--blue">
                            <Icon name="shield" />
                        </span>
                        <div style={{ minWidth: 0 }}>
                            <span className="label">What your group can see</span>
                            <p style={{ margin: '6px 0 0' }}>
                                Your name, how many questions you have answered, your streak, and
                                how many topics you have mastered.
                            </p>
                        </div>
                    </div>

                    <p className="faint" style={{ margin: 0, paddingLeft: 48 }}>
                        Not your accuracy, not your weak topics, not your answers, and nothing you
                        asked the tutor.
                    </p>
                </div>

                {/* ------------------------------------------------ your groups */}
                <div className="card stack" style={{ gap: 8 }}>
                    <span className="label">Your groups</span>

                    {groups.loading && (
                        <>
                            <div className="skeleton" style={{ height: 60 }} />
                            <div className="skeleton" style={{ height: 60, opacity: 0.6 }} />
                        </>
                    )}

                    {groups.error ? <Failed error={groups.error} onRetry={groups.reload} /> : null}

                    {!groups.loading && !groups.error && mine.length === 0 && (
                        <div className="stack" style={{ gap: 4, padding: '10px 2px' }}>
                            <strong>No groups yet</strong>
                            <span className="faint">
                                Create a group or join one using an invite code.
                            </span>
                        </div>
                    )}

                    {mine.map((group) => (
                        <button
                            key={group.id}
                            type="button"
                            className="row-item"
                            aria-pressed={group.id === openId}
                            onClick={() => void open(group.id)}
                        >
                            <span className="avatar" aria-hidden="true">
                                {initials(group.name)}
                            </span>
                            <span className="row-item__body">
                                <strong>{group.name}</strong>
                                <div className="faint">
                                    {group.memberCount}{' '}
                                    {group.memberCount === 1 ? 'member' : 'members'}
                                    {group.role === 'owner' && ' · Yours'}
                                </div>
                            </span>
                            <Icon name="chevron" className="row-item__chev" />
                        </button>
                    ))}
                </div>

                {/* ------------------------------------------------ the open group */}
                {loadingDetail && (
                    <div className="card stack" style={{ gap: 10 }}>
                        <div className="skeleton" style={{ height: 20, width: '40%' }} />
                        <div className="skeleton" style={{ height: 90 }} />
                        <div className="skeleton" style={{ height: 44 }} />
                    </div>
                )}

                {detail && (
                    <div className="card stack">
                        <div className="spread" style={{ flexWrap: 'wrap', gap: 8 }}>
                            <div>
                                <span className="label">{detail.name}</span>
                                <div className="faint">
                                    {detail.comparison.yourRank !== null
                                        ? `You are ${ordinal(detail.comparison.yourRank)} of ${detail.comparison.memberCount}`
                                        : `${detail.comparison.memberCount} members`}
                                </div>
                            </div>

                            <button
                                type="button"
                                className="secondary"
                                onClick={() => copy(detail.inviteCode)}
                            >
                                {copied === detail.inviteCode
                                    ? 'Copied'
                                    : `Code: ${detail.inviteCode}`}
                            </button>
                        </div>

                        {/* The group's combined total, above the ranking. A study group that is only
                            a leaderboard makes four people feel behind one; a shared number is
                            something they add to together. */}
                        <div className="card card--accent">
                            <span className="label">Together</span>
                            <div className="row" style={{ marginTop: 12, gap: 28 }}>
                                <div>
                                    <div className="big">
                                        {detail.comparison.totals.questionsAnswered}
                                    </div>
                                    <div className="faint">questions answered</div>
                                </div>
                                <div>
                                    <div className="big">
                                        {detail.comparison.totals.topicsMastered}
                                    </div>
                                    <div className="faint">topics mastered</div>
                                </div>
                            </div>
                            {detail.comparison.topStreak && (
                                <p className="faint" style={{ marginTop: 12, marginBottom: 0 }}>
                                    Longest streak going: {detail.comparison.topStreak.displayName}{' '}
                                    on {detail.comparison.topStreak.days}{' '}
                                    {detail.comparison.topStreak.days === 1 ? 'day' : 'days'}.
                                </p>
                            )}
                        </div>

                        <div className="stack" style={{ gap: 4 }}>
                            {detail.comparison.members.map((member) => (
                                <div
                                    key={member.userId}
                                    className="row-item"
                                    style={{ cursor: 'default' }}
                                    aria-current={member.isYou ? 'true' : undefined}
                                >
                                    <span className="rank">{member.rank}</span>
                                    <span className="avatar avatar--sm" aria-hidden="true">
                                        {initials(member.displayName)}
                                    </span>
                                    <span className="row-item__body">
                                        <strong>{member.displayName}</strong>
                                        {member.isYou && <span className="faint"> (you)</span>}
                                        <div className="faint">
                                            {member.questionsAnswered} answered ·{' '}
                                            {member.currentStreakDays} day streak ·{' '}
                                            {member.topicsMastered} mastered
                                        </div>
                                    </span>
                                </div>
                            ))}
                        </div>

                        <button type="button" disabled={busy} onClick={() => void leave(detail.id)}>
                            Leave this group
                        </button>
                    </div>
                )}

                {/* ------------------------------------------------ create */}
                <form className="card stack" onSubmit={create}>
                    <span className="label">Make a group</span>

                    <div className="field">
                        <label htmlFor="groupName">Group name</label>
                        <div className="inputwrap">
                            <span className="inputwrap__icon">
                                <Icon name="users" size={16} />
                            </span>
                            <input
                                id="groupName"
                                value={name}
                                maxLength={60}
                                placeholder="GATE 2027 batch"
                                disabled={busy}
                                onChange={(e) => setName(e.target.value)}
                            />
                        </div>
                        <span className="faint">
                            You get a code to share. Only people you give it to can join.
                        </span>
                    </div>

                    <button
                        type="submit"
                        className="primary wide"
                        disabled={busy || name.trim().length < 2}
                    >
                        {busy ? 'Working…' : 'Create group'}
                    </button>
                </form>

                {/* ------------------------------------------------ join */}
                <form className="card stack" onSubmit={join}>
                    <span className="label">Join with a code</span>

                    <div className="field">
                        <label htmlFor="inviteCode">Enter group code</label>
                        <div className="inputwrap">
                            <span className="inputwrap__icon">
                                <Icon name="lock" size={16} />
                            </span>
                            <input
                                id="inviteCode"
                                value={code}
                                maxLength={20}
                                placeholder="AB7K2M"
                                disabled={busy}
                                // Upper case as they type, since that is what a code is. The server
                                // tidies it too; matching what they were handed avoids the doubt.
                                style={{ textTransform: 'uppercase', letterSpacing: '0.08em' }}
                                onChange={(e) => setCode(e.target.value)}
                            />
                        </div>
                    </div>

                    <button
                        type="submit"
                        className="secondary wide"
                        disabled={busy || code.trim().length < 4}
                    >
                        {busy ? 'Working…' : 'Join group'}
                    </button>
                </form>
            </div>

            {/* ------------------------------------------------ insights rail */}
            <aside className="stack">
                <div className="card card--hover stack" style={{ gap: 14 }}>
                    <div className="row" style={{ gap: 10 }}>
                        <span className="tile tile--blue">
                            <Icon name="sparkles" />
                        </span>
                        <strong>Why study in a group?</strong>
                    </div>

                    {[
                        {
                            tile: 'tile--green',
                            icon: 'chart',
                            title: 'Stay motivated',
                            body: 'See your progress alongside your peers.',
                        },
                        {
                            tile: 'tile--fire',
                            icon: 'flame',
                            title: 'Build consistency',
                            body: 'Healthy competition helps you do better.',
                        },
                        {
                            tile: 'tile--violet',
                            icon: 'users',
                            title: 'Learn together',
                            body: 'Discuss topics and clear doubts with your group.',
                        },
                    ].map((benefit) => (
                        <div
                            key={benefit.title}
                            className="row"
                            style={{ gap: 12, alignItems: 'flex-start' }}
                        >
                            <span className={`tile ${benefit.tile}`}>
                                <Icon name={benefit.icon as 'chart'} />
                            </span>
                            <div style={{ minWidth: 0 }}>
                                <strong style={{ fontSize: '0.92rem' }}>{benefit.title}</strong>
                                <div className="faint">{benefit.body}</div>
                            </div>
                        </div>
                    ))}
                </div>

                {/*
                    Where a "Trending Groups" card would sit.

                    It is not here because it cannot be honest. Listing groups with Join buttons needs
                    groups to be discoverable by people who are not in them and joinable without a
                    code — and undiscoverable-by-design is the property this whole feature is built
                    around, enforced by row-level security rather than by the UI. A card of invented
                    groups with buttons that cannot work would be decoration pretending to be a
                    feature.

                    This shows the learner's own group instead, from the same data already loaded.
                */}
                {detail && detail.comparison.members.length > 0 && (
                    <div className="card stack" style={{ gap: 8 }}>
                        <div className="spread">
                            <strong>{detail.name}</strong>
                            <span className="faint">{detail.comparison.memberCount} members</span>
                        </div>

                        {detail.comparison.members.slice(0, 5).map((member) => (
                            <div key={member.userId} className="row" style={{ gap: 10 }}>
                                <span className="rank">{member.rank}</span>
                                <span className="avatar avatar--sm" aria-hidden="true">
                                    {initials(member.displayName)}
                                </span>
                                <span style={{ flex: '1 1 auto', minWidth: 0 }}>
                                    <div style={{ fontSize: '0.9rem' }}>
                                        {member.displayName}
                                        {member.isYou && <span className="faint"> (you)</span>}
                                    </div>
                                    <div className="faint">{member.questionsAnswered} answered</div>
                                </span>
                            </div>
                        ))}
                    </div>
                )}

                <div className="card stack" style={{ gap: 14 }}>
                    <strong>How it works</strong>

                    <div className="steps">
                        {[
                            'Create or join a group',
                            'Practice and improve together',
                            'Track progress and stay ahead',
                        ].map((step, index) => (
                            <div key={step} className="step">
                                <span className="step__n">{index + 1}</span>
                                <span style={{ fontSize: '0.92rem' }}>{step}</span>
                            </div>
                        ))}
                    </div>

                    <Link to="/goals" className="faint">
                        Not sure what to study? Set a goal first
                    </Link>
                </div>
            </aside>
        </div>
    );
}

/** "1st", "2nd", "3rd" — a rank reads better than a bare number next to a name. */
function ordinal(n: number): string {
    const suffix =
        n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');

    return `${n}${suffix}`;
}
