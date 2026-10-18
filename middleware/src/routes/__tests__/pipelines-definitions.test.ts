// The pipelines tenant's P2 routes (docs/pipelines-tenant-goal.md §P2):
// definitions, the runbook dry-run, runbooks, approvals, cancel and the
// configuration — each behind its Cedar action, over the registered fixtures
// dev:mock serves. The dry-run is followed end to end: enqueued on the
// EXISTING queue, closed by the queue's own completion path, and then the
// promotion to SKILL it unlocks.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'author', tenant: 'pipelines', label: 'Author', summary: '', capabilities: ['ViewPipelines', 'AuthorDefinition', 'RunPipeline'] },
    { id: 'operator', tenant: 'pipelines', label: 'Operator', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun'] },
    { id: 'pipeline-admin', tenant: 'pipelines', label: 'Pipeline Admin', summary: '', capabilities: ['ViewPipelines', 'RunPipeline', 'ApproveStep', 'CancelRun', 'ManagePipelineConfig', 'ManageUsers'] },
  ],
}));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { pipelinesRouter } from '../pipelines.js';
import { requireTenant } from '../../lib/authz.js';
import { errorHandler } from '../../lib/async-handler.js';
import { type Role, type Session, type Tenant } from '../../lib/session.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { mockJobs } from '../../mock/agent-jobs.js';
import { completeJob } from '../../providers/agent-jobs.js';
import { promoteCandidate } from '../../providers/promotions.js';
import { pipelineRunRecords } from '../../mock/pipeline-definitions.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';

function appAs(session: Partial<Session>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { sub: 'u-test', iat: 0, grants: {}, ...session } as Session;
    next();
  });
  app.use('/api/pipelines', requireTenant('pipelines'), pipelinesRouter);
  app.use(errorHandler);
  return app;
}

const as = (role: Role, sub: string) => appAs({ role, tenant: 'pipelines' as Tenant, sub });
const ines = () => as('author', 'u-ines');
const kofi = () => as('operator', 'u-kofi');
const dara = () => as('pipeline-admin', 'u-dara');
const RUNBOOK = 'runbook:promo-aurora-cold-start';
const enc = encodeURIComponent;

afterEach(() => fixtureRegistry.resetAll('default'));

describe('GET /api/pipelines/definitions', () => {
  it('lists every producer as a definition, with run facts selected from the projection', async () => {
    const res = await request(kofi()).get('/api/pipelines/definitions');
    expect(res.status).toBe(200);
    const kinds = new Set((res.body.definitions as Array<{ kind: string }>).map((d) => d.kind));
    expect([...kinds].sort()).toEqual(['agent', 'assessment-command', 'bot', 'runbook']);
    expect(res.body.total).toBe(res.body.definitions.length);
    expect(res.body.defaultApproverRole).toBe('operator');
    const bot = (res.body.definitions as Array<{ kind: string; runCount: number; effectiveApproverRoles: string[] }>).find((d) => d.kind === 'bot' && d.runCount > 0);
    expect(bot).toBeDefined();
    expect(bot!.effectiveApproverRoles).toEqual(['operator']);
  });

  it('filters by kind', async () => {
    const res = await request(ines()).get('/api/pipelines/definitions?kind=assessment-command');
    expect(res.body.definitions).toHaveLength(11);
  });

  it('an outside tenant is refused at the mount', async () => {
    const res = await request(appAs({ role: 'sme', tenant: 'orgiq', sub: 'u-nora' })).get('/api/pipelines/definitions');
    expect(res.status).toBe(403);
  });

  it('the empty scenario empties the recorded versions without breaking the catalog', async () => {
    fixtureRegistry.resetAll('empty');
    const res = await request(kofi()).get('/api/pipelines/definitions');
    expect(res.status).toBe(200);
    expect((res.body.definitions as Array<{ recorded: boolean }>).some((d) => d.recorded)).toBe(false);
  });
});

