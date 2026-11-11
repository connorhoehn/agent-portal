// The run report mock floor (docs/learning-loop-design.md §1): a registered
// fixture RowsRunReportStore (lib/run-reports/store-rows.ts) reads and writes,
// so `POST /api/__mock/reset` takes back every report a simulated run stored.
// The default world holds one report, for the seeded run the runbooks seed froze a brief for; the
// other scenarios start empty: a report exists only because a run ended.
import type { RunReport } from '../lib/run-reports/types.js';
import type { RunReportRowSources } from '../lib/run-reports/store-rows.js';
import { clock, defineFixture } from './core/index.js';
import { FROZEN_RUN, seedBriefs } from './runbooks.seed.js';

/**
 * auth-dep-watch's firing of today (mock/bots.ts job-auth-maint-1, Auth Migration): done, 238 s. Its
 * frozen brief offered two runbooks (runbooks.seed.ts seedBriefs); it followed the CSRF-gate one and
 * did not use the tenant cutover one, as their application rows say. Hand-written, so marked simulated.
 */
export function seededReports(): RunReport[] {
  const brief = seedBriefs()[0]!;
  const offered = brief.sections.filter((x) => x.kind === 'runbook' && x.ref).map((x) => ({ id: x.ref!, version: x.version ?? null }));
  const ended = clock.hoursAgo(3 - FROZEN_RUN.seconds / 3600, { keepWithinToday: true });
  return [{
    runRef: FROZEN_RUN.runRef, workItemId: null, initiativeId: 'p-auth-migration', executor: 'fleet', model: null,
    startedAt: clock.hoursAgo(3, { keepWithinToday: true }), endedAt: ended, outcome: 'done', failureCode: null,
    summary: 'Bumped the JWT library in the token verifier; the OIDC conformance suite is green.',
    changes: { files: [], changeRequestId: null },
    verification: [{ command: 'npm test', passed: true }], obstacles: [],
    runbooksOffered: offered, runbooksUsed: offered.slice(0, 1).map((r) => ({ ...r, source: 'observed' as const })),
    cost: { billedUsd: null, reportedUsd: null, basis: 'simulated' }, kept: [],
    selfReport: 'ok', learned: '', briefId: brief.id, createdAt: ended,
  }];
}

export const runReportsFixture = defineFixture<RunReport>({
  key: 'run-reports',
  scenarios: { default: seededReports, empty: () => [] },
});

export const fixtureRunReportSources: RunReportRowSources = {
  reports: () => runReportsFixture.rows(),
};
