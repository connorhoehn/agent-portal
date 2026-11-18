// The question plan (routes/interviews/plan.ts; docs/interviews-tenant-plan.md row I3.10, contract E6), mounted as index.ts
// mounts the tenant, with ConductInterview decided from the REAL cedar files, the real spend door (mock holds) and the real
// memory coach log; the model is the scripted stand-in or an injected fake, never a provider.
//
//   plan-draft   the lead of the round, while accepted or ready; a panel member, the recruiter, the hiring manager, another
//                round's interviewer and the admin get 404; a guest holds no staff session and gets the gate's 401; another tenant's role
//                is refused at the mount; a live round is 409.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true, cloudwatch: true, guardrails: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const root = path.join(__dirname, '..', '..', '..', 'seeds', 'roles');
  const roles = fs.readdirSync(root, { withFileTypes: true }).filter((d: import('node:fs').Dirent) => d.isDirectory()).flatMap((d: import('node:fs').Dirent) =>
    fs.readdirSync(path.join(root, d.name)).filter((f: string) => f.endsWith('.cedar')).map((f: string) => {
      const cedar = fs.readFileSync(path.join(root, d.name, f), 'utf8').replace(/\/\/[^\n]*/g, '');
      const caps = new Set<string>();
      for (const block of cedar.split(/\bpermit\b/).slice(1)) {
        for (const m of (block.split(';')[0] ?? '').matchAll(/OrgIQ::Action::"([^"]+)"/g)) caps.add(m[1]!);
      }
      return { id: f.replace(/\.cedar$/, ''), tenant: d.name, label: '', summary: '', capabilities: [...caps] };
    }));
  return { roleRegistry: () => [...roles, { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] }] };
});
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn(), getUser: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';
import { interviewOpeningsFixture, interviewsFixture } from '../../mock/interviews.js';
import { interviewCoachLogFixture } from '../../mock/interviews-coach-log.js';
import { spendHolds } from '../../mock/spend-holds.js';
import { spendEntries } from '../../mock/spend-ledger.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-third', 'Ola Brandt', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
  u('u-operator', 'Platform Operator', { orgiq: ['admin'], interviews: ['admin'] }),
  u('guest:inv-nadia', 'Nadia Petrova', { interviews: ['guest'] }),
];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers['x-user'] ?? '');
  // A guest holds no staff session: lib/session.ts marks a guest-only request's session invalid, so every staff gate answers 401.
  if (id.startsWith('guest:')) { req.sessionInvalid = true; next(); return; }
  const me = USERS.find((x) => x.id === id);
  if (me) {
    const tenant = String(req.headers['x-tenant'] ?? 'interviews');
    const role = String(req.headers['x-role'] ?? me.grants[tenant]?.[0] ?? 'none');
    req.session = { sub: id, tenant, role, grants: me.grants, iat: 0, epoch: 0 } as Session;
  }
  next();
});
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

import { setCoachLogStore } from '../../lib/interviews/milo-notes/index.js';
import { ScriptedPlanModel, setPlanDeps, MAX_PLAN_DRAFTS, type PlanModel } from '../../lib/interviews/plan/index.js';

const API = '/api/interviews';
const who = (id: string, tenant = 'interviews') => ({
  post: (p: string) => request(app).post(`${API}${p}`).set('x-user', id).set('x-tenant', tenant).send({}),
});
const WEN = who('u-wen');
const HUGO = who('u-hugo');
const GRETA = who('u-greta');
const AMARA = who('u-amara');
const THIRD = who('u-third');
const OPERATOR = who('u-operator');
const GUEST = who('guest:inv-nadia');
const PRIYA = who('u-priya', 'access');

// Wen leads Nadia's leadership round (behavioural, 60 minutes, accepted) with Hugo on the panel; Hugo leads the design round.
const IV = 'iv-n5z9f2cq';
const OTHER_ROUND = 'iv-m8t3h6ng';
const draft = (as: ReturnType<typeof who>, id = IV) => as.post(`/interviews/${id}/plan-draft`);
const planRows = () => interviewCoachLogFixture.rows().filter((r) => r.interviewId === IV && r.kind === 'plan');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  spendHolds.reset();
  spendEntries.reset();
  setCoachLogStore(null);
  setPlanDeps({ model: () => new ScriptedPlanModel() });
});
afterAll(() => setPlanDeps(null));

