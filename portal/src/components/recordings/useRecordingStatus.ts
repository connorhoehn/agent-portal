import { useEffect, useRef } from 'react';
import type { InitiativeRecordingsClient } from '../../pages/projects/initiativeRecordingApi';

/** Server-driven wake-ups supplement the existing finite authorized reads.
 * A missing/old event endpoint falls back to those reads, never a success state.
 * All content still comes from the normal participant-authorized detail API. */
export function useRecordingStatus(id: string | null, lobby: string, client: InitiativeRecordingsClient, onChange: () => void) {
  const callback = useRef(onChange); callback.current = onChange;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    let active: AbortController | null = null;
    let revision: string | null = null;
    let running = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => document.visibilityState === 'hidden';
    const until = Date.now() + 20 * 60_000;
    const read = async () => {
      if (running || controller.signal.aborted || hidden() || Date.now() >= until) return;
      running = true;
      const request = new AbortController(); active = request;
      let nextDelay = 250;
      const timeout = setTimeout(() => request.abort(), 30_000);
      try {
        const next = await client.status(id, lobby, revision, request.signal);
        if (request.signal.aborted || controller.signal.aborted) return;
        if (revision !== next) callback.current();
        revision = next;
        failures = 0;
      } catch {
        // A temporary outage must not permanently downgrade the session to
        // polling. Recheck authorization immediately, then reconnect with
        // bounded backoff while the normal metadata reader remains active.
        if (!request.signal.aborted && !controller.signal.aborted) {
          failures = Math.min(failures + 1, 6);
          callback.current();
        }
        nextDelay = Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1));
      } finally {
        clearTimeout(timeout); running = false;
        if (active === request) active = null;
        // Schedule only after releasing the in-flight guard. This also covers
        // a hide/show transition while an aborted response is settling.
        if (!controller.signal.aborted && !hidden() && Date.now() < until) {
          timer = setTimeout(() => { void read(); }, nextDelay);
        }
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (hidden()) active?.abort();
      else void read();
    };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => {
      controller.abort(); active?.abort(); clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [id, lobby, client]);
}
