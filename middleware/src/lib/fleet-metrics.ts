// The fleet's metric lines (DE-50) — dependency-free, so the reaper and the
// fleet registry can emit without loading config or a provider. The alerting
// logic (budget thresholds, bell items) is lib/fleet-alerts.ts.

import { EventEmitter } from 'node:events';

export type FleetMetric =
  | 'devbox-spend' | 'devbox-reaped' | 'devbox-reap-failed' | 'devbox-run-cutoff'
  | 'devbox-fleet-stats' | 'budget-threshold' | 'fleet-switch';

/** Every alert, in process: `fleetAlerts.on('alert', (line) => …)`. */
export const fleetAlerts = new EventEmitter();
fleetAlerts.setMaxListeners(64);

/** The line, as written (exported for tests and the infra filter patterns). */
export function fleetMetricLine(type: FleetMetric, fields: Record<string, unknown>, now = new Date()): string {
  return JSON.stringify({ type, ...fields, ts: now.toISOString() });
}

/** Write one metric line to stdout and raise it in process. Never throws. */
export function emitFleetMetric(type: FleetMetric, fields: Record<string, unknown>): void {
  try {
    const line = fleetMetricLine(type, fields);
    console.log(line);
    fleetAlerts.emit('alert', { type, ...fields });
  } catch { /* an alert must never break the path that raised it */ }
}

/** The spend-rate line (DE-50), from the ledger write; a cost of null or 0 says nothing. */
export function emitSpendMetric(e: { costUsd: number | null; initiativeId: string | null; actorId: string | null; source: string; provider?: string | null }): void {
  if (e.costUsd == null || !(e.costUsd > 0) || e.provider === 'local') return;
  emitFleetMetric('devbox-spend', {
    usd: Math.round(e.costUsd * 10_000) / 10_000,
    InitiativeId: e.initiativeId ?? 'unattributed',
    ActorId: e.actorId ?? 'none',
    source: e.source,
  });
}

