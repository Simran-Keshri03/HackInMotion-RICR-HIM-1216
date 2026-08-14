import { useCallback, useEffect, useState } from 'react';

/**
 * Dark, light, or whatever the device prefers.
 *
 * The theme itself is applied by an inline script in `index.html`, before React exists — doing it
 * here would render the dark palette and then flip a frame later, which is a white flash on every
 * load. This hook only handles *changing* it afterwards, and reading back what the script decided.
 *
 * Stored in localStorage rather than on the server. Two reasons: it has to be readable
 * synchronously before the first paint, which rules out a request; and a theme is a property of the
 * screen somebody is looking at rather than of their account — the same learner on a phone at night
 * and a shared desktop at college does not necessarily want the same one. `profiles.settings` exists
 * if that judgement ever needs revisiting.
 */

export type Theme = 'dark' | 'light' | 'system';

/** Shared with the inline script in index.html. Changing it here means changing it there. */
const STORAGE_KEY = 'adigam-theme';

/** Reads whatever the inline script stored, tolerating storage being unavailable. */
function storedTheme(): Theme {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved === 'dark' || saved === 'light' ? saved : 'system';
    } catch {
        // Private windows throw on localStorage in some browsers.
        return 'system';
    }
}

function prefersLight(): boolean {
    return (
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-color-scheme: light)').matches
    );
}

function apply(theme: Theme): void {
    const light = theme === 'light' || (theme === 'system' && prefersLight());

    if (light) document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');

    // Keeps the browser's own chrome — the address bar on Android, the notch area on iOS — matching
    // the page. Without it a light page sits under a dark status bar, which reads as a rendering bug.
    document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', light ? '#f6f8fa' : '#0e1117');
}

export function useTheme(): {
    theme: Theme;
    setTheme: (next: Theme) => void;
    /** What is actually on screen, which differs from `theme` when it is 'system'. */
    resolved: 'dark' | 'light';
} {
    const [theme, setStored] = useState<Theme>(storedTheme);
    const [systemLight, setSystemLight] = useState(prefersLight);

    // Follow the device while set to 'system'. Without this, somebody whose phone switches to light
    // at sunrise keeps the night palette until they reload.
    useEffect(() => {
        const query = window.matchMedia('(prefers-color-scheme: light)');
        const onChange = () => setSystemLight(query.matches);

        query.addEventListener('change', onChange);
        return () => query.removeEventListener('change', onChange);
    }, []);

    useEffect(() => {
        apply(theme);
    }, [theme, systemLight]);

    const setTheme = useCallback((next: Theme) => {
        setStored(next);

        try {
            // 'system' is stored as an absence, so the inline script's fallback is the same decision
            // this hook would make. Storing the word would mean two places that have to agree.
            if (next === 'system') localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // The theme still applies for this session; it just will not be remembered.
        }
    }, []);

    return {
        theme,
        setTheme,
        resolved: theme === 'light' || (theme === 'system' && systemLight) ? 'light' : 'dark',
    };
}
