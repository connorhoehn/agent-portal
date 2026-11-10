// POST /api/bots/dispatch-work in dev:mock, end to end through the REAL
// providers (not seam-mocked) — org-leader.md defect #3.
//
// bots-dispatch.test.ts pins the gate ORDER with every provider mocked. This
// pins the actual dev:mock behavior an operator hits: as Vera (org-leader) on
// Observability Platform's "Error-budget dashboard per team" story, Authorize
// used to 400 with "no codebase delivers this initiative" because
// listAgentProjects() returned `[]` in mock mode while the initiative header
// showed the very same repo. That is fixed structurally (agent-projects.ts
// MOCK_AGENT_PROJECTS, mirroring schema/seed_program.sql). This proves the
// request now reaches a money gate (409 naming it) instead of the codebase
// refusal — the bar CLAUDE.md's task set for "fixed".

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
// Bypass session/capability gating — this suite is about the dispatch gates
// downstream of auth, not auth itself (pinned elsewhere).
jest.mock('../../lib/authz.js', () => ({
  readForRolesElseAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireSession: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// The devbox runtime genuinely is not deployed in this test process — force
// the same fast, clean "not deployed" answer resolveDevboxArn gives against a
// real AWS account with no devbox stack, instead of a live network call.
jest.mock('../../lib/devbox-arn.js', () => ({
  resolveDevboxArn: jest.fn(async () => null),
  devboxDataClient: jest.fn(),
}));
// Modules this suite does not exercise, stubbed only so the route module
// graph loads under the CJS test transform (several use import.meta) — same
// stub set as bots-dispatch.test.ts. providers/{work-items,agent-projects,
// budgets,bots} and lib/bot-runner are deliberately REAL: this test is about
// what those actually do together in mock mode, not their call order.
jest.mock('../../lib/sdlc-pipeline.js', () => ({ dispatchGovernedRun: jest.fn() }));
jest.mock('../../lib/project-runner.js', () => ({ runDevboxShell: jest.fn() }));
// The fleet registry is in-memory and harmless, but stubbing it keeps this
// suite from depending on box bookkeeping it does not assert. registerBox has
// to hand back a box, because the offline dispatch records its id on the run.
jest.mock('../../lib/devbox-fleet.js', () => ({
  registerBox: jest.fn((opts: { sessionId: string }) => ({ id: 'box-test', sessionId: opts.sessionId })),
  getBoxBySession: jest.fn(() => null),
  appendEvent: jest.fn(),
}));
jest.mock('../../lib/bot-scheduler.js', () => ({ registerBot: jest.fn(), unregisterBot: jest.fn() }));
jest.mock('../../lib/ingest-scheduler.js', () => ({ validateCronExpr: jest.fn(() => true) }));
// providers/agent-jobs is deliberately REAL now: the offline dispatch enqueues
// a job and walks it through the queue's own states, so a stub here would be
// stubbing the thing under test.

import express from 'express';
import request from '../../test-support/http.js';
import { botsRouter } from '../bots.js';
import { errorHandler } from '../../lib/async-handler.js';
import { __setMockDispatchStepMs } from '../../lib/bot-runner.js';
import { __resetMockRuns } from '../../providers/bots.js';
import { getJob } from '../../providers/agent-jobs.js';
import { createMockScope, deleteMockScope, runInMockScope } from '../../mock/core/scope.js';
import { registerBox } from '../../lib/devbox-fleet.js';

// Run the simulated dispatch's state progression synchronously — the seam
// exists so a test never sleeps through it. It also matters for ordering here: a
// dispatch that settles before the response returns hands the work item back,
// so the next case re-claims it cleanly instead of 409ing on the last one.
beforeAll(() => __setMockDispatchStepMs(0));
afterAll(() => __setMockDispatchStepMs(2_000));
beforeEach(() => __resetMockRuns());

function buildApp(scope?: ReturnType<typeof createMockScope>) {
  const app = express();
  app.use(express.json());
  // The real scope middleware runs the rest of the request inside the scope.
  if (scope) app.use((_req, _res, next) => { runInMockScope(scope, next); });
  app.use((req, _res, next) => {
    // Vera Green, org-leader — the exact persona/role DEFECTS.md #3 repros.
    (req as unknown as { session: unknown }).session = { sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' };
    next();
  });
  app.use('/api/bots', botsRouter);
  app.use(errorHandler);
  return app;
}

const BODY = { workItemId: 'wi-obs-e2-s3', model: 'us.amazon.nova-lite-v1:0' };

describe('POST /api/bots/dispatch-work — Vera on Observability Platform (dev:mock)', () => {
  it('never answers the codebase 400 the initiative header contradicts', async () => {
    const res = await request(buildApp()).post('/api/bots/dispatch-work').send(BODY);
    // `?? ''` because the request now SUCCEEDS and carries no error at all —
    // toMatch on undefined is a matcher error, which would fail this for the
    // opposite of the reason it exists.
    expect(String(res.body.error ?? '')).not.toMatch(/no codebase delivers this initiative/);
  });

  it('reaches a money gate (409 naming it) when a tight per-run budget is set', async () => {
    const res = await request(buildApp()).post('/api/bots/dispatch-work')
      .send({ ...BODY, budgetPerRunUsd: 0.01 });
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('run-budget');
    expect(res.body.confirmFlag).toBe('confirmOverRunBudget');
  });

  it('produces a real run when every money gate clears, instead of the old 503', async () => {
    // p-observability's allocation has headroom (MOCK_BUDGETS) and an
    // org-leader carries no sprint envelope to brake against, so this run
    // clears every money gate. It used to die here with
    // "the devbox runtime is not deployed" — the gates were demonstrable
    // offline and their outcome was not.
    const res = await request(buildApp()).post('/api/bots/dispatch-work').send(BODY);
    expect(res.status).toBe(202);
    expect(res.body.run).toMatchObject({
      botId: null,
      trigger: 'marketplace',
      workItemId: 'wi-obs-e2-s3',
      // Attribution comes from the session subject, never the body.
      dispatchedBy: 'u-vera',
    });
    expect(res.body.run.jobId).toMatch(/^job-/);
    const job = await getJob(res.body.run.jobId);
    expect(job?.payload).toMatchObject({
      workItemId: BODY.workItemId, workItemTitle: 'Error-budget dashboard per team',
      initiativeId: 'p-observability', initiativeName: 'Observability Platform',
    });
  });

  it('registers no computer when the request runs in a scoped mock world', async () => {
    // Computers are ephemeral and the fleet registry is one Map no scope
    // forks: a scoped walk must neither create nor depend on one.
    const scope = createMockScope({ base: 'default' } as never);
    try {
      (registerBox as jest.Mock).mockClear();
      const res = await request(buildApp(scope)).post('/api/bots/dispatch-work').send(BODY);
      expect(res.status).toBe(202);
      expect(registerBox).not.toHaveBeenCalled();
      expect(res.body.run.jobId).toMatch(/^job-/);
    } finally {
      deleteMockScope(scope.id);
    }
  });
});
