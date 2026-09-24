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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useGatewayOptional } from '@connorhoehnslalom/realtime-modules/client';
import { useFetch } from './useFetch';
import {
  CHANNEL_SNAPSHOT_URL, applyFrame, extractFrame, type DistillationChannel,
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
  const live = gateway?.connectionState === 'connected';
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

  const sessionEpoch = gateway?.sessionEpoch;
  useEffect(() => {
    if (!gateway || !live) return;
    gateway.subscribe(channel);
    const off = gateway.onMessage((msg) => {
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
      gateway.unsubscribe(channel);
    };
    // sessionEpoch: a reconnect drops channel membership server-side, so the
    // subscribe must be re-sent on every new session.
  }, [gateway, live, channel, sessionEpoch, currentValue]);

  return {
    data,
    isLoading: fetched.isLoading,
    error: fetched.error,
    degraded: fetched.degraded,
    live,
    refresh: fetched.refresh,
    setData,
  };
}
