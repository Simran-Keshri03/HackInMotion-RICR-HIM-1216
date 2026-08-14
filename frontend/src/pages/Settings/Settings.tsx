import { type FormEvent, useEffect, useState } from 'react';
import { Failed, Loading } from '@/components/Loading/States';
import { useApi } from '@/hooks/useApi';
import { type Theme, useTheme } from '@/hooks/useTheme';
import { api } from '@/lib/api';
import { supabase } from '@/lib/supabase';
import type { LearnerProfile } from '@/types/api';

/**
 * Settings: what to call you, which timezone your days are in, and how the app looks.
 *
 * The timezone is not a cosmetic preference here, which is why it is on this page with an
 * explanation rather than hidden. Every streak, every "session missed", and every spaced-repetition
 * due date is decided by which calendar day the server thinks the learner is in — and getting that
 * from the server's own clock instead of theirs was a real bug in this project.
 */

const THEMES: { value: Theme; label: string; hint: string }[] = [
    { value: 'dark', label: 'Dark', hint: 'Easier at night' },
    { value: 'light', label: 'Light', hint: 'Easier in daylight' },
    { value: 'system', label: 'Match device', hint: 'Follows your phone or laptop' },
];

/**
 * Timezones offered as a short list rather than all six hundred.
 *
 * A dropdown of every IANA zone is a worse experience than five and is a real amount of bundle for
 * something almost every learner here never changes. The backend accepts any zone the platform
 * recognises, so this list is a convenience and not a limit.
 */
const TIMEZONES = [
    'Asia/Kolkata',
    'Asia/Dubai',
    'Asia/Singapore',
    'Europe/London',
    'America/New_York',
    'UTC',
];

export default function Settings() {
    const { theme, setTheme, resolved } = useTheme();

    const profile = useApi<{ profile: LearnerProfile }>(() =>
        api.get<{ profile: LearnerProfile }>('/learner/profile')
    );

    const [name, setName] = useState('');
    const [timezone, setTimezone] = useState('Asia/Kolkata');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Fill the form once the profile arrives, and never again — a late response must not overwrite
    // something the learner has started typing.
    const [filled, setFilled] = useState(false);

    useEffect(() => {
        const current = profile.data?.profile;
        if (!current || filled) return;

        setFilled(true);
        setName(current.displayName ?? '');
        setTimezone(current.timezone);
    }, [profile.data, filled]);

    async function save(event: FormEvent) {
        event.preventDefault();
        if (saving) return;

        setError(null);
        setSaved(false);
        setSaving(true);

        try {
            const result = await api.patch<{ profile: LearnerProfile }>(
                '/learner/profile',
                { displayName: name.trim(), timezone }
            );

            profile.setData({ profile: result.profile });
            setSaved(true);
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : 'Could not save your settings.'
            );
        } finally {
            setSaving(false);
        }
    }

    if (profile.loading) return <Loading label="Loading your settings…" />;

    const current = profile.data?.profile ?? null;

    return (
        <div className="stack">
            <div>
                <span className="label">Settings</span>
                <h1>Your account</h1>
            </div>

            {profile.error ? (
                <Failed error={profile.error} onRetry={profile.reload} />
            ) : null}

            {error && <div className="banner banner--error">{error}</div>}
            {saved && <div className="banner">Saved.</div>}

            {/* ------------------------------------------------ appearance */}
            <div className="card stack">
                <div>
                    <span className="label">Appearance</span>
                    <p className="faint" style={{ margin: '6px 0 0' }}>
                        Currently showing the {resolved} theme.
                    </p>
                </div>

                {THEMES.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        className="option"
                        aria-pressed={theme === option.value}
                        onClick={() => setTheme(option.value)}
                    >
                        <span className="option__mark">
                            {theme === option.value ? '✓' : ''}
                        </span>
                        <span>
                            {option.label}
                            <span className="faint">{' — '}{option.hint}</span>
                        </span>
                    </button>
                ))}

                <span className="faint">
                    Saved on this device, so a shared computer does not change it everywhere.
                </span>
            </div>

            {/* ------------------------------------------------ profile */}
            <form className="card stack" onSubmit={save}>
                <span className="label">About you</span>

                <div className="field">
                    <label htmlFor="displayName">Your name</label>
                    <input
                        id="displayName"
                        value={name}
                        maxLength={60}
                        placeholder="Ayush"
                        disabled={saving}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <span className="faint">
                        Shown on your dashboard, and to anybody in a study group with you.
                    </span>
                </div>

                <div className="field">
                    <label htmlFor="timezone">Timezone</label>
                    {/* Native select: every phone already has a good one, and this is a list of six. */}
                    <select
                        id="timezone"
                        value={timezone}
                        disabled={saving}
                        onChange={(e) => setTimezone(e.target.value)}
                    >
                        {/* A zone set elsewhere that is not in the short list still shows, rather than
                            silently becoming Kolkata the next time this form is saved. */}
                        {!TIMEZONES.includes(timezone) && (
                            <option value={timezone}>{timezone}</option>
                        )}
                        {TIMEZONES.map((zone) => (
                            <option key={zone} value={zone}>
                                {zone.replace('_', ' ')}
                            </option>
                        ))}
                    </select>
                    <span className="faint">
                        This decides when your day starts and ends — your streak, whether a
                        session counts as missed, and when a revision falls due.
                    </span>
                </div>

                <button
                    type="submit"
                    className="primary wide"
                    disabled={saving || name.trim() === ''}
                >
                    {saving ? 'Saving…' : 'Save'}
                </button>
            </form>

            {/* ------------------------------------------------ account */}
            <div className="card stack">
                <span className="label">Account</span>

                <div className="spread">
                    <span className="faint">Email</span>
                    <span>{current?.email ?? '—'}</span>
                </div>

                {current && (
                    <div className="spread">
                        <span className="faint">Joined</span>
                        <span>
                            {new Date(current.createdAt).toLocaleDateString(undefined, {
                                day: 'numeric',
                                month: 'long',
                                year: 'numeric',
                            })}
                        </span>
                    </div>
                )}

                <button type="button" onClick={() => void supabase.auth.signOut()}>
                    Sign out
                </button>
            </div>
        </div>
    );
}
