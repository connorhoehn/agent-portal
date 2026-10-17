// Load line (docs/realtime-capacity-100-calls-2026-10-01.md §6, item 9).
//
// One JSON line per interval on stdout, which the ECS awslogs driver ships to
// /ecs/<prefix>-middleware, where OrgIQ-MiddlewareService's metric filters
// (realtimeAlarms=true) turn the fields into CloudWatch metrics. The gateway
// is pinned to ONE task, so "is it near its ceiling" is exactly these three
// numbers: sockets on this process, calls it is holding, and how late the
// event loop runs (a ring frame waits behind every blocked millisecond).
//
// The reading is the library's (`handle.onStats`, realtime-modules 0.119): its
// field names are the metric filter's contract (infra), and this file only
// adds the line's `type` and the store.

import type { RealtimeHandle, RealtimeStats } from '@connorhoehn/realtime-modules/server';

export type RealtimeGatewayStore = 'redis' | 'memory';

export const GATEWAY_STATS_TYPE = 'realtime-gateway-stats';

export type GatewayStatsInput = RealtimeStats & { store: RealtimeGatewayStore };

/** The log line, pure: the library's reading under the line's type, plus the store. */
export function gatewayStatsLine(input: GatewayStatsInput): string {
  const { store, ts, ...reading } = input;
  return JSON.stringify({ type: GATEWAY_STATS_TYPE, ...reading, store, ts });
}

/** REALTIME_STATS_INTERVAL_MS, default 60 s; 0 turns the line off. */
export function statsIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['REALTIME_STATS_INTERVAL_MS'] ?? '').trim();
  if (!raw) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

export function startStatsLine(handle: Pick<RealtimeHandle, 'onStats'>, store: RealtimeGatewayStore, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => undefined;
  return handle.onStats(stats => console.log(gatewayStatsLine({ ...stats, store })), { intervalMs });
}
