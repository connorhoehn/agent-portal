import { useEffect, useRef } from 'react';

// One EventSource on /api/work/events for the whole tab, ref-counted across
// every subscriber. Queue, Work home and Findings used to open one each, so a
// user moving between them held several live connections to the same stream.
// The first subscriber opens it; the last one to leave closes it.

const URL = '/api/work/events';

let source: EventSource | null = null;
const listeners = new Set<() => void>();

/** The shared connection outside React (the voice dock's job follower, G19). */
export function subscribeWorkEvents(listener: () => void): () => void {
  return subscribe(listener);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!source && typeof EventSource !== 'undefined') {
    source = new EventSource(URL);
    source.onmessage = () => { for (const l of [...listeners]) l(); };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
    }
  };
}

/** Calls `onEvent` for every work-queue event. The callback may change every
 *  render; the shared connection does not. */
export function useWorkEvents(onEvent: () => void): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => subscribe(() => ref.current()), []);
}
