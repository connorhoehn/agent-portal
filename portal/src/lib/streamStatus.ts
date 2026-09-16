// What a live-stream indicator should say before it has ever connected.
//
// Two pages showed "reconnecting…" from the moment they mounted, because the
// only state they kept was `streaming: boolean` and anything that was not
// "live" got the reconnect label. On arrival nothing has connected yet, so
// there is no reconnect to report — the page opened by telling the reader
// about a failure that had not happened. On the Approvals queue that is the
// first thing seen above a list of decisions someone is about to make.

export type StreamPhase = 'live' | 'connecting' | 'reconnecting';

/**
 * `connectedOnce` is what separates the two waits: before the first `onopen`
 * the page is connecting, after it any gap is a reconnect.
 */
export function streamPhase(streaming: boolean, connectedOnce: boolean): StreamPhase {
  if (streaming) return 'live';
  return connectedOnce ? 'reconnecting' : 'connecting';
}

/** The phase as a reader sees it. */
export function streamStatusLabel(streaming: boolean, connectedOnce: boolean): string {
  const phase = streamPhase(streaming, connectedOnce);
  if (phase === 'live') return 'live';
  return phase === 'connecting' ? 'connecting…' : 'reconnecting…';
}
