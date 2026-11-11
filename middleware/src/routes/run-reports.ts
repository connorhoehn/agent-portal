// /api/run-reports — one page of run reports across every executor, newest first
// (docs/learning-loop-design.md "Pages", Runs; docs/learning-loop-handoff.md E2).
//
//   GET /api/run-reports?executor=&initiative=&outcome=&debrief=&cursor=&limit=
//
//   executor    one or more of fleet, governed, microvm, local, mock, comma separated
//   initiative  an initiative id
//   outcome     done, failed, cancelled or needs-review
//   debrief     a debrief state (skipped, requested, filed, nothing-to-keep, lint-failed, refused,
//               expired) or `none` for a run with no debrief record
//   cursor/limit  the store's page (limit capped at 200)
//
// Answers `{ reports: RunReport[], next: string | null }`: the stored rows as they are, filtered and
// paged, nothing computed. A bad filter value is a 400, never an empty list. The Runs page joins the
// names (work item, bot, initiative) from the reads it already has.
//
// Same door as /api/runs (routes/runs.ts): mounted under requireTenant('orgiq') with the bots read
// gate (org-leader, hr-admin, program-owner, and anyone holding ManageBots). One report is read by
// ref at GET /api/runs/:ref/report (routes/session-briefs.ts).

import { Router } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { readForRolesElseAction } from '../lib/authz.js';
import { RUN_EXECUTORS, RUN_OUTCOMES, type DebriefState, type RunExecutor, type RunOutcome } from '../lib/run-reports/types.js';
import type { ListRunReportsQuery, RunReportStore } from '../lib/run-reports/store.js';

const DEBRIEF_STATES: readonly string[] = ['none', 'skipped', 'requested', 'filed', 'nothing-to-keep', 'lint-failed', 'refused', 'expired'];

export interface RunReportsDeps {
  /** The run report store (lib/run-reports/store-select.ts); injected by suites. */
  reports?: () => RunReportStore | Promise<RunReportStore>;
}

const text = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** The query a request asks for, or a ValidationError naming the value that is not one. */
export function parseRunReportsQuery(q: Record<string, unknown>): ListRunReportsQuery {
  const out: ListRunReportsQuery = {};
  const executor = text(q['executor']);
  if (executor) {
    const list = executor.split(',').map((x) => x.trim()).filter(Boolean);
    const bad = list.find((x) => !(RUN_EXECUTORS as readonly string[]).includes(x));
    if (bad) throw new ValidationError(`executor "${bad}" is not one of ${RUN_EXECUTORS.join(', ')}`);
    out.executors = list as RunExecutor[];
  }
  const initiative = text(q['initiative']);
  if (initiative) out.initiativeId = initiative;
  const workItem = text(q['workItem']);
  if (workItem) out.workItemId = workItem;
  const runbook = text(q['runbook']);
  if (runbook) out.runbookId = runbook;
  const outcome = text(q['outcome']);
  if (outcome) {
    if (!(RUN_OUTCOMES as readonly string[]).includes(outcome)) throw new ValidationError(`outcome "${outcome}" is not one of ${RUN_OUTCOMES.join(', ')}`);
    out.outcome = outcome as RunOutcome;
  }
  const debrief = text(q['debrief']);
  if (debrief) {
    if (!DEBRIEF_STATES.includes(debrief)) throw new ValidationError(`debrief "${debrief}" is not one of ${DEBRIEF_STATES.join(', ')}`);
    out.debrief = debrief as DebriefState | 'none';
  }
  const cursor = text(q['cursor']);
  if (cursor) out.cursor = cursor;
  const n = Number(q['limit']);
  if (Number.isInteger(n) && n > 0) out.limit = Math.min(n, 200);
  return out;
}

export function createRunReportsRouter(deps: RunReportsDeps = {}): Router {
  const router = Router();
  const gate = readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], 'ManageBots');
  const store = async (): Promise<RunReportStore> =>
    deps.reports ? deps.reports() : (await import('../lib/run-reports/store-select.js')).runReportStore();

  router.get('/', gate, asyncHandler(async (req, res) => {
    const page = await (await store()).listReports(parseRunReportsQuery(req.query));
    res.json({ reports: page.items, next: page.next });
  }));
  return router;
}

export const runReportsRouter: Router = createRunReportsRouter();
