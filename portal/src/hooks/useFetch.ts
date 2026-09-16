import { useState, useEffect, useCallback, useRef } from 'react';
import { readDegraded } from '../lib/degraded';
import { nextPollDelay, isDocumentHidden } from './pollSchedule';

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

export interface UseFetchOptions {
  /**
   * Opt-in in-flight dedupe: when true, concurrent `useFetch` subscribers
   * polling the SAME url at the SAME moment issue one network request
   * between them (module-level in-flight map, pattern mirrors
   * `lib/capabilities.tsx`'s single-fetch cache). Each subscriber still keeps
   * its own `data`/`isLoading`/`error`/`refresh` — this only collapses the
   * transport call, never the per-component state.
   *
   * Off by default: most call sites fetch distinct URLs and sharing would be
   * a no-op, so this stays opt-in rather than changing every existing
   * caller's network behavior.
   */
  share?: boolean;
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

// Opt-in in-flight dedupe (UseFetchOptions.share). Keyed by url — a second
// subscriber asking for the same url while a request is already in flight
// awaits that SAME Response rather than opening a second connection. Every
// consumer reads via `res.clone()`, so the shared Response's body is never
// consumed directly and any number of subscribers can read it independently.
const sharedRequests = new Map<string, Promise<Response>>();

function sharedFetch(url: string): Promise<Response> {
  const existing = sharedRequests.get(url);
  if (existing) return existing;
  const promise = fetch(url, { credentials: 'include' }).finally(() => {
    if (sharedRequests.get(url) === promise) sharedRequests.delete(url);
  });
  sharedRequests.set(url, promise);
  return promise;
}

export function useFetch<T>(
  url: string | null,
  pollIntervalMs?: number,
  options?: UseFetchOptions,
): UseFetchReturn<T> {
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(url !== null);
  const [error, setError] = useState<string | null>(null);
  const [degraded, setDegraded] = useState<string | null>(null);
  const hasDataRef = useRef(false);
  const refreshRef = useRef<() => void>(() => {});
  const share = !!options?.share;

  useEffect(() => {
    if (!url) { setIsLoading(false); setData(null); setDegraded(null); hasDataRef.current = false; return; }

    let cancelled = false;
    let failures = 0;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // Only the direct (non-shared) fetch is abortable — a shared request may
    // still be wanted by another subscriber, so aborting it out from under
    // them on unmount/refresh would be a correctness bug, not a cleanup.
    let controller = new AbortController();
    // Reset the "have data" tracker when the URL changes so the first fetch
    // for the new URL shows the loading spinner.
    hasDataRef.current = false;

    // Polls pause entirely while the tab is hidden — nobody is looking, and a
    // background tab polling every few seconds is wasted requests (and, for
    // an authz-gated route, wasted audit-log noise). `scheduleNext` simply
    // declines to arm a timer while hidden; the `visibilitychange` listener
    // below is what resumes it.
    const scheduleNext = () => {
      if (!pollIntervalMs || pollIntervalMs <= 0) return;
      if (isDocumentHidden()) return;
      timeoutId = setTimeout(() => { void run(); }, nextPollDelay(failures, pollIntervalMs));
    };

    const run = async () => {
      // Only show the loading spinner on the first fetch for this URL.
      // Background poll refreshes update data silently to avoid flicker.
      if (!hasDataRef.current && !cancelled) setIsLoading(true);
      try {
        controller = new AbortController();
        const res = share
          ? await sharedFetch(url)
          : await fetch(url, { credentials: 'include', signal: controller.signal });
        if (!res.ok) throw new Error(await failureText(res));
        // Clone before parsing: a shared response is read by every
        // subscriber, and cloning is free (a no-op copy) when there is only
        // one.
        const json = (await res.clone().json()) as T;
        if (!cancelled) {
          setData(json);
          setError(null);
          // A 200 can still be an admission that the read failed. Unwrap it
          // here, once, so no page has to remember to look.
          setDegraded(readDegraded(json));
          setIsLoading(false);
          hasDataRef.current = true;
          failures = 0;
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
          failures += 1;
        }
      } finally {
        if (!cancelled) scheduleNext();
      }
    };

    refreshRef.current = () => {
      if (timeoutId) clearTimeout(timeoutId);
      void run();
    };

    const onVisibilityChange = () => {
      if (isDocumentHidden()) {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
        return;
      }
      // Back in view: the paused window may have gone stale, so refetch once
      // immediately rather than waiting out whatever poll delay was pending
      // when the tab went hidden. `run`'s own `finally` re-arms the timer.
      if (timeoutId) { clearTimeout(timeoutId); timeoutId = undefined; }
      void run();
    };

    const pollsAtAll = !!pollIntervalMs && pollIntervalMs > 0;
    if (pollsAtAll && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    void run();

    return () => {
      cancelled = true;
      controller.abort();
      if (timeoutId) clearTimeout(timeoutId);
      if (pollsAtAll && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    };
  }, [url, pollIntervalMs, share]);

  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);

  return { data, isLoading, error, degraded, refresh };
}
