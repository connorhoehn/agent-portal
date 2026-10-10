// Live Distillation data: a REST snapshot (useFetch) patched by realtime
// frames from the middleware's realtime path (spec §3d), in the same
// push-over-REST shape as the library's `useCapability`.
//
//   const { data, live } = useDistillationChannel<TierLevelsResponse>('distill:levels');
//
// With the gateway connected the snapshot is fetched once and every
// `distill:*` frame patches it in place (pages/distillation/distillationChannel
// holds the pure reducer). With no gateway — bff-only mode, where
// OptionalGatewayProvider mounts the inert `offlineGateway` — or while the
// socket is down, the hook polls the REST route instead, so the page is never
// frozen on a dead socket.
//
// The page names a channel by its key (`distill:levels`); the socket carries
// the tenant-partitioned wire name (`orgiq:distill:levels`, WIRE_CHANNEL),
// the only form the gateway's channel guard admits. A refused subscribe is
// final for a while, not a reason to ask again: the hook marks live updates
// unavailable (`refused`), keeps polling, and retries on a backed-off timer
// (hooks/channelSubscription.ts says why this once ran 4,600 frames a second).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import { useFetch } from './useFetch';
import { channelHolds, isSubscribeAck, isSubscribeRefusal, resubscribeDelayMs } from './channelSubscription';
import {
  CHANNEL_SNAPSHOT_URL, WIRE_CHANNEL, applyFrame, extractFrame, type DistillationChannel,
} from '../pages/distillation/distillationChannel';

export interface UseDistillationChannelOptions {
  /** Override the snapshot URL (e.g. `/api/distillation/review?verdict=pending`).
   *  null pauses the hook. */
  url?: string | null;
  /** Poll cadence while the gateway is not connected. Default 15s. */
  pollMs?: number;
}

export interface UseDistillationChannelReturn<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
  degraded: string | null;
  /** true while frames are arriving over a connected socket. */
  live: boolean;
  /** The gateway refused the subscription: live updates are unavailable and
   *  the snapshot is polled until a backed-off retry is accepted. */
  refused: boolean;
  refresh: () => void;
  /** Replace the local snapshot (optimistic writes). Cleared by the next REST
   *  snapshot. */
  setData: (update: (prev: T | null) => T | null) => void;
}

const DEFAULT_POLL_MS = 15_000;

export function useDistillationChannel<T>(
  channel: DistillationChannel,
  opts: UseDistillationChannelOptions = {},
): UseDistillationChannelReturn<T> {
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  // A refused subscribe parks the hook on polling until the retry timer.
  const [refused, setRefused] = useState(false);
  const refusalsRef = useRef(0);
  const live = connected && !refused;
  const url = opts.url === undefined ? CHANNEL_SNAPSHOT_URL[channel] : opts.url;
  // share: the module header and a tab read the same snapshot at once.
  const fetched = useFetch<T>(url, live ? undefined : (opts.pollMs ?? DEFAULT_POLL_MS), { share: true });

  // The patched copy is tied to the snapshot it was derived from: a new REST
  // body (poll, refresh, URL change) discards it rather than being overwritten
  // by stale patches. Mirrored in a ref so a frame handler computes its patch
  // synchronously instead of inside a deferred state updater.
  const [overlay, setOverlayState] = useState<{ base: T | null; value: T | null } | null>(null);
  const overlayRef = useRef(overlay);
  const baseRef = useRef<T | null>(fetched.data);
  baseRef.current = fetched.data;
  const refreshRef = useRef(fetched.refresh);
  refreshRef.current = fetched.refresh;

  const data = overlay && overlay.base === fetched.data ? overlay.value : fetched.data;

  const currentValue = useCallback((): T | null => {
    const prev = overlayRef.current;
    const base = baseRef.current;
    return prev && prev.base === base ? prev.value : base;
  }, []);

  const setData = useCallback((update: (prev: T | null) => T | null) => {
    const next = { base: baseRef.current, value: update(currentValue()) };
    overlayRef.current = next;
    setOverlayState(next);
  }, [currentValue]);

  // The effect depends on the gateway's FUNCTIONS, never the context object:
  // the library's useWebSocket returns a fresh object on every provider
  // render (every error frame sets `lastError`), so depending on `gateway`
  // re-ran this effect — unsubscribe, subscribe — on every render, and a
  // refusal's own error frame was enough to loop it. subscribe/unsubscribe/
  // onMessage are useCallback-stable in the library and in offlineGateway.
  const subscribe = gateway?.subscribe;
  const unsubscribe = gateway?.unsubscribe;
  const onMessage = gateway?.onMessage;
  const sessionEpoch = gateway?.sessionEpoch;
  const wire = WIRE_CHANNEL[channel];
  useEffect(() => {
    if (!subscribe || !unsubscribe || !onMessage || !connected || refused) return;
    let denied = false;
    // Shared with any other hook on this channel (the module header and a tab
    // both read review): only the first holder subscribes.
    channelHolds.acquire(subscribe, wire, subscribe);
    const off = onMessage((msg) => {
      if (denied) return;
      if (isSubscribeRefusal(msg, wire)) {
        denied = true;
        refusalsRef.current += 1;
        setRefused(true);
        return;
      }
      if (isSubscribeAck(msg, wire)) { refusalsRef.current = 0; return; }
      const frame = extractFrame(msg, channel);
      if (!frame) return;
      const current = currentValue();
      // No snapshot yet: nothing to patch, so read one.
      if (current == null) { refreshRef.current(); return; }
      const res = applyFrame(current, frame);
      const next = { base: baseRef.current, value: res.next };
      overlayRef.current = next;
      setOverlayState(next);
      if (res.refetch) refreshRef.current();
    });
    return () => {
      off();
      // The last holder leaves; after a refusal that is one unsubscribe for a
      // channel never joined, which the router answers harmlessly.
      channelHolds.release(subscribe, wire, unsubscribe);
    };
    // sessionEpoch: a reconnect drops channel membership server-side, so the
    // subscribe must be re-sent on every new session.
  }, [subscribe, unsubscribe, onMessage, connected, refused, wire, channel, sessionEpoch, currentValue]);

  // Ask again after a refusal, backed off (30 s doubling to 10 min) — enough to
  // pick up a new grant without a reload, never fast enough to be load.
  useEffect(() => {
    if (!refused) return;
    const t = setTimeout(() => setRefused(false), resubscribeDelayMs(refusalsRef.current));
    return () => clearTimeout(t);
  }, [refused]);

  return {
    data,
    isLoading: fetched.isLoading,
    error: fetched.error,
    degraded: fetched.degraded,
    live,
    refused,
    refresh: fetched.refresh,
    setData,
  };
}
