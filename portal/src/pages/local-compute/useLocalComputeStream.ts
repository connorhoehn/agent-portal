// Live machine and job events, over the transport this app actually has.
//
// The obvious reach is a websocket through realtime-modules, and the portal
// does import its client hooks — but those need the websocket gateway, and in
// this deployment `VITE_GATEWAY_URL` points at the middleware itself, so in
// BFF-only mode (which is how dev:mock runs) there is no socket to open. Every
// other live surface here is server-sent events: the work queue's dispatcher
// stream, approvals, assessment runs, and the AG-UI agent stream itself. So
// this is EventSource against the middleware, which is the same push semantics
// over the transport that is really there.
//
// It degrades honestly. If the stream never opens or drops, `connected` goes
// false, the caller keeps its 15s poll, and the panel says "polled" rather
// than claiming to be live.
import { useEffect, useRef, useState } from 'react';

export interface LocalComputeStreamEvent {
  type: 'hello' | 'presence' | 'job';
  nodeId?: string;
  jobId?: string;
  status?: string;
  title?: string;
  at?: string;
}

export function useLocalComputeStream({ onChange }: { onChange: (event: LocalComputeStreamEvent) => void }) {
  const [connected, setConnected] = useState(false);
  // The callback changes identity every render; hold it in a ref so the
  // subscription is opened once rather than torn down and reopened on each
  // parent render, which would reconnect the stream several times a second.
  const cb = useRef(onChange);
  cb.current = onChange;

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let retry: number | undefined;
    let closed = false;
    let backoffMs = 1_000;

    const open = () => {
      if (closed) return;
      es = new EventSource('/api/local-compute/events', { withCredentials: true });
      es.onopen = () => { setConnected(true); backoffMs = 1_000; };
      es.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as LocalComputeStreamEvent;
          cb.current(parsed);
        } catch {
          // A frame we cannot parse is not worth tearing the stream down for.
        }
      };
      es.onerror = () => {
        setConnected(false);
        es?.close();
        es = null;
        if (closed) return;
        // Back off rather than hammering a middleware that is restarting —
        // `tsx watch` drops this connection on every file save in dev.
        retry = window.setTimeout(open, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      };
    };

    open();
    return () => {
      closed = true;
      if (retry !== undefined) window.clearTimeout(retry);
      es?.close();
      setConnected(false);
    };
  }, []);

  return { connected };
}
