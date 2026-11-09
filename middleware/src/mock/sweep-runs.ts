// Org-sweep runs, offline: the `sweep_runs` rows (schema/sweep_runs.sql).
// runSweep writes here in dev:mock; a reset puts the seed back.
//
// The seed is this morning's two scheduled sweeps that produced the open
// findings in mock/org-findings.ts (their lastSeenAt is six hours ago): the
// orphan-decisions sweep (find-mock-2, find-mock-5) and the stale-docs sweep
// (find-mock-3, find-mock-4). `empty` is a tenant whose sweeps never ran.

import { clock, defineFixture } from './core/index.js';
import type { SweepRunRow } from '../providers/sweep-runs.js';

function seededSweepRuns(): SweepRunRow[] {
  const run = (id: string, sweep: string, hoursAgo: number, durationMs: number, findings: number): SweepRunRow => {
    const startedAt = clock.hoursAgo(hoursAgo);
    return {
      id, tenant: 'orgiq', sweep, botId: null, startedAt,
      finishedAt: new Date(Date.parse(startedAt) + durationMs).toISOString(),
      status: 'ok', error: null, findings, durationMs,
    };
  };
  return [
    run('5c2e8f41-7a3b-4d06-9e15-2b8c4f6a1d73', 'orphan_decisions', 6.05, 2_840, 2),
    run('8e14b7d2-3f69-4a8c-b052-6d9e1a3c5f20', 'stale_docs', 6.1, 4_120, 2),
  ];
}

export const sweepRuns = defineFixture<SweepRunRow>({
  key: 'sweep-runs',
  scenarios: { default: seededSweepRuns, empty: () => [] },
});
