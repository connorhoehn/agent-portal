// The run report mock floor (docs/learning-loop-design.md §1): a registered
// fixture RowsRunReportStore (lib/run-reports/store-rows.ts) reads and writes,
// so `POST /api/__mock/reset` takes back every report a simulated run stored.
// The default world holds the seeded scheduled run's report and a few demo reports of earlier
// auth-service runs, so the Runs list, the initiative's Learning tab and the Recurring obstacles
// view have something to show; the other scenarios start empty: a report exists only because a run ended.
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

const CSRF_WALL = 'The required CSRF check failed on the pull request, and the evaluator named the lines it judged as weakening the check.';
const CALLBACK_WALL = 'The tenant\'s origin was missing from its Cognito app client\'s callback list, so the hosted-UI redirect still resolved to the old domain.';

/**
 * Demo reports of auth-service runs that hit the same two walls (the CSRF check, the callback list),
 * worded a little differently each time, across different work items. Their cost basis is
 * `simulated`, so the Runs list marks them "Demo data". The run refs are the sessions the seeded
 * runbooks already name (mock/runbooks.seed.ts), so the runbook pages and these reports agree.
 */
function demoAuthReports(): RunReport[] {
  const make = (runRef: string, workItemId: string, hoursAgo: number, outcome: 'done' | 'failed', summary: string, obstacles: string[]): RunReport => {
    const endedAt = clock.hoursAgo(hoursAgo);
    return {
      runRef, workItemId, initiativeId: 'p-auth-migration', executor: 'fleet', model: null,
      startedAt: new Date(Date.parse(endedAt) - 20 * 60_000).toISOString(), endedAt, outcome,
      failureCode: outcome === 'failed' ? 'exit_1' : null, summary,
      changes: { files: [], changeRequestId: null }, verification: [], obstacles,
      runbooksOffered: [], runbooksUsed: [], cost: { billedUsd: 0, reportedUsd: null, basis: 'simulated' }, kept: [],
      selfReport: 'ok', briefId: null, createdAt: endedAt,
    };
  };
  return [
    make('sess-auth-03', 'wi-auth-e1-b4', 30, 'failed', 'Stopped at the pull request: the required check stayed red.', [CSRF_WALL]),
    make('sess-auth-04', 'wi-auth-e2-s1', 20, 'done', 'Added the new tenant origin and its single-logout route.', [CSRF_WALL.replace(/\.$/, ''), 'The staging login page was slow to warm up.']),
    make('sess-auth-05', 'wi-auth-e1-s3', 14, 'done', 'Re-minted the session cookie on tenant and role switch.', [CSRF_WALL.toLowerCase()]),
    make('sess-auth-06', 'wi-auth-e2-s2', 7, 'failed', 'The cutover rehearsal failed at the flip.', [CALLBACK_WALL, CSRF_WALL]),
    make('sess-auth-07', 'wi-auth-e2-s1', 5, 'failed', 'Rehearsed the second tenant; the flip failed the same way.', [CALLBACK_WALL.replace(/\.$/, '')]),
  ];
}

export const runReportsFixture = defineFixture<RunReport>({
  key: 'run-reports',
  scenarios: { default: () => [...seededReports(), ...demoAuthReports()], empty: () => [] },
});

export const fixtureRunReportSources: RunReportRowSources = {
  reports: () => runReportsFixture.rows(),
};
