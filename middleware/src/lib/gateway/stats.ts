// Load line (docs/realtime-capacity-100-calls-2026-10-01.md §6, item 9).
//
// One JSON line per interval on stdout, which the ECS awslogs driver ships to
// /ecs/<prefix>-middleware, where OrgIQ-MiddlewareService's metric filters
// (realtimeAlarms=true) turn the fields into CloudWatch metrics. The gateway
// is pinned to ONE task, so "is it near its ceiling" is exactly these three
// numbers: sockets on this process, calls it is holding, and how late the
// event loop runs (a ring frame waits behind every blocked millisecond).

import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { RealtimeHandle } from '@connorhoehnslalom/realtime-modules/server';

export type RealtimeGatewayStore = 'redis' | 'memory';

export const GATEWAY_STATS_TYPE = 'realtime-gateway-stats';

export interface GatewayStatsInput {
  sockets: number;
  activeCalls: number;
  /** monitorEventLoopDelay percentiles, nanoseconds. */
  eventLoopP99Ns: number;
  eventLoopMaxNs: number;
  rssBytes: number;
  store: RealtimeGatewayStore;
}

/** The log line, pure. Field names are the metric filter's contract (infra). */
export function gatewayStatsLine(input: GatewayStatsInput, now: Date = new Date()): string {
  const ms = (ns: number) => Math.round((Number.isFinite(ns) ? ns : 0) / 1e4) / 100;
  return JSON.stringify({
    type: GATEWAY_STATS_TYPE,
    sockets: input.sockets,
    activeCalls: input.activeCalls,
    eventLoopDelayP99Ms: ms(input.eventLoopP99Ns),
    eventLoopDelayMaxMs: ms(input.eventLoopMaxNs),
    rssMb: Math.round(input.rssBytes / 1048576),
    store: input.store,
    ts: now.toISOString(),
  });
}

/** Calls the CallService is holding on this process (its per-node map). */
export function activeCallCount(services: Record<string, unknown>): number {
  for (const name of ['call', 'calls']) {
    const active = (services[name] as { activeCalls?: { size?: number } } | undefined)?.activeCalls;
    if (typeof active?.size === 'number') return active.size;
  }
  return 0;
}

/** REALTIME_STATS_INTERVAL_MS, default 60 s; 0 turns the line off. */
export function statsIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['REALTIME_STATS_INTERVAL_MS'] ?? '').trim();
  if (!raw) return 60_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
}

export function startStatsLine(handle: RealtimeHandle, store: RealtimeGatewayStore, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => undefined;
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const timer = setInterval(() => {
    try {
      console.log(gatewayStatsLine({
        sockets: handle.listClients().length,
        activeCalls: activeCallCount(handle.services as unknown as Record<string, unknown>),
        eventLoopP99Ns: histogram.percentile(99),
        eventLoopMaxNs: histogram.max,
        rssBytes: process.memoryUsage().rss,
        store,
      }));
    } finally {
      histogram.reset();
    }
  }, intervalMs);
  timer.unref?.();
  return () => { clearInterval(timer); histogram.disable(); };
}
