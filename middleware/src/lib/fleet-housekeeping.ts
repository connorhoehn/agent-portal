// The reaper leader's once-a-sweep housekeeping (DE-37, DE-50).
//
// Runs on the replica that holds the reaper lock (lib/devbox-reaper.ts
// reaperTick), so exactly one replica frees dead run slots, writes the fleet
// stats line and announces budget crossings. Everything is lazy-imported: the
// reaper module stays loadable without config, as its tests need.

import type { FleetBox } from './devbox-fleet.js';
import type { ReapDecision } from './devbox-reaper.js';
import { emitFleetMetric } from './fleet-metrics.js';

/** Jobs claimed or running longer than this are stuck (the dispatcher's stale window). */
function staleJobMs(): number {
  const n = Number(process.env['JOB_STALE_MINUTES'] ?? 30);
  return (Number.isFinite(n) && n > 0 ? n : 30) * 60_000;
}

export async function fleetHousekeeping(boxes: FleetBox[], decisions: ReapDecision[], now: number): Promise<void> {
  let freedSlots = 0;
  try {
    const { freeDeadSlots } = await import('../providers/run-limits.js');
    freedSlots = await freeDeadSlots();
  } catch (err) {
    console.warn('[fleet] could not free dead run slots:', (err as Error).message);
  }

  let paused = false;
  try {
    const { fleetPaused } = await import('./fleet-switches.js');
    paused = await fleetPaused();
  } catch { /* unknown reads as not paused for the gauge */ }

  // Stuck: boxes the reaper is about to stop for task overrun, plus jobs whose
  // claim has outlived the dispatcher's stale window.
  let stuckJobs = 0;
  try {
    const { listJobs } = await import('../providers/agent-jobs.js');
    const live = [...await listJobs({ status: 'running', limit: 200 }), ...await listJobs({ status: 'claimed', limit: 200 })];
    stuckJobs = live.filter((j) => {
      const since = Date.parse(j.startedAt ?? j.claimedAt ?? '');
      return Number.isFinite(since) && now - since > staleJobMs();
    }).length;
  } catch { /* the gauge degrades to boxes only */ }
  const stuckBoxes = decisions.filter((d) => d.reason === 'task-overrun').length;

  emitFleetMetric('devbox-fleet-stats', {
    runningBoxes: boxes.filter((b) => b.status === 'running').length,
    liveBoxes: boxes.filter((b) => b.status !== 'stopped').length,
    stuckRuns: stuckBoxes + stuckJobs,
    fleetPaused: paused ? 1 : 0,
    freedSlots,
  });

  try {
    const { sweepBudgetThresholds } = await import('./fleet-alerts.js');
    await sweepBudgetThresholds(new Date(now));
  } catch (err) {
    console.warn('[fleet] budget threshold sweep failed:', (err as Error).message);
  }
}