describe('GET /api/pipelines/definitions/:id', () => {
  it('opens a bot definition with its triggers and recent runs', async () => {
    const list = await request(kofi()).get('/api/pipelines/definitions?kind=bot');
    const withRuns = (list.body.definitions as Array<{ id: string; runCount: number }>).find((d) => d.runCount > 0)!;
    const res = await request(kofi()).get(`/api/pipelines/definitions/${enc(withRuns.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.definition.id).toBe(withRuns.id);
    expect(res.body.runs.length).toBeGreaterThan(0);
    for (const r of res.body.runs) expect(r.definitionId).toBe(withRuns.id);
    expect(res.body.runbook).toBeUndefined();
  });

  it('opens a runbook with its ordered steps and the rule-1 verdict', async () => {
    const res = await request(ines()).get(`/api/pipelines/definitions/${enc(RUNBOOK)}`);
    expect(res.status).toBe(200);
    expect(res.body.definition.steps.map((s: { id: string }) => s.id)).toEqual(['obs-aurora-1', 'obs-aurora-2', 'obs-aurora-3']);
    expect(res.body.runbook.promotionToSkill).toMatchObject({ ok: false });
    expect(res.body.runbook.promotionToSkill.reason).toMatch(/completed dry-run/);
  });

  it('404s an unknown definition', async () => {
    const res = await request(kofi()).get('/api/pipelines/definitions/bot%3Anope');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/pipelines/definitions/:id/approvers — AuthorDefinition', () => {
  it('an author records the approvers, one version up', async () => {
    const res = await request(ines()).put(`/api/pipelines/definitions/${enc(RUNBOOK)}/approvers`).send({ roles: ['pipeline-admin'] });
    expect(res.status).toBe(200);
    expect(res.body.definition).toMatchObject({ approverRoles: ['pipeline-admin'], version: 2, recorded: true });
    const again = await request(ines()).put(`/api/pipelines/definitions/${enc(RUNBOOK)}/approvers`).send({ roles: [] });
    expect(again.body.definition.version).toBe(3);
  });

  it('an operator cannot author (separation of duties)', async () => {
    const res = await request(kofi()).put(`/api/pipelines/definitions/${enc(RUNBOOK)}/approvers`).send({ roles: ['operator'] });
    expect(res.status).toBe(403);
  });

  it('400s a role that cannot approve', async () => {
    const res = await request(ines()).put(`/api/pipelines/definitions/${enc(RUNBOOK)}/approvers`).send({ roles: ['author'] });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/pipelines/definitions/:id/dry-run — RunPipeline, the existing queue', () => {
  it('enqueues a runbook:dry-run job, records a pending run, and the job completion marks it completed', async () => {
    const res = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    expect(res.status).toBe(202);
    const job = mockJobs.find((j) => j.id === res.body.jobId)!;
    expect(job).toMatchObject({ kind: 'runbook:dry-run', status: 'queued', createdBy: 'u-ines' });
    expect(job.payload).toMatchObject({ definitionId: RUNBOOK, definitionKind: 'runbook', requiresReview: false, pipelineRunId: `job:${job.id}` });
    expect(String(job.payload['prompt'])).toMatch(/DRY RUN/);
    expect(res.body.run).toMatchObject({ id: `job:${job.id}`, definitionId: RUNBOOK, status: 'pending', jobId: job.id });
    expect(res.body.brakes).toContain('allocation and envelope: the runbook names no initiative');

    // The projection files the job under the runbook's definition.
    const runs = await request(kofi()).get(`/api/pipelines/runs?definitionId=${enc(RUNBOOK)}`);
    expect(runs.body.runs.map((r: { id: string }) => r.id)).toContain(`job:${job.id}`);
    expect(runs.body.runs[0].context.kind).toBe('runbook');

    // A second dry-run while one is in flight is refused.
    const dup = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    expect(dup.status).toBe(409);

    // The queue's own completion path closes it.
    job.status = 'running';
    await completeJob(job.id, { status: 'done', result: { costUsd: 0.0341 } });
    await new Promise((r) => setImmediate(r));
    expect(pipelineRunRecords.rows().find((r) => r.id === `job:${job.id}`)?.status).toBe('completed');
    // The run's cost is read off the job it ran as, once the job reports one.
    const detail = await request(kofi()).get(`/api/pipelines/definitions/${enc(RUNBOOK)}`);
    expect(detail.body.dryRuns[0]).toMatchObject({ status: 'completed', costUsd: 0.0341 });

    const rb = await request(kofi()).get('/api/pipelines/runbooks');
    const mine = (rb.body.runbooks as Array<{ id: string; runbook: { lastDryRun: { id: string }; promotionToSkill: { ok: boolean } } }>).find((r) => r.id === RUNBOOK)!;
    expect(mine.runbook.lastDryRun.id).toBe(`job:${job.id}`);
    expect(mine.runbook.promotionToSkill.ok).toBe(true);

    // And rule 1 now lets the ladder promote it, citing that run.
    const promoted = await promoteCandidate('promo-aurora-cold-start', { approvedBy: 'Dara Whitfield' });
    expect(promoted && 'candidate' in promoted && promoted.candidate?.dryRunRunId).toBe(`job:${job.id}`);
  });

  it('applies the per-run budget brake with its own confirm flag', async () => {
    const res = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({ budgetPerRunUsd: 0 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ gate: 'run-budget', confirmFlag: 'confirmOverRunBudget' });
    const ok = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({ budgetPerRunUsd: 0, confirmOverRunBudget: true });
    expect(ok.status).toBe(202);
  });

  it('refuses a definition that is not a runbook', async () => {
    const res = await request(ines()).post(`/api/pipelines/definitions/${enc('assessment:score-dimensions')}/dry-run`).send({});
    expect(res.status).toBe(409);
  });

  it('refuses a session without RunPipeline, and a bad budget', async () => {
    const outsider = await request(appAs({ role: 'member', tenant: 'orgiq', sub: 'u-theo' })).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    expect(outsider.status).toBe(403);
    const bad = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({ budgetPerRunUsd: -1 });
    expect(bad.status).toBe(400);
  });
});

describe('row 9 — a run record entering completed notifies its trigger and its approvers', () => {
  afterEach(() => setNotificationSink(null));
  it('completing the dry-run job sends one "finished" item each to u-ines (trigger) and the operator/pipeline-admin', async () => {
    const sent: Array<{ userId: string; input: NotificationInputLike }> = [];
    setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } });
    const res = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    const job = mockJobs.find((j) => j.id === res.body.jobId)!;
    job.status = 'running';
    await completeJob(job.id, { status: 'done', result: { costUsd: 0.01 } });
    for (let i = 0; i < 50 && sent.length < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(sent.map((x) => x.userId).sort()).toEqual(['u-dara', 'u-ines', 'u-kofi']);
    expect(sent[0]!.input).toMatchObject({
      type: 'system', payload: { tenant: 'pipelines', runId: `job:${job.id}`, status: 'completed' },
      action: { href: `/pipelines/runs/${enc(`job:${job.id}`)}` },
    });
    // A replayed event for the same status moves nothing and notifies nobody again.
    await completeJob(job.id, { status: 'done', result: { costUsd: 0.01 } }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(3);
  });
});

describe('GET /api/pipelines/runbooks', () => {
  it('names an unreadable pipeline_runs instead of reading it as "no dry-run"', async () => {
    const target = pipelineRunRecords as unknown as { rows: () => unknown[] };
    const original = target.rows;
    target.rows = () => { throw new Error('pipeline_runs unavailable: relation does not exist'); };
    try {
      const res = await request(kofi()).get('/api/pipelines/runbooks');
      expect(res.status).toBe(200);
      expect(res.body.unavailable).toEqual(expect.arrayContaining([expect.objectContaining({ source: 'pipeline_runs' })]));
      const one = await request(kofi()).get(`/api/pipelines/definitions/${enc(RUNBOOK)}`);
      expect(one.body.unavailable[0].source).toBe('pipeline_runs');
    } finally {
      target.rows = original;
    }
  });

  it('lists the seeded rehearsal and leaves untested runbooks without a dry-run', async () => {
    const res = await request(ines()).get('/api/pipelines/runbooks');
    expect(res.status).toBe(200);
    expect(res.body.runbooks.length).toBeGreaterThan(0);
    expect(res.body.runbooks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'runbook:promo-arm64-fargate' }),
      expect.objectContaining({ id: RUNBOOK }),
    ]));
    for (const r of res.body.runbooks) {
      expect(r.kind).toBe('runbook');
      if (r.id === 'runbook:promo-arm64-fargate') {
        expect(r.runbook.lastDryRun).toMatchObject({ id: 'job:dry-quarantine-batch', definitionId: r.id,
          runKind: 'runbook:dry-run', status: 'completed', triggeredBy: 'u-ines' });
      } else expect(r.runbook.lastDryRun).toBeNull();
    }
  });
});

describe('approvals — ApproveStep, routed to the existing decision paths', () => {
  it('lists pending steps as pipeline.approval.requested, defaulting to operator', async () => {
    const res = await request(ines()).get('/api/pipelines/approvals');
    expect(res.status).toBe(200);
    const consult = (res.body.approvals as Array<{ id: string; type: string; requiredRoles: string[] }>).find((a) => a.id === 'consult:con-mock-1');
    expect(consult).toMatchObject({ type: 'pipeline.approval.requested', requiredRoles: ['operator'] });
  });

  it('an operator approves a lab consult through the consult answer path', async () => {
    const res = await request(kofi()).post('/api/pipelines/approvals/consult%3Acon-mock-1/decide').send({ decision: 'approve', note: 'smallest first' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ decision: 'approve', outcome: 'answered' });
    const { getConsult } = await import('../../providers/lab.js');
    expect((await getConsult('con-mock-1'))?.answer).toBe('Approved — smallest first');
    // Decided once: it no longer waits.
    const again = await request(kofi()).post('/api/pipelines/approvals/consult%3Acon-mock-1/decide').send({ decision: 'reject' });
    expect(again.status).toBe(404);
  });

  it('an author cannot decide, and a bad decision is a 400', async () => {
    const author = await request(ines()).post('/api/pipelines/approvals/consult%3Acon-mock-1/decide').send({ decision: 'approve' });
    expect(author.status).toBe(403);
    const bad = await request(dara()).post('/api/pipelines/approvals/consult%3Acon-mock-1/decide').send({ decision: 'maybe' });
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/pipelines/runs/:id/cancel — CancelRun', () => {
  it("an operator cancels a queued dry-run through the queue's cancel", async () => {
    const started = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    const runId = started.body.run.id as string;
    const byAuthor = await request(ines()).post(`/api/pipelines/runs/${enc(runId)}/cancel`).send({});
    expect(byAuthor.status).toBe(403);
    const res = await request(kofi()).post(`/api/pipelines/runs/${enc(runId)}/cancel`).send({});
    expect(res.status).toBe(200);
    expect(mockJobs.find((j) => j.id === started.body.jobId)?.status).toBe('cancelled');
    expect(pipelineRunRecords.rows().find((r) => r.id === runId)?.status).toBe('cancelled');
    const twice = await request(kofi()).post(`/api/pipelines/runs/${enc(runId)}/cancel`).send({});
    expect(twice.status).toBe(409);
  });

  it('404s an unknown run', async () => {
    const res = await request(kofi()).post('/api/pipelines/runs/job%3Anope/cancel').send({});
    expect(res.status).toBe(404);
  });
});

describe('cancel notifications never reach the canceller', () => {
  const tick = () => new Promise((r) => setTimeout(r, 25));
  let got: Array<{ userId: string; title: string }>;
  beforeEach(() => {
    got = [];
    setNotificationSink({ notifyUser: async (userId, input) => { got.push({ userId, title: input.title }); return {}; } });
  });
  afterEach(() => setNotificationSink(null));

  it('the cancel route (job-event path) tells the trigger, not the canceller', async () => {
    const started = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    const runId = started.body.run.id as string;
    got.length = 0;
    expect((await request(kofi()).post(`/api/pipelines/runs/${enc(runId)}/cancel`).send({})).status).toBe(200);
    await tick();
    const who = got.filter((n) => /cancelled/.test(n.title)).map((n) => n.userId);
    expect(who).toContain('u-ines');
    expect(who).not.toContain('u-kofi');
  });

  it('the canceller is excluded when they triggered the run themselves', async () => {
    const started = await request(kofi()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    const runId = started.body.run.id as string;
    got.length = 0;
    await request(kofi()).post(`/api/pipelines/runs/${enc(runId)}/cancel`).send({});
    await tick();
    expect(got.filter((n) => /cancelled/.test(n.title)).map((n) => n.userId)).not.toContain('u-kofi');
  });

  it('a cancel with no known actor (a bare job event) still notifies the trigger', async () => {
    const started = await request(ines()).post(`/api/pipelines/definitions/${enc(RUNBOOK)}/dry-run`).send({});
    got.length = 0;
    const { cancelJob } = await import('../../providers/agent-jobs.js');
    await cancelJob(started.body.jobId as string);
    await tick();
    expect(got.filter((n) => /cancelled/.test(n.title)).map((n) => n.userId)).toContain('u-ines');
  });
});

describe('configuration — ManagePipelineConfig', () => {
  it('every role reads it; only a pipeline admin changes the default approver', async () => {
    const read = await request(ines()).get('/api/pipelines/configuration');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ defaultApproverRole: 'operator', approverRoleOptions: ['operator', 'pipeline-admin'] });
    const byOperator = await request(kofi()).put('/api/pipelines/configuration').send({ defaultApproverRole: 'pipeline-admin' });
    expect(byOperator.status).toBe(403);
    const bad = await request(dara()).put('/api/pipelines/configuration').send({ defaultApproverRole: 'author' });
    expect(bad.status).toBe(400);
    const ok = await request(dara()).put('/api/pipelines/configuration').send({ defaultApproverRole: 'pipeline-admin' });
    expect(ok.status).toBe(200);
    const approvals = await request(kofi()).get('/api/pipelines/approvals');
    for (const a of approvals.body.approvals) if (a.rolesDefaulted) expect(a.requiredRoles).toEqual(['pipeline-admin']);
  });
});
