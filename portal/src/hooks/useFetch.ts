import { useState, useEffect, useCallback, useRef } from 'react';
import { readDegraded } from '../lib/degraded';

interface UseFetchReturn<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  /**
   * The wire's "we could not look" marker, already unwrapped: the first line
   * of the server-side error when the body carries `degraded: true`, else
   * `null`.
   *
   * This is a SECOND way to be blind and is not the same as `error`. `error`
   * means the request itself failed — no body, nothing to draw. `degraded`
   * means the request succeeded and the body is a well-formed empty answer
   * that the server is telling us not to believe. Reading only `error` is how
   * a failed query renders as a quiet week; see lib/degraded.ts.
   */
  degraded: string | null;
  refresh: () => void;
}

/**
 * What to show for a non-2xx.
 *
 * `503 Service Unavailable` is a status, not a reason, and the routes that
 * answer one put the reason in the body — `agent-detail` returns
 * `{ error, degraded: true, reason }` precisely so the page can say "could not
 * read the agent fleet" instead of "that agent does not exist". Throwing the
 * bare status line discarded the only sentence worth reading.
 */
async function failureText(res: Response): Promise<string> {
  const status = `${res.status} ${res.statusText}`.trim();
  try {
    const body: unknown = await res.clone().json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const rec = body as Record<string, unknown>;
      const said = [rec['error'], rec['reason'], rec['message']]
        .find((v) => typeof v === 'string' && v.trim().length > 0) as string | undefined;
      if (said) return `${status} — ${said.trim()}`;
    }
  } catch {
    // Not JSON, or already consumed. The status line is all we have.
  }
  return status;
}

export function useFetch<T>(url: string | null, pollIntervalMs?: number): UseFetchReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  const refreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!url) { setIsLoading(false); setData(null); setDegraded(null); hasDataRef.current = false; return; }

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
        if (!res.ok) throw new Error(await failureText(res));
        const json = (await res.json()) as T;
        if (!cancelled) {
          setData(json);
          setError(null);
          // A 200 can still be an admission that the read failed. Unwrap it
          // here, once, so no page has to remember to look.
          setDegraded(readDegraded(json));
          setIsLoading(false);
          hasDataRef.current = true;
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Fetch failed');
          // The transport failure is the story now; a marker from the previous
          // poll would only add a second, staler sentence.
          setDegraded(null);
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

  return { data, isLoading, error, degraded, refresh };
}
