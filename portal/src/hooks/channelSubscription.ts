// How a hook that subscribes to a gateway channel reads the gateway's answer,
// and how long it waits before asking again after a refusal. Pure; tested
// under node:test.
//
// Why this exists: useDistillationChannel used to re-run its subscribe effect
// whenever the gateway context changed identity — and the library's
// `useWebSocket` sets `lastError` (a fresh object) on every error frame, which
// re-renders the provider and hands every consumer a new context value. A
// refused subscribe therefore produced an error frame, which produced a new
// context, which re-subscribed, which was refused: ~4,600 frames a second from
// one tab, and route transitions that could not finish (2026-10-01). A refusal
// is an answer, not a transient: the hook stops, falls back to polling, and
// asks again only after resubscribeDelayMs.

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Did the gateway refuse our subscribe to `channel`? The router answers a
 * refused subscribe (realtime-modules 0.98.6+) with
 * `{ type: 'error', code: 'AUTHZ_CHANNEL_DENIED', channel, error: { code } }`;
 * any error frame that names our channel counts — a subscribe that failed for
 * another reason must not be retried in a tight loop either.
 */
export function isSubscribeRefusal(msg: unknown, channel: string): boolean {
  return isRecord(msg) && msg.type === 'error' && msg.channel === channel;
}

/** The router's `{ type: 'subscribe', action: 'subscribed', channel }` ack. */
export function isSubscribeAck(msg: unknown, channel: string): boolean {
  return isRecord(msg) && msg.type === 'subscribe' && msg.action === 'subscribed' && msg.channel === channel;
}

export const RESUBSCRIBE_BASE_MS = 30_000;
export const RESUBSCRIBE_MAX_MS = 10 * 60_000;

/**
 * Wait before the next subscribe after `refusals` consecutive refusals:
 * 30 s, 60 s, 2 min, 4 min, 8 min, then 10 min for good. A refusal is
 * usually permanent for the session (wrong tenant, no grant), so the retry
 * exists only to pick up a grant or a server fix without a reload.
 */
export function resubscribeDelayMs(refusals: number): number {
  const n = Math.max(1, Math.floor(refusals));
  return Math.min(RESUBSCRIBE_MAX_MS, RESUBSCRIBE_BASE_MS * 2 ** (n - 1));
}

/**
 * Reference-counted channel membership per socket. The router keeps ONE
 * membership per client and channel, so two mounted hooks on the same channel
 * (the distillation module header and its Review tab both read
 * `orgiq:distill:review`) share it: the first acquire subscribes, the last
 * release unsubscribes. Without the count, leaving the tab unsubscribed the
 * channel out from under the header. Keyed by the socket's `subscribe`
 * function, which is stable for a socket's lifetime.
 */
export function createChannelHolds() {
  const holds = new WeakMap<object, Map<string, number>>();
  const counts = (socket: object): Map<string, number> => {
    let m = holds.get(socket);
    if (!m) { m = new Map(); holds.set(socket, m); }
    return m;
  };
  return {
    acquire(socket: object, channel: string, subscribe: (channel: string) => void): void {
      const m = counts(socket);
      const n = m.get(channel) ?? 0;
      m.set(channel, n + 1);
      if (n === 0) subscribe(channel);
    },
    release(socket: object, channel: string, unsubscribe: (channel: string) => void): void {
      const m = counts(socket);
      const n = m.get(channel) ?? 0;
      if (n <= 1) {
        m.delete(channel);
        if (n === 1) unsubscribe(channel);
        return;
      }
      m.set(channel, n - 1);
    },
    /** Holders of `channel` on `socket` (tests). */
    count(socket: object, channel: string): number {
      return holds.get(socket)?.get(channel) ?? 0;
    },
  };
}

export const channelHolds = createChannelHolds();
