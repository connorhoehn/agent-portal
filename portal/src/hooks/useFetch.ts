import { useState, useEffect, useCallback, useRef } from 'react';

interface UseFetchReturn<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useFetch<T>(url: string | null, pollIntervalMs?: number): UseFetchReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!url) { setIsLoading(false); setData(null); hasDataRef.current = false; return; }

    let cancelled = false;
    const controller = new AbortController();
    // Reset the "have data" tracker when the URL changes so the first fetch
    // for the new URL shows the loading spinner.
    hasDataRef.current = false;

    const run = async () => {
      // Only show the loading spinner on the first fetch for this URL.
      // Background poll refreshes update data silently to avoid flicker.
      if (!hasDataRef.current && !cancelled) setIsLoading(true);
      try {
        const res = await fetch(url, { credentials: 'include', signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = (await res.json()) as T;
        if (!cancelled) {
          setData(json);
          setError(null);
          setIsLoading(false);
          hasDataRef.current = true;
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Fetch failed');
          setIsLoading(false);
        }
      }
    };

    refreshRef.current = () => { void run(); };
    void run();

    const intervalId = pollIntervalMs && pollIntervalMs > 0
      ? setInterval(() => { void run(); }, pollIntervalMs)
      : undefined;

    return () => {
      cancelled = true;
      controller.abort();
      if (intervalId) clearInterval(intervalId);
    };
  }, [url, pollIntervalMs]);

  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);

  return { data, isLoading, error, refresh };
}
