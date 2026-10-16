// THE INJECTION CONTRACT (docs/distillation-runbooks-goal.md R4, design §6.2):
// for named seeded work, the exact session brief a box receives — its bytes,
// its sha256, its sections — is a reviewed file in the repo:
//
//   docs/journeys/contracts/session-brief.json        sections, omitted, tokens, sha per case
//   docs/journeys/contracts/session-brief/<case>.md   the brief markdown, byte for byte
//
// Each case runs the REAL path a run takes: the job dispatcher's tick
// (lib/job-dispatcher.ts → lib/run-brief.ts) for devbox work, the real
// POST /api/local-compute/claim route for a paired workstation. Only the
// AgentCore invoke at the very end (runDevboxTask) is stubbed, and it is
// asserted on: it is handed the run's LAB_* context.
//
// Under freezeClock against the `default` world. A change in selection or
// rendering fails here with a unified diff of the markdown; the contract is
// re-recorded only deliberately:
//
//   node scripts/runbooks/brief-contract.mjs --update
//
// which re-runs this file with UPDATE_BRIEF_CONTRACT=1 and rewrites both files.
// Review the diff of the .md files before committing — that is the review.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    auth: { policyStoreId: '', sessionSigningSecretArn: '' },
    aurora: { clusterArn: '', secretArn: '', database: 'orgiq' },
    cognito: {
      userPoolId: 'us-east-1_TEST', clientId: 'client123', clientSecret: 'secret123',
      domain: 'example.auth.us-east-1.amazoncognito.com',
      callbackUrl: 'http://localhost:3001/api/auth/callback', postLoginUrl: '/', logoutRedirectUrl: '/',
    },
    mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true },
  },
}));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
// The one stub: the AgentCore invoke. Everything before it is the real dispatch.
const invoked: Array<Record<string, unknown>> = [];
jest.mock('../../routes/devbox.js', () => ({
  runDevboxTask: jest.fn(async (opts: Record<string, unknown>) => {
    invoked.push(opts);
    return { ok: true, summary: 'done', turns: 1, durationMs: 1, costUsd: 0, toolCalls: 0, exitCode: 0, transcript: [] };
  }),
}));

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { randomBytes } from 'node:crypto';
import request from '../../test-support/http.js';
import { SERVICE_AUTH_HEADER, signServiceRequest } from '@connorhoehn/service-runtime';
import { fixtureRegistry, freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { mockJobs } from '../../mock/agent-jobs.js';
import { getJob, _resetMockQueue, type AgentJob } from '../../providers/agent-jobs.js';
import { dispatchOnce } from '../job-dispatcher.js';
import { registerBox, _resetFleet } from '../devbox-fleet.js';
import { runbookStore, setRunbookStore } from '../runbooks/store-select.js';
import { estimateTokens, sha256Hex, type SessionBrief } from '../runbooks/index.js';
import { RUN_TOKEN_HEADER, mintRunToken, verifyRunToken } from '../run-token.js';
import { freezeBrief } from '../run-brief.js';
import { BRIEF_BEGIN, BRIEF_END } from '../local-work.js';
import { unifiedDiff } from '../unified-diff.js';
import { LAB_CALLBACK_SERVICE_AUTH, SERVICE_NONCE_HEADER, captureRawBody, resetServiceNonceCache } from '../service-auth.js';
import { createSessionBriefsRouter } from '../../routes/session-briefs.js';
import { localComputeRouter } from '../../routes/local-compute.js';
import { errorHandler } from '../async-handler.js';
import { clearAuthzCache } from '../authz.js';
import { resetRateLimits } from '../rate-limit.js';
import { _resetLocalComputeMocks } from '../../providers/local-compute.js';
import { _resetLocalFleet } from '../local-compute-fleet.js';
import type { Session } from '../session.js';

const ROOT = join(__dirname, '..', '..', '..', '..');
const CONTRACT = join(ROOT, 'docs', 'journeys', 'contracts', 'session-brief.json');
const MD_DIR = join(ROOT, 'docs', 'journeys', 'contracts', 'session-brief');
const UPDATE = process.env['UPDATE_BRIEF_CONTRACT'] === '1';
const CLOCK = '2026-10-14T09:00:00.000Z';
const SECRET = 'lab-contract-secret';

interface Case {
  /** dispatch = the job dispatcher's tick (devbox); claim = POST /api/local-compute/claim (workstation). */
  path: 'dispatch' | 'claim';
  why: string;
  work_item_id?: string;
  task?: { title: string; prompt: string };
}

const CASES: Record<string, Case> = {
  // R8: every case's procedures arrive as the org's skill library; the brief is the run's context plus one pointer.
  'wi-auth-e2-s2': { path: 'dispatch', work_item_id: 'wi-auth-e2-s2', why: 'Auth Migration: the cutover runbook story, two decisions binding; the skill library pointer' },
  'wi-auth-e2-b3': { path: 'dispatch', work_item_id: 'wi-auth-e2-b3', why: 'Auth Migration: the logout-cookie bug' },
  'wi-obs-e2-b4': { path: 'dispatch', work_item_id: 'wi-obs-e2-b4', why: 'Observability: another initiative gets the same library (same sha) as Auth Migration' },
  'wi-inf-e1-b3': { path: 'dispatch', work_item_id: 'wi-inf-e1-b3', why: 'Inference platform: the same library again — scope never gates a skill' },
  'task-fargate-arm64': {
    path: 'claim',
    task: { title: 'Fix the collector crash loop on Fargate', prompt: 'The collector image built on a Mac crash-loops on Fargate with exec format error. Rebuild it for arm64 and redeploy the task definition.' },
    why: 'Infra/Fargate on a paired workstation, from a free-form task, inside the local framing: the library is named but not installed on this machine',
  },
};

interface ContractCase {
  path: Case['path'];
  why: string;
  run_ref: string;
  sections: Array<{ kind: string; ref: string | null; version?: number }>;
  omitted: SessionBrief['omitted'];
  used_tokens: number;
  sha256: string;
}
interface Contract { assembler_version: string; clock: string; budget_tokens: number; cases: Record<string, ContractCase> }

const runRef = (key: string) => `job-contract-${key}`;

function queue(key: string, c: Case, extra: Partial<AgentJob['payload']> = {}): void {
  const job: AgentJob = {
    id: runRef(key), kind: c.path === 'claim' ? 'local:task' : 'devbox:task', title: c.task?.title ?? key,
    payload: {
      prompt: c.task?.prompt ?? `Work item ${c.work_item_id}`, requiresReview: true,
      ...(c.work_item_id ? { workItemId: c.work_item_id } : {}), ...extra,
    },
    status: 'queued', priority: 1, boxId: null, sessionId: null, attempts: 0, maxAttempts: 2, result: null, error: null,
    createdBy: 'u-nora', createdAt: CLOCK, claimedAt: null, startedAt: null, finishedAt: null, botId: null, botName: null, botTrigger: null,
  };
  mockJobs.push(job);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

/** Dispatch one queued devbox job through the real tick; return what the invoke was handed. */
async function dispatch(key: string): Promise<Record<string, unknown>> {
  registerBox({ id: `box-${key}`.slice(0, 40), sessionId: `session-${key}-${'x'.repeat(33)}` });
  const before = invoked.length;
  await dispatchOnce();
  for (let i = 0; i < 50 && invoked.length === before; i += 1) await settle();
  expect(invoked.length).toBe(before + 1);
  return invoked[invoked.length - 1]!;
}

// ── The local-compute side: a paired, accepting workstation ─────────────────

function app(session: Partial<Session> | null) {
  const a = express();
  a.use(express.json({ verify: captureRawBody }));
  if (session) {
    a.use((req, _res, next) => {
      req.session = { sub: 'u-mia', role: 'member', tenant: 'orgiq', grants: { orgiq: ['member'] }, iat: 0, ...session } as Session;
      next();
    });
  }
  a.use('/api/local-compute', localComputeRouter);
  a.use('/api', createSessionBriefsRouter({ store: () => runbookStore() }));
  a.use(errorHandler);
  return a;
}

async function pairedWorker(): Promise<{ nodeId: string; nodeToken: string }> {
  const owner = app({ sub: 'u-mia', role: 'member' });
  const started = await request(owner).post('/api/local-compute/pair/start').send({});
  expect(started.status).toBe(200);
  const claimed = await request(app(null)).post('/api/local-compute/pair/claim').send({ code: started.body.code, node: { label: 'mia-mbp' } });
  expect(claimed.status).toBe(201);
  const node = claimed.body as { nodeId: string; nodeToken: string };
  await request(owner).patch(`/api/local-compute/nodes/${node.nodeId}`).send({ acceptJobs: true });
  await request(app(null)).post('/api/local-compute/register').set('Authorization', `Bearer ${node.nodeToken}`).send({ jobKinds: ['local:task'], maxConcurrency: 2 });
  return node;
}

async function claim(key: string): Promise<{ prompt: string; payload: Record<string, unknown> }> {
  const node = await pairedWorker();
  const job = mockJobs.find((j) => j.id === runRef(key))!;
  job.payload = { ...job.payload, nodeId: node.nodeId };
  const res = await request(app(null)).post('/api/local-compute/claim').set('Authorization', `Bearer ${node.nodeToken}`).send({});
  expect(res.status).toBe(200);
  expect(res.body.job.id).toBe(runRef(key));
  return { prompt: res.body.job.payload.prompt as string, payload: res.body.job.payload as Record<string, unknown> };
}

function boxHeaders(target: string, runToken?: string): Record<string, string> {
  const nonce = randomBytes(18).toString('base64url');
  return {
    [SERVICE_AUTH_HEADER]: signServiceRequest({ method: 'GET', target, body: '' }, { secret: SECRET, serviceId: 'orgiq-devbox', audience: `orgiq-middleware/lab#${nonce}` }),
    [SERVICE_NONCE_HEADER]: nonce,
    ...(runToken ? { [RUN_TOKEN_HEADER]: runToken } : {}),
  };
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

let restoreClock: () => void = () => {};
beforeEach(() => {
  restoreClock = freezeClock(CLOCK);
  fixtureRegistry.resetAll('default');
  setRunbookStore(null);
  _resetMockQueue();
  _resetFleet();
  _resetLocalComputeMocks();
  _resetLocalFleet();
  resetRateLimits();
  clearAuthzCache();
  resetServiceNonceCache();
  process.env[LAB_CALLBACK_SERVICE_AUTH.envVar] = SECRET;
  delete process.env['BRIEF_BUDGET_TOKENS'];
  invoked.length = 0;
});
afterEach(() => {
  restoreClock();
  unfreezeClock();
  delete process.env[LAB_CALLBACK_SERVICE_AUTH.envVar];
});

// ── The contract ─────────────────────────────────────────────────────────────

describe('session brief contract (docs/journeys/contracts/session-brief.json)', () => {
  const recorded: Record<string, { c: ContractCase; markdown: string }> = {};

  for (const [key, c] of Object.entries(CASES)) {
    it(`${key}: the ${c.path} path freezes exactly the reviewed brief`, async () => {
      queue(key, c);
      let brief: SessionBrief | null;
      if (c.path === 'dispatch') {
        const opts = await dispatch(key);
        brief = await runbookStore().getBrief(runRef(key));
        expect(brief).not.toBeNull();
        // The box is handed the run: its ref, its brief, and a token that verifies for it alone.
        const lab = opts['lab'] as Record<string, string>;
        expect(lab).toEqual(expect.objectContaining({ run_ref: runRef(key), brief_id: brief!.id }));
        expect(await verifyRunToken(lab['run_token']!, runRef(key))).toBe(true);
        expect(await verifyRunToken(lab['run_token']!, 'job-someone-else')).toBe(false);
      } else {
        const claimed = await claim(key);
        brief = await runbookStore().getBrief(runRef(key));
        expect(brief).not.toBeNull();
        expect(claimed.payload['brief_sha']).toBe(brief!.sha256);
        // The worker's prompt carries those exact bytes, inside the framing.
        expect(claimed.prompt).toContain(`${BRIEF_BEGIN}\n${brief!.markdown.replace(/\n$/, '')}\n${BRIEF_END}`);
      }
      const b = brief!;

      // The job row is stamped with what the box was given.
      const job = await getJob(runRef(key));
      expect(job!.payload['brief_id']).toBe(b.id);
      expect(job!.payload['brief_sha']).toBe(b.sha256);
      expect(sha256Hex(b.markdown)).toBe(b.sha256);

      const entry: ContractCase = {
        path: c.path, why: c.why, run_ref: b.run_ref,
        sections: b.sections.map((s) => ({ kind: s.kind, ref: s.ref, ...(s.version !== undefined ? { version: s.version } : {}) })),
        omitted: b.omitted, used_tokens: b.used_tokens, sha256: b.sha256,
      };
      recorded[key] = { c: entry, markdown: b.markdown };
      if (UPDATE) return;

      const contract = JSON.parse(readFileSync(CONTRACT, 'utf8')) as Contract;
      const want = contract.cases[key];
      expect(want).toBeDefined();
      const wantMd = readFileSync(join(MD_DIR, `${key}.md`), 'utf8');
      if (wantMd !== b.markdown) {
        const d = unifiedDiff(wantMd, b.markdown, { from: `contract ${key}.md`, to: 'assembled now' });
        throw new Error(`the ${key} brief drifted from its contract (re-record deliberately with --update):\n${d.text}`);
      }
      expect(sha256Hex(wantMd)).toBe(want!.sha256);
      expect(entry).toEqual(want);
      expect(contract.budget_tokens).toBe(b.budget_tokens);
    });
  }

  afterAll(() => {
    if (!UPDATE) return;
    mkdirSync(MD_DIR, { recursive: true });
    const cases: Record<string, ContractCase> = {};
    for (const key of Object.keys(CASES)) {
      const r = recorded[key];
      if (!r) throw new Error(`--update: case ${key} did not run`);
      cases[key] = r.c;
      writeFileSync(join(MD_DIR, `${key}.md`), r.markdown);
    }
    const contract: Contract = { assembler_version: '1', clock: CLOCK, budget_tokens: 6000, cases };
    writeFileSync(CONTRACT, JSON.stringify(contract, null, 2) + '\n');
  });
});

// ── The behaviours the contract stands on ────────────────────────────────────

describe('injection contracts', () => {
  it('a brief is frozen once: re-dispatching the same run after a runbook moved on hands out the same bytes', async () => {
    queue('wi-auth-e2-s2', CASES['wi-auth-e2-s2']!);
    const first = await dispatch('wi-auth-e2-s2');
    const frozen = (await runbookStore().getBrief(runRef('wi-auth-e2-s2')))!;

    // The world changes: rb-tenant-cutover is retired. A fresh run would not get it.
    const store = runbookStore();
    const rb = (await store.getRunbook('rb-tenant-cutover'))!;
    await store.putRunbook({ ...rb, status: 'retired', updated_at: CLOCK, retired: { at: CLOCK, by: 'p-002', reason: 'test', superseded_by: null } }, rb.updated_at);

    // The same job goes back on the queue (a reaped run) and is dispatched again.
    const job = mockJobs.find((j) => j.id === runRef('wi-auth-e2-s2'))!;
    Object.assign(job, { status: 'queued', boxId: null, sessionId: null });
    const second = await dispatch('wi-auth-e2-s2-again');
    expect((second['lab'] as Record<string, string>)['brief_id']).toBe((first['lab'] as Record<string, string>)['brief_id']);
    const after = (await runbookStore().getBrief(runRef('wi-auth-e2-s2')))!;
    expect(after.sha256).toBe(frozen.sha256);
    // The frozen record still names the library its box synced, retired skill included.
    expect(after.skill_library?.skills.some((k) => k.name === 'rb-tenant-cutover')).toBe(true);
  });

  it('a retired runbook leaves the skill library, so a new run is not given it', async () => {
    const store = runbookStore();
    const before = await freezeBrief({ run_ref: 'job-before-retire', box: 'devbox', work_item_id: 'wi-auth-e2-s2' });
    const rb = (await store.getRunbook('rb-tenant-cutover'))!;
    await store.putRunbook({ ...rb, status: 'retired', updated_at: CLOCK, retired: { at: CLOCK, by: 'p-002', reason: 'superseded', superseded_by: null } }, rb.updated_at);
    const brief = await freezeBrief({ run_ref: 'job-after-retire', box: 'devbox', work_item_id: 'wi-auth-e2-s2' });
    expect(brief.skill_library?.skills.some((k) => k.name === 'rb-tenant-cutover')).toBe(false);
    expect(brief.skill_library?.sha256).not.toBe(before.skill_library?.sha256);
    expect(brief.markdown).not.toContain('rb-tenant-cutover');
  });

  it('one library for every box: two initiatives\' runs record the same skill set and sha', async () => {
    const a = await freezeBrief({ run_ref: 'job-lib-auth', box: 'devbox', work_item_id: 'wi-auth-e2-s2' });
    const b = await freezeBrief({ run_ref: 'job-lib-obs', box: 'devbox', work_item_id: 'wi-obs-e2-b4' });
    expect(a.initiative_id).not.toBe(b.initiative_id);
    expect(b.skill_library).toEqual(a.skill_library);
    expect(a.skill_library!.skills.map((k) => k.name)).toEqual(expect.arrayContaining(['rb-ws-cdp-debug', 'rb-gateway-presence-client', 'rb-tenant-cutover']));
  });

  it('the budget is respected and the brief carries no procedure text', async () => {
    process.env['BRIEF_BUDGET_TOKENS'] = '1700';
    const small = await freezeBrief({ run_ref: 'job-small-budget', box: 'devbox', work_item_id: 'wi-auth-e2-s2' });
    expect(small.budget_tokens).toBe(1700);
    expect(small.used_tokens).toBeLessThanOrEqual(1700);
    expect(estimateTokens(small.markdown)).toBe(small.used_tokens);
    delete process.env['BRIEF_BUDGET_TOKENS'];
    const full = await freezeBrief({ run_ref: 'job-full-budget', box: 'devbox', work_item_id: 'wi-auth-e2-s2' });
    expect(full.used_tokens).toBeLessThanOrEqual(6000);

    const store = runbookStore();
    for (const b of [small, full]) {
      expect(b.sections.some((x) => x.kind === 'runbook')).toBe(false);
      for (const k of b.skill_library!.skills) {
        const v = (await store.getVersion(k.name, k.version))!;
        // No step of any skill leaks into the brief: procedures arrive as skills only.
        expect(b.markdown).not.toContain(v.markdown.split('\n').find((l) => l.startsWith('1. '))!);
      }
    }
  });

  it('GET /api/runs/:ref/brief: the envelope AND this run\'s token are required, and a box cannot read another run', async () => {
    queue('wi-obs-e2-b4', CASES['wi-obs-e2-b4']!);
    queue('wi-auth-e2-b3', CASES['wi-auth-e2-b3']!);
    const lab = (await dispatch('wi-obs-e2-b4'))['lab'] as Record<string, string>;
    await dispatch('wi-auth-e2-b3');
    const own = `/api/runs/${runRef('wi-obs-e2-b4')}/brief?format=markdown`;
    const other = `/api/runs/${runRef('wi-auth-e2-b3')}/brief?format=markdown`;
    const anon = app(null);

    expect((await request(anon).get(own)).status).toBe(401);
    expect((await request(anon).get(own).set(RUN_TOKEN_HEADER, lab['run_token']!)).status).toBe(401);
    expect((await request(anon).get(own).set(boxHeaders(own))).status).toBe(403);
    expect((await request(anon).get(other).set(boxHeaders(other, lab['run_token']))).status).toBe(403);
    const ok = await request(anon).get(own).set(boxHeaders(own, lab['run_token']));
    expect(ok.status).toBe(200);
    const job = await getJob(runRef('wi-obs-e2-b4'));
    expect(ok.headers['x-brief-sha256']).toBe(job!.payload['brief_sha']);
    expect(sha256Hex(ok.text)).toBe(job!.payload['brief_sha']);
    // And a person reads the same bytes.
    expect(await mintRunToken(runRef('wi-obs-e2-b4'))).toBe(lab['run_token']);
  });

  it('the worker\'s prompt: framing first, the brief inside it, the task last and verbatim', async () => {
    queue('task-fargate-arm64', CASES['task-fargate-arm64']!);
    const { prompt } = await claim('task-fargate-arm64');
    const brief = (await runbookStore().getBrief(runRef('task-fargate-arm64')))!;
    const framing = prompt.indexOf('You are running non-interactively');
    const begin = prompt.indexOf(BRIEF_BEGIN);
    const end = prompt.indexOf(BRIEF_END);
    const task = prompt.indexOf('The task:');
    expect(framing).toBe(0);
    expect(framing).toBeLessThan(begin);
    expect(begin).toBeLessThan(end);
    expect(end).toBeLessThan(task);
    expect(prompt).toContain(`sha256 ${brief.sha256}`);
    expect(prompt.endsWith(CASES['task-fargate-arm64']!.task!.prompt)).toBe(true);
    expect(prompt).toContain('This machine has no `lab` command');
  });
});
