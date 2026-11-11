// Giving runbooks to a run, on the mock (docs/learning-loop-design.md stage 4
// and 5; acceptance items 4, 5, 6 and 8), through the real routes and the
// Halyard story's fixtures:
//
//   4  a related Auth Migration work item's brief preview lists rb-tenant-cutover
//      with a readable reason before dispatch; a pinned runbook appears first
//   5  dispatched, the run's frozen brief carries the runbook's text and offer
//   6  the runbook's evidence lists that run and its health is proven; the loop's
//      evidence line counts it
//   8  the cold-start bug fails; dispatched again, its brief shows the first
//      attempt's outcome and obstacles under previous attempts
//
// Plus the pins route: the item's people only, published runbooks the item's
// scope admits only.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => {
  const actual = jest.requireActual('../../lib/authz.js');
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...actual, readForRolesElseAction: pass, requireAction: pass, requireSession: pass, requireTenant: pass };
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
import { workItemsRouter } from '../work-items.js';
import { createSessionBriefsRouter } from '../session-briefs.js';
import { createRunbooksRouter } from '../runbooks.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __setMockDispatchStepMs } from '../../lib/bot-runner.js';
import { __resetMockRuns } from '../../providers/bots.js';
import { runbookStore } from '../../lib/runbooks/store-select.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { RunReport } from '../../lib/run-reports/types.js';
import type { SessionBrief } from '../../lib/runbooks/types.js';

beforeAll(() => __setMockDispatchStepMs(0));
afterAll(() => __setMockDispatchStepMs(2_000));
beforeEach(() => { fixtureRegistry.resetAll(); __resetMockRuns(); });

type Who = { sub: string; role: string };
const VERA: Who = { sub: 'u-vera', role: 'org-leader' };

function app(who: Who = VERA) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { sub: who.sub, role: who.role, tenant: 'orgiq', grants: { orgiq: [who.role] } };
    next();
  });
  a.use('/api/bots', botsRouter);
  a.use('/api/graph', workItemsRouter);
  a.use('/api/runbooks', createRunbooksRouter({ store: () => runbookStore() }));
  a.use('/api', createSessionBriefsRouter({ store: () => runbookStore() }));
  a.use(errorHandler);
  return a;
}

async function dispatch(workItemId: string): Promise<{ jobId: string; report: RunReport; brief: SessionBrief }> {
  const res = await request(app()).post('/api/bots/dispatch-work').send({ workItemId, model: 'us.amazon.nova-lite-v1:0' });
  expect(res.status).toBe(202);
  const jobId = res.body.run.jobId as string;
  const got = await request(app()).get(`/api/runs/${jobId}/report`);
  expect(got.status).toBe(200);
  const brief = await request(app()).get(`/api/runs/${jobId}/brief`);
  expect(brief.status).toBe(200);
  return { jobId, report: got.body.report as RunReport, brief: brief.body.brief as SessionBrief };
}

describe('acceptance 4: the brief preview lists the runbook a run will get, with its reason, and a pin goes first', () => {
  it('a related Auth Migration item is given rb-tenant-cutover for its labels and words', async () => {
    const res = await request(app()).get('/api/work-items/wi-auth-e2-s2/brief-preview');
    expect(res.status).toBe(200);
    const first = res.body.offer.runbooks[0];
    expect(first).toMatchObject({ id: 'rb-tenant-cutover', pinned: false, title: 'Cut one tenant over from SAML to Cognito' });
    expect(first.reason).toMatch(/^labels decom, runbook; shares .*tenant.*cutover/);
    expect(first.reason).not.toMatch(/p-auth-migration|wi-/); // readable: no record ids
    expect(res.body.pins).toEqual([]);
  });

  it('pin a second runbook: it appears first, and the pin is stored on the item', async () => {
    const put = await request(app()).put('/api/graph/work-items/wi-auth-e2-s2/runbook-pins').send({ runbookIds: ['rb-sso-new-origin'] });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ workItemId: 'wi-auth-e2-s2', runbookPins: ['rb-sso-new-origin'] });
    const res = await request(app()).get('/api/work-items/wi-auth-e2-s2/brief-preview');
    expect(res.body.pins).toEqual(['rb-sso-new-origin']);
    expect(res.body.offer.runbooks.map((r: { id: string; pinned: boolean }) => [r.id, r.pinned]))
      .toEqual([['rb-sso-new-origin', true], ['rb-tenant-cutover', false]]);
    // Cleared with [].
    expect((await request(app()).put('/api/graph/work-items/wi-auth-e2-s2/runbook-pins').send({ runbookIds: [] })).body.runbookPins).toEqual([]);
  });
});

