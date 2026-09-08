// Subscribes to GET /api/assessment/events (assessment-broker.ts's SSE
// stream) and keeps the last EVENT_CAPACITY events in state. Mirrors the
// EventSource idiom in components/canary/useCanaryStream.ts — a native
// EventSource, not a hand-rolled poll: the browser handles reconnect and
// (because the server writes an `id:` line per frame) resumes with
// Last-Event-ID automatically, so a dropped connection only replays what
// this tab missed.
//
// One connection for the whole KnowledgeExplorer page; DocPane/ExplorerRail
// filter this shared list down to what's relevant to them via
// knowledgeFormat's sseEventsForDoc/pulledEventsForSection — no per-doc
// EventSource.

import { useEffect, useRef, useState } from 'react';
import type { AssessmentSSEEvent } from './types';

const EVENT_CAPACITY = 200;

export interface UseAssessmentEventsResult {
  events: AssessmentSSEEvent[];
  /** The CURRENT EventSource state — true only while the stream is actually
   *  open right now, not "has ever opened". Flips false on an error/drop and
   *  back to true once the browser's automatic reconnect lands (EventSource
   *  handles the retry itself; this just mirrors its live state). Drives the
   *  "Live" ConnectionPill — see knowledgeFormat's liveConnectionState. */
  connected: boolean;
  /** True once a `stream.gap` frame arrives — the server-side ring buffer's
   *  retention didn't reach back far enough to replay everything this tab
   *  missed (a laptop sleep, a slow reconnect while other docs/runs were
   *  busy). Resets to false on the next reopen (fresh replay attempt), same
   *  as `connected` mirrors the live EventSource state rather than history. */
  gapped: boolean;
}

// The server sends a named `heartbeat` event every 25s. If none (and no
// message) arrives for STALL_AFTER_MS the stream is a zombie — typically a
// dev proxy holding the browser's socket open after the middleware restarted
// underneath it, which fires no onerror — and we close and reopen it
// ourselves. The reopened stream carries no Last-Event-ID, so the broker
// replays its buffer; the epoch-prefixed ids make the dedupe below exact.
const STALL_AFTER_MS = 60_000;
const WATCHDOG_EVERY_MS = 10_000;

export function useAssessmentEvents(): UseAssessmentEventsResult {
  const [events, setEvents] = useState<AssessmentSSEEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [gapped, setGapped] = useState(false);
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    let es: EventSource | null = null;
    let lastSeen = Date.now();
    let disposed = false;

    const open = () => {
      es?.close();
      if (disposed) return;
      // A fresh stream is a fresh replay attempt — any prior gap notice no
      // longer describes this connection's coverage.
      setGapped(false);
      es = new EventSource('/api/assessment/events', { withCredentials: true });
      lastSeen = Date.now();
      es.onopen = () => { lastSeen = Date.now(); setConnected(true); };
      es.addEventListener('heartbeat', () => { lastSeen = Date.now(); setConnected(true); });
      es.onmessage = onMessage;
      es.onerror = () => {
        // The browser retries this on its own — no need to log every drop
        // (that's console-error spam on every navigation away from the page,
        // since unmounting mid-request also fires onerror). `connected` is
        // the honest signal; onopen flips it back once the retry lands.
        setConnected(false);
      };
    };

    const onMessage = (evt: MessageEvent) => {
      lastSeen = Date.now();
      // De-dupe on the SSE frame id (the broker's seq) — a reconnect that
      // races the browser's own Last-Event-ID catch-up could otherwise
      // double-apply an event already in state.
      // Ids are `<epoch>-<seq>` (unique across middleware restarts — a
      // restarted counter used to collide with ids already seen here and
      // every later event was dropped in silence). Bounded so a long-lived
      // tab does not grow this set forever.
      if (evt.lastEventId && seenRef.current.has(evt.lastEventId)) return;
      if (evt.lastEventId) {
        seenRef.current.add(evt.lastEventId);
        if (seenRef.current.size > EVENT_CAPACITY * 2) {
          const first = seenRef.current.values().next().value;
          if (first !== undefined) seenRef.current.delete(first);
        }
      }

      let parsed: AssessmentSSEEvent;
      try {
        parsed = JSON.parse(evt.data) as AssessmentSSEEvent;
      } catch {
        return;
      }
      if (parsed.type === 'stream.gap') {
        // A signal about this connection's coverage, not a tenant event —
        // don't add it to `events`.
        setGapped(true);
        return;
      }
      setEvents((prev) => {
        const next = [...prev, parsed];
        return next.length > EVENT_CAPACITY ? next.slice(next.length - EVENT_CAPACITY) : next;
      });
    };

    open();
    const watchdog = setInterval(() => {
      if (Date.now() - lastSeen > STALL_AFTER_MS) {
        setConnected(false);
        open();
      }
    }, WATCHDOG_EVERY_MS);

    return () => { disposed = true; clearInterval(watchdog); es?.close(); };
  }, []);

  return { events, connected, gapped };
}
