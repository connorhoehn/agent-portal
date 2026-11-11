// The four story work items, dispatched through the governed path against the mock's fake microVM
// (docs/learning-loop-design.md, "The mock"; decision 19). Nothing here forces the simulated branch:
// the run checks out a workspace, the fake devbox's final message carries the fixture's `lab-report`
// block, `recordRunEnd` reads it as it reads a real run's, and a debrief the report earns goes through
// `debriefOnBox` to the fake's `debrief` op and then `settleDebrief`.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', accountId: '', auth: { sessionSigningSecretArn: '' }, mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => {
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { readForRolesElseAction: pass, requireAction: pass, requireSession: pass, requireTenant: pass };
});
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));

import express from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { createSessionBriefsRouter } from '../session-briefs.js';
import { errorHandler } from '../../lib/async-handler.js';
import { reconcileBotRuns } from '../../lib/bot-runner.js';
import { __resetMockRuns } from '../../providers/bots.js';
import { updateWorkItem } from '../../providers/work-items.js';
import { runbookStore } from '../../lib/runbooks/store-select.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { _arnInternal } from '../../lib/devbox-arn.js';
import { recordedShellCommands } from '../../mock/devbox-shell.js';
import { simulatedRunFixture } from '../../mock/run-report-fixtures.js';
import type { RunReport } from '../../lib/run-reports/types.js';

beforeEach(() => { fixtureRegistry.resetAll(); __resetMockRuns(); _arnInternal.reset(); });

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Dispatch a work item and wait for its run's report, and for its debrief to settle when one was asked for. */
async function dispatch(workItemId: string): Promise<{ ref: string; report: RunReport }> {
  const res = await request(app()).post('/api/bots/dispatch-work').send({ workItemId, model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
  expect({ status: res.status, body: res.status === 202 ? null : res.body }).toEqual({ status: 202, body: null });
  const ref = (res.body.run.runId ?? res.body.run.jobId) as string;
  for (let i = 0; i < 200; i++) {
    const got = await request(app()).get(`/api/runs/${ref}/report`);
    const report = got.status === 200 ? got.body.report as RunReport : null;
    if (report && report.debrief?.state !== 'requested') return { ref, report };
    await sleep(25);
  }
  throw new Error(`no settled report for ${ref}`);
}

describe('a dispatch on the fake microVM ends with the work item\'s fixture', () => {
  it('the logout bug: its report is the fixture, and its debrief files the hand-written runbook as demo data', async () => {
    const fx = simulatedRunFixture({ title: 'Logout leaves the legacy shim cookie alive', labels: ['session', 'decom'] });
    const { ref, report } = await dispatch('wi-auth-e2-b3');
    // The governed path ran: a checkout was made and the tree was measured.
    expect(recordedShellCommands().join('\n')).toMatch(/git clone|status --porcelain/);
    expect(report).toMatchObject({
      runRef: ref, executor: 'governed', workItemId: 'wi-auth-e2-b3', initiativeId: 'p-auth-migration',
      selfReport: 'ok', cost: { basis: 'simulated' }, summary: fx.summary, verification: fx.verification,
      obstacles: fx.obstacles, learned: fx.learned,
    });
    expect(['done', 'needs-review']).toContain(report.outcome);
    expect(report.debrief).toMatchObject({ state: 'filed', simulated: true, proposalKind: 'new', reason: null });
    const p = await runbookStore().getProposal(report.debrief!.proposalId!);
    expect(p).toMatchObject({
      kind: 'new', status: 'open', proposed_id: 'rb-logout-shim-cookie',
      source: { kind: 'run', run_ref: ref, work_item_id: 'wi-auth-e2-b3' },
      proposed_scope: { kind: 'repo', ref: 'connorhoehn/orgiq-auth-service' },
      debrief: { run_ref: ref, answer_kind: 'new', simulated: true },
    });
    expect(p!.lint.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('the tenant cutover: it says it followed the runbook it was given, and learned nothing', async () => {
    const { report } = await dispatch('wi-auth-e2-s2');
    const fx = simulatedRunFixture({ title: 'Tenant-by-tenant cutover runbook with rollback', labels: ['decom', 'runbook', 'blocked'], projectId: 'p-auth-migration' });
    expect(report).toMatchObject({ summary: fx.summary, obstacles: fx.obstacles, cost: { basis: 'simulated' }, selfReport: 'ok' });
    expect(report.runbookAccounts).toEqual([expect.objectContaining({ id: 'rb-tenant-cutover', followed: 'yes' })]);
    expect(report.runbooksUsed.find((u) => u.id === 'rb-tenant-cutover')).toMatchObject({ source: 'observed' });
    expect(report.debrief).toMatchObject({ state: 'skipped', reason: 'nothing-learned' });
  });

  it('the dashboard item: given nothing, nothing learned, so no debrief, with the stored sentence', async () => {
    const { report } = await dispatch('wi-obs-e2-s3');
    expect(report).toMatchObject({ obstacles: [], runbooksUsed: [], selfReport: 'ok', cost: { basis: 'simulated' } });
    expect(report.debrief).toMatchObject({ state: 'skipped', reason: 'nothing-learned' });
    expect(report.debrief!.reasonText).toEqual(expect.any(String));
  });

  it('the cold-start bug: it failed before changing anything, and the report says so', async () => {
    const fx = simulatedRunFixture({ title: 'Cold-start p99 breaches SLA after scale-to-zero', labels: ['latency'], projectId: 'p-inference-platform' });
    const { report } = await dispatch('wi-inf-e1-b3');
    expect(report).toMatchObject({ outcome: 'failed', summary: fx.summary, obstacles: fx.obstacles, cost: { basis: 'simulated' } });
    expect(report.failureCode).toMatch(/^needs_gpu_pool/);
    expect(report.debrief).toMatchObject({ state: 'skipped', reason: 'not-successful' });
    expect(report.changes).toEqual({ files: [], changeRequestId: null });
  });

  it('a second logout run, with the logout runbook not yet accepted, still debriefs by the same path', async () => {
    const first = await dispatch('wi-auth-e2-b3');
    expect(first.report.debrief?.state).toBe('filed');
    // What the reconcile tick does once the first run's change is in review and its bot run is settled.
    await reconcileBotRuns();
    await updateWorkItem('wi-auth-e2-b3', { status: 'open' });
    const second = await dispatch('wi-auth-e2-b3');
    expect(['filed', 'skipped']).toContain(second.report.debrief?.state);
  });
});