describe('the pins route', () => {
  const put = (body: unknown, who: Who = VERA, id = 'wi-auth-e2-s2') => request(app(who)).put(`/api/graph/work-items/${id}/runbook-pins`).send(body as object);

  it('refuses ids that are not runbooks, are not published, or are scoped elsewhere', async () => {
    expect((await put({ runbookIds: ['rb-nope'] })).body).toMatchObject({ code: 'UNKNOWN_RUNBOOK', runbookId: 'rb-nope' });
    // rb-tenant-cutover is scoped to Auth Migration: an Observability item cannot pin it.
    const other = await put({ runbookIds: ['rb-tenant-cutover'] }, VERA, 'wi-obs-e2-s3');
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: 'OUT_OF_SCOPE', runbookId: 'rb-tenant-cutover' });
    // A retired runbook cannot be pinned.
    const s = runbookStore();
    const rb = (await s.getRunbook('rb-sso-new-origin'))!;
    await s.putRunbook({ ...rb, status: 'retired', updated_at: '2099-01-01T00:00:00.000Z' }, rb.updated_at);
    expect((await put({ runbookIds: ['rb-sso-new-origin'] })).body).toMatchObject({ code: 'NOT_PUBLISHED', runbookId: 'rb-sso-new-origin' });
  });

  it('refuses a malformed body: not a list, a bad id, a repeat, too many, an unknown field', async () => {
    expect((await put({ runbookIds: 'rb-tenant-cutover' })).status).toBe(400);
    expect((await put({ runbookIds: ['not an id'] })).status).toBe(400);
    expect((await put({ runbookIds: ['rb-tenant-cutover', 'rb-tenant-cutover'] })).status).toBe(400);
    expect((await put({ runbookIds: ['rb-a1', 'rb-a2', 'rb-a3', 'rb-a4', 'rb-a5', 'rb-a6'] })).status).toBe(400);
    expect((await put({ runbookIds: [], extra: 1 })).status).toBe(400);
    expect((await request(app()).put('/api/graph/work-items/wi-nope/runbook-pins').send({ runbookIds: [] })).status).toBe(404);
  });

  it("is the item's initiative's people's call: someone off the initiative is refused", async () => {
    const res = await put({ runbookIds: ['rb-tenant-cutover'] }, { sub: 'u-mia', role: 'member' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_ON_INITIATIVE');
  });
});

describe('acceptance 5 and 6: the run gets the text; the runbook and the loop count it', () => {
  it('the frozen brief carries the runbook text and its offer; the evidence lists the run; health is proven', async () => {
    const { jobId, report, brief } = await dispatch('wi-auth-e2-s2');
    expect(brief.offer!.runbooks[0]).toMatchObject({ id: 'rb-tenant-cutover', version: 1 });
    expect(brief.markdown).toMatch(/<untrusted-[0-9a-f]{32} kind="runbook" source="rb-tenant-cutover v1">\n# Cut one tenant over from SAML to Cognito/);
    expect(report.runbooksOffered).toEqual(expect.arrayContaining([{ id: 'rb-tenant-cutover', version: 1 }]));
    expect(report.runbooksUsed.map((u) => u.id)).toContain('rb-tenant-cutover');

    const ev = await request(app()).get('/api/runbooks/rb-tenant-cutover/evidence');
    expect(ev.status).toBe(200);
    expect(ev.body.health.status).toBe('proven');
    expect(ev.body.evidence).toMatchObject({ runbookId: 'rb-tenant-cutover', windowDays: 30, given: 1, loaded: 1, outcomes: { done: 1 } });
    expect(ev.body.evidence.runs).toEqual([expect.objectContaining({ runRef: jobId, workItemId: 'wi-auth-e2-s2', outcome: 'done', version: 1, loaded: true })]);
    expect(ev.body.evidence.comparison).toMatchObject({ available: false, withRunbookRuns: 1 });

    const loop = await request(app()).get('/api/runbooks/evidence');
    expect(loop.status).toBe(200);
    expect(loop.body.evidence).toMatchObject({ windowDays: 30, runsGiven: 1 });
    expect(loop.body.evidence.runbooks).toEqual(expect.arrayContaining([expect.objectContaining({ runbookId: 'rb-tenant-cutover', given: 1 })]));
    expect((await request(app()).get('/api/runbooks/rb-nope/evidence')).status).toBe(404);
  });

  it('acceptance 7 (the offer half): the dashboard item is given nothing, and the brief says why', async () => {
    const { brief, report } = await dispatch('wi-obs-e2-s3');
    expect(brief.offer).toEqual({ runbooks: [], none_reason: expect.any(String) });
    expect(brief.markdown).toContain('## Runbooks for this run\nNone were given.');
    expect(report.runbooksOffered).toEqual([]);
  });
});

describe('acceptance 8: a second attempt sees the first', () => {
  it("the cold-start bug fails; dispatched again, its brief shows the first attempt's outcome and obstacles", async () => {
    const first = await dispatch('wi-inf-e1-b3');
    expect(first.report.outcome).toBe('failed');
    expect(first.brief.previous_attempts).toEqual([]);
    const second = await dispatch('wi-inf-e1-b3');
    expect(second.brief.previous_attempts).toEqual([{ run_ref: first.jobId, outcome: 'failed', failure_code: 'needs_gpu_pool', ended_at: first.report.endedAt }]);
    expect(second.brief.markdown).toContain(`### 1. Failed, ${first.report.endedAt.slice(0, 10)} (run ${first.jobId})`);
    expect(second.brief.markdown).toMatch(/kind="previous-attempt"[^>]*>\nFailure code: needs_gpu_pool\nSummary: Stopped before changing anything[\s\S]*Obstacles:\n- The cold-start test waits for a GPU node/);
    const preview = await request(app()).get('/api/work-items/wi-inf-e1-b3/brief-preview');
    expect(preview.body.previous_attempts.map((a: { run_ref: string }) => a.run_ref)).toEqual([second.jobId, first.jobId]);
  });
});
