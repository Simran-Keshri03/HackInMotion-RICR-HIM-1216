import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fetch-on-mount with the four states a screen actually needs: data, loading, error, reload.
 *
 * Deliberately not a data-fetching library. Three screens each making one or two GET requests
 * do not need caching, deduplication or background revalidation, and adding a library for it
 * would cost more bundle than the whole app's own code.
 *
 * Two things it does get right, because both are easy to get wrong by hand:
 * - a response that arrives after the component unmounted is ignored, rather than setting
 *   state on a dead component
 * - `reload()` is stable, so it can be passed to a retry button without re-triggering the
 *   effect it belongs to
 */
export function useApi<T>(
    fetcher: () => Promise<T>,
    deps: unknown[] = []
): {
    data: T | null;
    loading: boolean;
    error: unknown;
    reload: () => void;
    /** Lets a screen fold in a result it already has, without a second request. */
    setData: (next: T) => void;
} {
    const [data, setData] = useState<T | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<unknown>(null);
    const [attempt, setAttempt] = useState(0);

    // The fetcher is usually an inline arrow function, so it is a new value on every render.
    // Holding it in a ref keeps it out of the effect's dependencies, which is what stops an
    // infinite re-fetch loop.
    const fetcherRef = useRef(fetcher);
    fetcherRef.current = fetcher;

    useEffect(() => {
        let active = true;
        setLoading(true);
        setError(null);

        fetcherRef
            .current()
            .then((result) => {
                if (active) setData(result);
            })
            .catch((cause) => {
                if (active) setError(cause);
            })
            .finally(() => {
                if (active) setLoading(false);
            });

        return () => {
            active = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [attempt, ...deps]);

    const reload = useCallback(() => setAttempt((n) => n + 1), []);

    return { data, loading, error, reload, setData };
}
