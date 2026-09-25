// The whole marketplace journey in dev:mock, from Authorize to a completion
// two other surfaces can see.
//
// bots-dispatch.test.ts pins the gate ORDER with every provider seam-mocked;
// bots-dispatch-mock-mode.test.ts pins that the gates behave offline and that
// a cleared dispatch now answers 202 instead of
// "the devbox runtime is not deployed". This one pins the part nobody had ever
// audited, because until now nothing offline could get past that 503: what a
// SUCCESSFUL dispatch actually leaves behind.
//
//   gates pass → a bot_run with honest attribution
//              → an agent_jobs row resolvable at /api/work/jobs/:id
//              → the job walks queued → claimed → running → done
//              → the Work queue and the initiative's activity graph both see it
//
// Everything below the router is REAL (providers/{bots,agent-jobs,work-items,
// agent-projects,budgets,activity}, lib/bot-runner). The only stubs are
// modules this journey does not exercise and which the CJS test transform
// cannot load, plus the fleet registry.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../lib/devbox-arn.js', () => ({
  resolveDevboxArn: jest.fn(async () => null),
  devboxDataClient: jest.fn(),
}));
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
jest.mock('../../lib/devbox-fleet.js', () => ({
  registerBox: jest.fn((opts: { sessionId: string }) => ({ id: 'box-journey', sessionId: opts.sessionId })),
  getBoxBySession: jest.fn(() => null),
  appendEvent: jest.fn(),
}));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));
jest.mock('../../lib/job-dispatcher.js', () => ({
  dispatcherEvents: { on: jest.fn(), off: jest.fn(), emit: jest.fn() },
  dispatchOnce: jest.fn(),
  busyBoxes: jest.fn(() => []),
}));
jest.mock('../../lib/work-suggestions.js', () => ({ suggestWork: jest.fn(async () => []) }));

import express, { type Express } from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { workRouter } from '../work.js';
import { workItemsRouter } from '../work-items.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __setMockDispatchStepMs } from '../../lib/bot-runner.js';
import { __resetMockRuns } from '../../providers/bots.js';
import { botRuns } from '../../mock/bots.js';
import { getWorkItem, updateWorkItem } from '../../providers/work-items.js';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Vera Green, org-leader — the release manager the audit ran as. She holds
    // no sprint grant, so the envelope brake does not apply and the allocation
    // brake is the last money gate this dispatch meets.
    (req as unknown as { session: unknown }).session = { sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' };
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use('/api/work', workRouter);
  app.use('/api/graph', workItemsRouter);
  app.use(errorHandler);
  return app;
}

const ITEM_ID = 'wi-obs-e2-s3';        // Observability Platform, open story, 3 pts
const PROJECT_ID = 'p-observability';
const BODY = { workItemId: ITEM_ID, model: 'us.amazon.nova-lite-v1:0' };

/** Put the seeded item back so each case starts from the same board. */
async function restoreItem(): Promise<void> {
  await updateWorkItem(ITEM_ID, { status: 'open' });
}

beforeEach(async () => {
  __resetMockRuns();
  // This journey counts its OWN dispatches against the ceiling and the
  // initiative's run list, so it starts from a fleet with nothing in flight:
  // the default world's two seeded marketplace runs on this same initiative
  // (mock/bots.ts `inFlightMarketplaceRuns`) would take two of the three slots
  // and turn "already being worked" (409) into "ceiling reached" (429).
  // The ceiling's view of those seeded rows is pinned in
  // providers/__tests__/projects-initiatives-fixture.test.ts.
  botRuns.reset();
  const seeded = botRuns.rows();
  for (let i = seeded.length - 1; i >= 0; i -= 1) if (seeded[i]!.botId === null) seeded.splice(i, 1);
  await restoreItem();
});
afterEach(() => __setMockDispatchStepMs(2_000));
afterAll(() => botRuns.reset());

