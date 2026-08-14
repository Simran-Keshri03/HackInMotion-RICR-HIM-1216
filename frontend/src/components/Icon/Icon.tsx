/**
 * The icons the app uses, as inline SVG paths.
 *
 * No icon library. `lucide-react` is the obvious choice and it is around 30 kB gzipped for the
 * dozen glyphs used here — more than the whole of this app's own JavaScript, on a phone with 2-4 GB
 * of RAM. Inline paths cost bytes only for the icons actually referenced, and the tree-shaking is
 * done by not writing the others.
 *
 * Drawn on a 24×24 grid with a 1.7 stroke so they sit at the same visual weight as the type. The
 * stroke inherits `currentColor`, so an icon in an active sidebar item turns white with its label
 * and never needs a second variant.
 */

export type IconName =
    | 'grid'
    | 'code'
    | 'file'
    | 'chart'
    | 'calendar'
    | 'users'
    | 'settings'
    | 'sparkles'
    | 'target'
    | 'shield'
    | 'lock'
    | 'flame'
    | 'chevron'
    | 'menu'
    | 'close'
    | 'mail'
    | 'eye'
    | 'eyeOff';

/** Path data only — the wrapper below supplies the shared attributes. */
const PATHS: Record<IconName, string> = {
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    code: 'M9 18l-6-6 6-6M15 6l6 6-6 6',
    file: 'M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    calendar:
        'M4 6a2 2 0 012-2h12a2 2 0 012 2v13a2 2 0 01-2 2H6a2 2 0 01-2-2zM4 10h16M9 3v4M15 3v4',
    users: 'M16 20v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 10a4 4 0 100-8 4 4 0 000 8M22 20v-2a4 4 0 00-3-3.87M16 2.13A4 4 0 0119 6a4 4 0 01-3 3.87',
    settings:
        'M12 15a3 3 0 100-6 3 3 0 000 6M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09A1.65 1.65 0 008.6 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09A1.65 1.65 0 004.6 8.6a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z',
    sparkles:
        'M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9zM19 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z',
    target: 'M12 21a9 9 0 100-18 9 9 0 000 18M12 17a5 5 0 100-10 5 5 0 000 10M12 13a1 1 0 100-2 1 1 0 000 2',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10M9 12l2 2 4-4',
    lock: 'M5 11h14a1 1 0 011 1v8a1 1 0 01-1 1H5a1 1 0 01-1-1v-8a1 1 0 011-1M8 11V7a4 4 0 018 0v4',
    flame: 'M12 22c4 0 7-2.6 7-6.5 0-4.5-5-6-4-11-3 1.5-6 4.5-6 8 0 1.5.5 2.5 1.5 3.5C9 15 8 13.5 8 12c-1.5 1.3-3 3-3 5.5C5 19.4 8 22 12 22z',
    chevron: 'M9 6l6 6-6 6',
    menu: 'M4 7h16M4 12h16M4 17h16',
    close: 'M6 6l12 12M18 6L6 18',
    mail: 'M3 6a1 1 0 011-1h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1zM3 7l9 6 9-6',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7M12 15a3 3 0 100-6 3 3 0 000 6',
    eyeOff: 'M3 3l18 18M10.6 5.2A9.7 9.7 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-2.4 3.3M6.5 6.8A17 17 0 002 12s3.5 7 10 7c1.3 0 2.4-.2 3.5-.6M9.9 9.9a3 3 0 004.2 4.2',
};

export function Icon({
    name,
    size = 18,
    className,
}: {
    name: IconName;
    size?: number;
    className?: string;
}) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.7}
            strokeLinecap="round"
            strokeLinejoin="round"
            // Decorative in every current use: the label next to it already says what it means, and
            // a screen reader announcing "users icon, Groups" is noise rather than help.
            aria-hidden="true"
            focusable="false"
            className={className}
        >
            <path d={PATHS[name]} />
        </svg>
    );
}

/** The wordmark. An open book, because this is a study product and it reads at 20px. */
export function Logo({ size = 26 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            focusable="false"
        >
            <defs>
                <linearGradient id="adigam-mark" x1="0" y1="0" x2="24" y2="24">
                    <stop offset="0%" stopColor="#3b82f6" />
                    <stop offset="100%" stopColor="#8b5cf6" />
                </linearGradient>
            </defs>
            <path
                d="M3 5.5A1.5 1.5 0 014.5 4H10a2 2 0 012 2v13a2 2 0 00-2-2H4.5A1.5 1.5 0 013 15.5zM21 5.5A1.5 1.5 0 0019.5 4H14a2 2 0 00-2 2v13a2 2 0 012-2h5.5A1.5 1.5 0 0021 15.5z"
                stroke="url(#adigam-mark)"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}
