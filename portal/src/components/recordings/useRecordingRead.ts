import { useCallback, useEffect, useRef, useState } from 'react';

/** Authorized reads only. Hidden tabs pause; actor/scope unmount aborts; a
 * finite observation window does not turn an unfinished job into success. */
export function useRecordingRead<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>, delay: (value: T) => number | null) {
  const callbacks = useRef({ load, delay }); callbacks.current = { load, delay };
  const wake = useRef<() => void>(() => {});
  const recheck = useCallback(() => wake.current(), []);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const [state, setState] = useState<{ value: T | null; loading: boolean; error: string | null; timedOut: boolean; key: string | null; revision: number }>({ value: null, loading: false, error: null, timedOut: false, key: null, revision: 0 });
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, inFlight = false, dirty = false, nextDelay: number | null = null, hasRead = false;
    const until = Date.now() + 20 * 60_000;
    setState({ value: null, loading: !!key, error: null, timedOut: false, key, revision });
    if (!key) return () => abort.abort();
    // A hung network read must not leave a spinner forever either. This is
    // an observation deadline, not a claim that the native job failed.
    const deadline = setTimeout(() => {
      abort.abort(); clearTimeout(timer);
      setState(current => ({ ...current, loading: false, timedOut: true }));
    }, 20 * 60_000);
    const read = async () => {
      if (abort.signal.aborted || inFlight || document.visibilityState === 'hidden') return;
      if (Date.now() >= until) { setState(current => ({ ...current, loading: false, timedOut: true })); return; }
      inFlight = true;
      try {
        const value = await callbacks.current.load(abort.signal);
        if (abort.signal.aborted) return;
        hasRead = true;
        nextDelay = callbacks.current.delay(value);
        setState({ value, loading: false, error: null, timedOut: false, key, revision });
        if (nextDelay !== null) timer = setTimeout(() => { void read(); }, nextDelay); else clearTimeout(deadline);
      } catch (error) {
        clearTimeout(deadline);
        if (!abort.signal.aborted) setState(current => ({ ...current, loading: false, error: readableRecordingError(error) }));
      } finally {
        inFlight = false;
        if (dirty && !abort.signal.aborted) { dirty = false; clearTimeout(timer); void read(); }
      }
    };
    wake.current = () => { clearTimeout(timer); if (inFlight) dirty = true; else void read(); };
    const visible = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); if (!inFlight && (nextDelay !== null || !hasRead)) void read(); } };
    document.addEventListener('visibilitychange', visible);
    void read();
    return () => { wake.current = () => {}; abort.abort(); clearTimeout(timer); clearTimeout(deadline); document.removeEventListener('visibilitychange', visible); };
  }, [key, revision]); // The latest callbacks are read without restarting a job on render.
  // Hide a previous scope/generation in the render that precedes effect
  // cleanup; useEffect alone would briefly expose the old ready artifact.
  const visible = state.key === key && state.revision === revision ? state : { value: null, loading: !!key, error: null, timedOut: false };
  return { ...visible, refresh, recheck };
}

/** What a failed read says to a person: never a transport's raw text ("Failed to fetch"). */
export function readableRecordingError(error: unknown): string {
  if (error instanceof TypeError || (error instanceof Error && /failed to fetch|networkerror|load failed/i.test(error.message))) {
    return 'The recording service is not reachable right now.';
  }
  return error instanceof Error && error.message ? error.message : 'The recording could not be read.';
}

