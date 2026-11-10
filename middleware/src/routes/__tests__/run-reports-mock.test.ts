// The run report on the mock (docs/learning-loop-design.md §1, acceptance item 1):
// a marketplace dispatch with no devbox runtime ends with a stored report built
// from the fixture its work item's labels pick (mock/run-report-fixtures.ts),
// readable at GET /api/runs/:ref/report and listed for its work item and its
// initiative. A run that loaded a runbook it was given writes an application
// row, so the runbook's health moves.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { readForRolesElseAction: pass, requireAction: pass, requireSession: pass, requireTenant: pass };
});
jest.mock('../../lib/devbox-arn.js', () => ({ resolveDevboxArn: jest.fn(async () => null), devboxDataClient: jest.fn() }));
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
jest.mock('../../lib/devbox-fleet.js', () => ({
  registerBox: jest.fn((opts: { sessionId: string }) => ({ id: 'box-test', sessionId: opts.sessionId })),
  getBoxBySession: jest.fn(() => null),
  appendEvent: jest.fn(),
}));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));

import express from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { createSessionBriefsRouter } from '../session-briefs.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __setMockDispatchStepMs } from '../../lib/bot-runner.js';
import { __resetMockRuns } from '../../providers/bots.js';
import { getJob } from '../../providers/agent-jobs.js';
import { runbookStore } from '../../lib/runbooks/store-select.js';
import { runbookHealth } from '../../lib/runbooks/health.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { clock } from '../../mock/core/clock.js';
import type { RunReport } from '../../lib/run-reports/types.js';

beforeAll(() => __setMockDispatchStepMs(0));
afterAll(() => __setMockDispatchStepMs(2_000));
beforeEach(() => { fixtureRegistry.resetAll(); __resetMockRuns(); });

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' };
    next();
  });
  a.use('/api/bots', botsRouter);
  a.use('/api', createSessionBriefsRouter({ store: () => runbookStore() }));
  a.use(errorHandler);
  return a;
}

async function dispatch(workItemId: string): Promise<{ jobId: string; report: RunReport }> {
  const res = await request(app()).post('/api/bots/dispatch-work').send({ workItemId, model: 'us.amazon.nova-lite-v1:0' });
  expect(res.status).toBe(202);
  const jobId = res.body.run.jobId as string;
  const got = await request(app()).get(`/api/runs/${jobId}/report`);
  expect(got.status).toBe(200);
  return { jobId, report: got.body.report as RunReport };
}

describe('the simulated run ends with a stored report', () => {
  it('a run that used a runbook it was given: observed use, an application row, health proven', async () => {
    const { jobId, report } = await dispatch('wi-obs-e3-s1');
    expect(report).toMatchObject({
      runRef: jobId, executor: 'mock', outcome: 'done', workItemId: 'wi-obs-e3-s1', initiativeId: 'p-observability',
      selfReport: 'ok', cost: { basis: 'simulated' }, failureCode: null,
    });
    expect(report.summary).toMatch(/Metric cardinality budgets/);
    expect(report.verification).toEqual([{ command: 'npm test', passed: true }, { command: 'npm run lint', passed: true }]);
    expect(report.obstacles).toHaveLength(1);
    expect(report.briefId).toBe(`brief-${jobId}`);
    const use = report.runbooksUsed.find((u) => u.id === 'rb-flaky-test-rerun-diff');
    expect(use).toMatchObject({ source: 'observed' });
    expect(use!.version).toEqual(expect.any(Number));
    const apps = await runbookStore().listApplications('rb-flaky-test-rerun-diff');
    const mine = apps.filter((a) => a.run_ref === jobId);
    expect(mine).toEqual([expect.objectContaining({ outcome: 'followed', brief_id: `brief-${jobId}`, version: use!.version })]);
    expect(runbookHealth(apps, use!.version!, Date.parse(clock.nowIso())).status).toBe('proven');
  });

  it('a run that teaches something: obstacles carry the lesson, nothing was used', async () => {
    const { report } = await dispatch('wi-auth-e2-b3');
    expect(report.outcome).toBe('done');
    expect(report.runbooksUsed).toEqual([]);
    expect(report.obstacles.join(' ')).toMatch(/Domain and Path/);
  });

  it('a run that needed nothing', async () => {
    const { report } = await dispatch('wi-obs-e2-s3');
    expect(report).toMatchObject({ outcome: 'done', obstacles: [], runbooksUsed: [], selfReport: 'ok' });
    expect(report.summary).toMatch(/Error-budget dashboard per team/);
  });

  it('a failed run: the job, the report and the code all say so', async () => {
    const { jobId, report } = await dispatch('wi-inf-e1-b3');
    expect(report).toMatchObject({ outcome: 'failed', failureCode: 'needs_gpu_pool' });
    expect((await getJob(jobId))!.status).toBe('failed');
  });

  it('reports are listed for the work item and for the initiative; a run with no report is a 404', async () => {
    const { jobId } = await dispatch('wi-obs-e2-s3');
    const byItem = await request(app()).get('/api/work-items/wi-obs-e2-s3/run-reports');
    expect(byItem.body.reports.map((r: RunReport) => r.runRef)).toContain(jobId);
    const byInit = await request(app()).get('/api/initiatives/p-observability/run-reports');
    expect(byInit.body.reports.map((r: RunReport) => r.runRef)).toContain(jobId);
    expect((await request(app()).get('/api/initiatives/p-zero-trust/run-reports')).body.reports).toEqual([]);
    const none = await request(app()).get('/api/runs/job-nope/report');
    expect(none.status).toBe(404);
    expect(none.body.code).toBe('NO_REPORT');
  });
});