describe('a marketplace dispatch, end to end in dev:mock', () => {
  it('leaves a run, a job, a settled item and spend the activity graph sees', async () => {
    __setMockDispatchStepMs(0);       // settle before the response returns
    const app = buildApp();

    // ── The dispatch itself ──────────────────────────────────────────────
    const dispatch = await request(app).post('/api/bots/dispatch-work').send(BODY);
    expect(dispatch.status).toBe(202);
    const run = dispatch.body.run as {
      id: string; botId: string | null; trigger: string; jobId: string;
      workItemId: string; dispatchedBy: string; outcome: Record<string, unknown>;
    };

    // A marketplace run has no bot behind it, and its attribution is the
    // session subject — the string a sprint envelope would burn down against.
    expect(run.botId).toBeNull();
    expect(run.trigger).toBe('marketplace');
    expect(run.workItemId).toBe(ITEM_ID);
    expect(run.dispatchedBy).toBe('u-vera');
    // Said on the row, so no surface mistakes a simulated run's cost for a bill.
    expect(run.outcome['simulated']).toBe(true);

    // ── The job is resolvable by id, in the shape Aurora mints ───────────
    // `job-<uuid>` is agent_jobs.id's own DEFAULT; the mock used to mint
    // `job-mock-N`, an id no cluster could hold, so the same "job →" link
    // worked offline and 404'd for real.
    expect(run.jobId).toMatch(/^job-[0-9a-f-]{36}$/);
    const job = await request(app).get(`/api/work/jobs/${run.jobId}`);
    expect(job.status).toBe(200);
    expect(job.body).toMatchObject({
      id: run.jobId, kind: 'devbox:task', createdBy: 'u-vera', status: 'done',
    });
    // The payload is fireBot's, minus botId — there is no standing mission here.
    expect(job.body.payload).toMatchObject({ model: 'us.amazon.nova-lite-v1:0', requiresReview: false });
    expect(job.body.payload.botId).toBeUndefined();

    // ── The Work queue sees the completion ───────────────────────────────
    const queue = await request(app).get('/api/work/jobs?limit=200');
    expect(queue.status).toBe(200);
    const queued = (queue.body.jobs as { id: string; status: string }[]).find((j) => j.id === run.jobId);
    expect(queued?.status).toBe('done');

    // ── The initiative's activity graph sees the run and its spend ───────
    const series = await request(app).get(`/api/graph/projects/${PROJECT_ID}/activity/series?days=30`);
    expect(series.status).toBe(200);
    const today = series.body.series as { runs: number[]; spendUsd: number[] };
    const lastRuns = today.runs[today.runs.length - 1] as number;
    const lastSpend = today.spendUsd[today.spendUsd.length - 1] as number;
    expect(lastRuns).toBeGreaterThanOrEqual(1);
    expect(lastSpend).toBeGreaterThan(0);

    // ── And the run is on the initiative's marketplace list ──────────────
    const runs = await request(app).get(`/api/bots/marketplace-runs?orgProjectId=${PROJECT_ID}`);
    expect(runs.status).toBe(200);
    expect((runs.body.runs as { id: string; status: string; costUsd: number }[])).toContainEqual(
      expect.objectContaining({ id: run.id, status: 'done', costUsd: expect.any(Number) as number }),
    );

    // ── The work item ends where the real path ends it ───────────────────
    // Back to `open`, which is reconcileBotRuns' own "done but nothing
    // captured" branch: a simulated run checks nothing out, so there is no
    // change request for `in_review` to point at and nothing anyone
    // delivered. It also makes the journey repeatable.
    const settled = await getWorkItem(ITEM_ID);
    expect(settled?.status).toBe('open');
    expect(settled?.completedAt).toBeNull();
  });

  it('walks the job through its states rather than arriving terminal', async () => {
    __setMockDispatchStepMs(15);       // short, but three observable hops
    const app = buildApp();

    const dispatch = await request(app).post('/api/bots/dispatch-work').send(BODY);
    expect(dispatch.status).toBe(202);
    const jobId = dispatch.body.run.jobId as string;

    // The route answers the moment the run exists, so the job has not finished
    // — the state an operator watching the queue actually sees first. Either
    // non-terminal state counts: pinning this to exactly `queued` would also
    // assert that this process wins a race against its own dispatcher, which
    // holds on an idle machine and fails on a loaded one (seen failing with
    // `claimed` under three parallel suites, passing alone seconds later).
    const first = await request(app).get(`/api/work/jobs/${jobId}`);
    expect(['queued', 'claimed']).toContain(first.body.status);

    const seen = new Set<string>([first.body.status as string]);
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const poll = await request(app).get(`/api/work/jobs/${jobId}`);
      seen.add(poll.body.status as string);
      if (poll.body.status === 'done') break;
    }
    expect(seen.has('done')).toBe(true);
    expect([...seen].some((st) => st === 'queued' || st === 'claimed' || st === 'running')).toBe(true);
    // The intermediate hops are what "a progression" means: a job that went
    // straight from queued to done would satisfy every other assertion here.
    expect(seen.has('claimed') || seen.has('running')).toBe(true);

    const item = await getWorkItem(ITEM_ID);
    expect(item?.status).toBe('open');
  });

  it('claims the item while the run is in flight, so a second dispatch is refused', async () => {
    __setMockDispatchStepMs(400);      // long enough to still be running below
    const app = buildApp();

    const first = await request(app).post('/api/bots/dispatch-work').send(BODY);
    expect(first.status).toBe(202);
    expect((await getWorkItem(ITEM_ID))?.status).toBe('in_progress');

    const second = await request(app).post('/api/bots/dispatch-work').send(BODY);
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already being worked/);
  });

  it('still refuses at the gates — a cleared dispatch is the only one that runs', async () => {
    __setMockDispatchStepMs(0);
    const app = buildApp();

    // The per-run cap, the cheapest and most personal gate, unchanged.
    const braked = await request(app).post('/api/bots/dispatch-work')
      .send({ ...BODY, budgetPerRunUsd: 0.01 });
    expect(braked.status).toBe(409);
    expect(braked.body).toMatchObject({ gate: 'run-budget', confirmFlag: 'confirmOverRunBudget' });

    // A braked dispatch leaves nothing behind: no run, no job, and the item
    // untouched — the gate runs before the claim.
    expect((await getWorkItem(ITEM_ID))?.status).toBe('open');
    const runs = await request(app).get(`/api/bots/marketplace-runs?orgProjectId=${PROJECT_ID}`);
    expect(runs.body.runs).toHaveLength(0);

    // Confirming the flag it named lets exactly that dispatch through.
    const confirmed = await request(app).post('/api/bots/dispatch-work')
      .send({ ...BODY, budgetPerRunUsd: 0.01, confirmOverRunBudget: true });
    expect(confirmed.status).toBe(202);
  });

  it('holds the concurrency ceiling offline, which used to count 0 forever', async () => {
    __setMockDispatchStepMs(2_000);    // the runs stay in flight
    const app = buildApp();
    // BOT_MAX_CONCURRENT defaults to 3; four distinct open items on this
    // initiative would be needed to exceed it, so pin the ceiling at 1 and use
    // two items instead of loosening anything.
    const previous = process.env['BOT_MAX_CONCURRENT'];
    process.env['BOT_MAX_CONCURRENT'] = '1';
    try {
      const first = await request(app).post('/api/bots/dispatch-work').send(BODY);
      expect(first.status).toBe(202);

      const other = await request(app).post('/api/bots/dispatch-work')
        .send({ ...BODY, workItemId: 'wi-obs-e3-s1' });
      expect(other.status).toBe(429);
      // Refused before any side effect: the second item was never claimed.
      expect((await getWorkItem('wi-obs-e3-s1'))?.status).toBe('open');
    } finally {
      if (previous === undefined) delete process.env['BOT_MAX_CONCURRENT'];
      else process.env['BOT_MAX_CONCURRENT'] = previous;
    }
  });
});
