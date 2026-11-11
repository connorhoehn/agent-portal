// Local compute inside the run controls (docs/learning-loop-design.md "Budgets",
// lane B): a claim meets the same kill switches and run limits as every other
// executor, refused with reserveSpend's own codes, and its money stays $0 with
// the worker's own figure kept as reported, never billed.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: {
      userPoolId: 'us-east-1_TEST', clientId: 'client123', clientSecret: 'secret123',
      domain: 'example.auth.us-east-1.amazoncognito.com',
      callbackUrl: 'http://localhost:3001/api/auth/callback',
      postLoginUrl: '/', logoutRedirectUrl: '/',
    },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
  },
}));

jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '',
      capabilities: ['Search', 'ViewOrgChart', 'ConnectLocalCompute'] },
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
  ],
}));

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { localComputeRouter } from '../local-compute.js';
import { errorHandler } from '../../lib/async-handler.js';
import { clearAuthzCache } from '../../lib/authz.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { _resetLocalComputeMocks } from '../../providers/local-compute.js';
import { _resetLocalFleet } from '../../lib/local-compute-fleet.js';
import { enqueueJob, getJob, _resetMockQueue } from '../../providers/agent-jobs.js';
import { setSwitch } from '../../lib/fleet-switches.js';
import { upsertRunLimit } from '../../providers/run-limits.js';
import { initiativeBudgets } from '../../mock/budgets.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';
import { runLimits, runSlots, fleetSwitches } from '../../mock/run-controls.js';
import { type Role, type Session } from '../../lib/session.js';

const BASE = '/api/local-compute';
const AUTH = 'p-auth-migration';

function buildApp(session: Partial<Session> | null) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      req.session = { sub: 'u-mia', role: 'member', tenant: 'orgiq', grants: {}, iat: 0, ...session } as Session;
      next();
    });
  }
  app.use(BASE, localComputeRouter);
  app.use(errorHandler);
  return app;
}
const anon = () => buildApp(null);
const as = (role: Role, sub = 'u-mia') => buildApp({ role, sub });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

interface Paired { nodeId: string; nodeToken: string }

async function readyWorker(): Promise<Paired> {
  const started = await request(as('member')).post(`${BASE}/pair/start`).send({});
  const node = (await request(anon()).post(`${BASE}/pair/claim`).send({ code: started.body.code, node: { label: 'mia-mbp' } })).body as Paired;
  expect((await request(as('member')).patch(`${BASE}/nodes/${node.nodeId}`).send({ acceptJobs: true })).status).toBe(200);
  expect((await request(anon()).post(`${BASE}/register`).set(bearer(node.nodeToken)).send({ jobKinds: ['local:task'], maxConcurrency: 4 })).status).toBe(200);
  return node;
}

async function queue(node: Paired, title: string, initiativeId: string | null = AUTH) {
  const job = await enqueueJob({
    kind: 'local:task', title, createdBy: 'u-mia',
    payload: { nodeId: node.nodeId, prompt: `Do ${title}.`, ...(initiativeId ? { initiativeId } : {}) },
  });
  return job!;
}

const claim = (node: Paired) => request(anon()).post(`${BASE}/claim`).set(bearer(node.nodeToken)).send({});

beforeEach(() => {
  _resetLocalComputeMocks();
  _resetLocalFleet();
  _resetMockQueue();
  resetRateLimits();
  clearAuthzCache();
  for (const f of [initiativeBudgets, spendHolds, spendEntries, runLimits, runSlots, fleetSwitches]) f.reset();
});

describe('the claim meets the kill switches', () => {
  it('a paused initiative refuses the claim with 423 `paused` and hands the job back unburned', async () => {
    const node = await readyWorker();
    const job = await queue(node, 'cutover runbook');
    await setSwitch(`initiative:${AUTH}`, true, 'budget review', 'u-vera');
    const res = await claim(node);
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ gate: 'paused', scope: `initiative:${AUTH}` });
    const back = (await getJob(job.id))!;
    expect(back.status).toBe('queued');
    expect(back.attempts).toBe(0);
    expect(back.boxId).toBeNull();
  });

  it('a paused fleet refuses a job with no initiative too', async () => {
    const node = await readyWorker();
    await queue(node, 'free text', null);
    await setSwitch('fleet', true, 'incident', 'u-vera');
    expect((await claim(node)).body).toMatchObject({ gate: 'paused', scope: 'fleet' });
  });
});

describe('the claim meets the run limits', () => {
  it('the initiative concurrency limit: 429 `run-limit` with Retry-After once its slot is held', async () => {
    const node = await readyWorker();
    await upsertRunLimit('initiative', AUTH, { maxConcurrent: 1 }, 'u-vera');
    await queue(node, 'first');
    const second = await queue(node, 'second');
    const first = await claim(node);
    expect(first.status).toBe(200);
    // The $0 hold carries the slot: the run took nothing from any budget.
    const hold = spendHolds.rows().find((h) => h.sourceId === `${first.body.job.id}:1`)!;
    expect(hold).toMatchObject({ initiativeId: AUTH, amountUsd: 0, source: 'job', status: 'held' });
    expect(runSlots.rows().map((r) => r.holder)).toContain(hold.id);

    const refused = await claim(node);
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBe('30');
    expect(refused.body).toMatchObject({ gate: 'run-limit', limitKind: 'concurrency', scope: { kind: 'initiative', id: AUTH } });
    expect((await getJob(second.id))!.status).toBe('queued');
  });

  it('the per-day run limit refuses with `runs-per-day`', async () => {
    const node = await readyWorker();
    await upsertRunLimit('initiative', AUTH, { maxRunsPerDay: 0 }, 'u-vera');
    await queue(node, 'one');
    const res = await claim(node);
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ gate: 'run-limit', limitKind: 'runs-per-day' });
  });

  it('completing the run settles its $0 hold, frees the slot and keeps the reported figure unbilled', async () => {
    const node = await readyWorker();
    await upsertRunLimit('initiative', AUTH, { maxConcurrent: 1 }, 'u-vera');
    await queue(node, 'first');
    await queue(node, 'second');
    const first = await claim(node);
    const done = await request(anon()).post(`${BASE}/jobs/${first.body.job.id}/complete`).set(bearer(node.nodeToken))
      .send({ claimToken: first.body.claimToken, status: 'done', costUsd: 2.75, model: 'claude-sonnet-4-5' });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ costUsd: 0, provider: 'local' });
    expect(spendEntries.rows().find((e) => e.sourceId === `${first.body.job.id}:1`)).toMatchObject({
      costUsd: 0, provider: 'local', reportedUsd: 2.75, initiativeId: AUTH,
    });
    expect(spendHolds.rows().find((h) => h.sourceId === `${first.body.job.id}:1`)!.status).toBe('settled');
    expect((await claim(node)).status).toBe(200);
  });
});

describe('money does not judge a local run', () => {
  it('an initiative far past its allocation and hard cap still claims, at $0', async () => {
    const node = await readyWorker();
    initiativeBudgets.rows().find((b) => b.id === AUTH)!.allocated = 0.0001;
    await queue(node, 'over budget');
    const res = await claim(node);
    expect(res.status).toBe(200);
    expect(spendHolds.rows().every((h) => h.amountUsd === 0)).toBe(true);
  });

  it('a job with no initiative and no limit to meet claims with no hold', async () => {
    const node = await readyWorker();
    await queue(node, 'free text', null);
    expect((await claim(node)).status).toBe(200);
    expect(spendHolds.rows()).toHaveLength(0);
  });
});