const fake = (raw: string | null, over: Partial<{ code: 'ok' | 'timeout' | 'error'; sent: boolean }> = {}): PlanModel => ({
  kind: 'scripted', modelId: 'fake-plan', draft: async () => ({ raw, code: over.code ?? 'ok', sent: over.sent ?? true, usage: null }),
});

describe('who may ask', () => {
  it('the lead gets the stand-in\'s plan from the kit: behavioural questions only, one a ten minutes, one reason each', async () => {
    const res = await draft(WEN);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.paused).toBeNull();
    const ids = res.body.plan.questions.map((q: { questionId: string }) => q.questionId);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThanOrEqual(6);
    const kit = interviewOpeningsFixture.rows().find((o) => o.id === 'op-em')!.kit;
    for (const id of ids) expect(kit.questions.find((q) => q.id === id)?.roundType).toBe('behavioural');
    expect(new Set(ids).size).toBe(ids.length);
    for (const q of res.body.plan.questions) expect(q.why).toMatch(/^Serves /);
  });

  it.each([['a panel member', HUGO], ['the recruiter', GRETA], ['the hiring manager', AMARA], ['another round\'s interviewer', THIRD], ['the admin', OPERATOR]])('%s gets not-found and no row, no hold', async (_l, as) => {
    expect((await draft(as)).status).toBe(404);
    expect(planRows()).toHaveLength(0);
    expect(spendHolds.rows()).toHaveLength(0);
  });

  it('the lead of another round cannot ask about this one, and a guest and another tenant are refused', async () => {
    expect((await draft(HUGO, IV)).status).toBe(404);
    expect((await draft(WEN, OTHER_ROUND)).status).toBe(404);
    expect((await draft(GUEST)).status).toBe(401);
    expect((await draft(PRIYA)).status).toBe(403);
    expect(planRows()).toHaveLength(0);
  });

  it('is 409 with one plain line once the round is live', async () => {
    interviewsFixture.rows().find((i) => i.id === IV)!.state = 'live';
    const res = await draft(WEN);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ plan: null, line: 'You can ask Milo for a plan only before the round starts.' });
  });
});

describe('the draft', () => {
  it('is logged like a suggestion (kind plan, the ids and reasons as sources) and its hold is settled at zero', async () => {
    const res = await draft(WEN);
    const rows = planRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'plan', askedBy: 'u-wen', code: null, modelId: 'scripted-plan', promptVersion: 'milo-plan-2026-11-17.1' });
    expect(rows[0]!.sources).toEqual(res.body.plan.questions);
    const entry = spendEntries.rows().find((e) => e.sourceId.includes('plan-1'));
    expect(entry).toMatchObject({ costUsd: 0 });
  });

  it('drops an off-bank id and a judging reason, keeping the rest', async () => {
    setPlanDeps({ model: () => fake(JSON.stringify({ questions: [
      { questionId: 'not-a-question', why: 'Serves delivery.' }, { questionId: 'q-em-slip', why: 'This shows a strong candidate.' }, { questionId: 'q-em-struggling', why: 'Serves people leadership.' },
    ] })) });
    const res = await draft(WEN);
    expect(res.body.plan.questions).toEqual([{ questionId: 'q-em-struggling', why: 'Serves people leadership.' }]);
  });

  it('is no plan, in one plain line, when nothing survives, and logs only its code', async () => {
    setPlanDeps({ model: () => fake(JSON.stringify({ questions: [{ questionId: 'nope', why: 'Serves delivery.' }] })) });
    const res = await draft(WEN);
    expect(res.body).toEqual({ plan: null, paused: null, line: 'Milo could not draft a plan this time. Choose the questions yourself below.' });
    expect(planRows()[0]).toMatchObject({ code: 'off-kit', answer: '', sources: [] });
  });

  it('a failed call is logged by its code and does not use up one of the three drafts', async () => {
    setPlanDeps({ model: () => fake(null, { code: 'timeout' }) });
    for (let n = 0; n < 4; n++) expect((await draft(WEN)).body.plan).toBeNull();
    expect(planRows().every((r) => r.code === 'timeout')).toBe(true);
    setPlanDeps({ model: () => new ScriptedPlanModel() });
    expect((await draft(WEN)).body.plan).not.toBeNull();
  });

  it('allows three drafts, then says so without a call or a hold', async () => {
    for (let n = 0; n < MAX_PLAN_DRAFTS; n++) expect((await draft(WEN)).body.plan).not.toBeNull();
    const calls = jest.fn();
    setPlanDeps({ model: () => ({ ...fake('{}'), draft: async () => { calls(); return { raw: null, code: 'ok', sent: true, usage: null }; } }) });
    const res = await draft(WEN);
    expect(res.body).toEqual({ plan: null, paused: null, line: expect.stringContaining('three plans') });
    expect(calls).not.toHaveBeenCalled();
    expect(planRows()).toHaveLength(MAX_PLAN_DRAFTS);
  });

  it('is paused for the budget when the opening has no cap: no call, no row', async () => {
    interviewOpeningsFixture.rows().find((o) => o.id === 'op-em')!.budgetCapUsd = null;
    const calls = jest.fn();
    setPlanDeps({ model: () => ({ ...fake('{}'), draft: async () => { calls(); return { raw: null, code: 'ok', sent: true, usage: null }; } }) });
    expect((await draft(WEN)).body).toEqual({ plan: null, paused: 'budget', line: null });
    expect(calls).not.toHaveBeenCalled();
    expect(planRows()).toHaveLength(0);
  });
});

