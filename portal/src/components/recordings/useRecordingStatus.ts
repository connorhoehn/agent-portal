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
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hidden = () => document.visibilityState === 'hidden';
    const until = Date.now() + 20 * 60_000;
    const read = async () => {
      if (running || stopped || controller.signal.aborted || hidden() || Date.now() >= until) return;
      running = true;
      const request = new AbortController(); active = request;
      const timeout = setTimeout(() => request.abort(), 30_000);
      try {
        const next = await client.status(id, lobby, revision, request.signal);
        if (request.signal.aborted || controller.signal.aborted) return;
        if (revision !== next) callback.current();
        revision = next;
        // Rate bound empty/immediate wakes, without delaying native events.
        timer = setTimeout(() => { void read(); }, 250);
      } catch {
        // Normal polling remains authoritative when the event path is unavailable.
        if (!request.signal.aborted) { stopped = true; callback.current(); }
        else if (!controller.signal.aborted && !hidden()) timer = setTimeout(() => { void read(); }, 1000);
      } finally {
        clearTimeout(timeout); running = false;
        if (active === request) active = null;
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