describe('two asks almost at once (hardening H3, O-128)', () => {
  it('a second ask while the first is drafting is told so in one line: one model call, one hold, one row', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const calls = jest.fn();
    const inner = new ScriptedPlanModel();
    setPlanDeps({ model: () => ({ kind: inner.kind, modelId: inner.modelId, draft: async (input) => { calls(); await gate; return inner.draft(input); } }) });
    const first = draft(WEN).then((r) => r);
    for (let i = 0; i < 50 && calls.mock.calls.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
    expect(calls).toHaveBeenCalledTimes(1);
    const second = await draft(WEN);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ plan: null, paused: null, line: 'Milo is already drafting a plan for this round.' });
    release();
    expect((await first).body.plan).not.toBeNull();
    expect(calls).toHaveBeenCalledTimes(1);
    expect(spendHolds.rows().filter((h) => h.source === 'interviews')).toHaveLength(1);
    expect(planRows()).toHaveLength(1);
  });

  it('two asks sent in the same moment still make one model call', async () => {
    const calls = jest.fn();
    const inner = new ScriptedPlanModel();
    setPlanDeps({ model: () => ({ kind: inner.kind, modelId: inner.modelId, draft: async (input) => { calls(); await new Promise((r) => setTimeout(r, 30)); return inner.draft(input); } }) });
    const both = await Promise.all([draft(WEN), draft(WEN)]);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(both.filter((r) => r.body.plan !== null)).toHaveLength(1);
    expect(planRows()).toHaveLength(1);
  });

  // O-128: draftPlan takes its in-flight mark before it reads the earlier drafts, so two asks in the same tick (two tabs a few
  // milliseconds apart against the SQL log) make one model call and cannot pass the three-draft cap.
  it('two asks that reach the service in the same tick make one model call', async () => {
    const { draftPlan } = await import('../../lib/interviews/plan/index.js');
    const { interviewApplicationsFixture } = await import('../../mock/interviews.js');
    const calls = jest.fn();
    const inner = new ScriptedPlanModel();
    setPlanDeps({ model: () => ({ kind: inner.kind, modelId: inner.modelId, draft: async (input) => { calls(); return inner.draft(input); } }) });
    const interview = interviewsFixture.rows().find((i) => i.id === IV)!;
    const app = interviewApplicationsFixture.rows().find((a) => a.id === interview.applicationId)!;
    const ref = { interview, opening: interviewOpeningsFixture.rows().find((o) => o.id === app.openingId)! };
    await Promise.all([draftPlan(ref, { userId: 'u-wen' }), draftPlan(ref, { userId: 'u-wen' })]);
    expect(calls).toHaveBeenCalledTimes(1);
  });
});
