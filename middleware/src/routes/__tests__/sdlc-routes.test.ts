// AI SDLC governance — /api/sdlc (routes/sdlc.ts). The surface for code an
// agent wrote: policies, change requests, the human decision, the re-review,
// the "address the feedback" loop, and delivery.
//
// What is pinned:
//   * GET /policies SEEDS the defaults on first read, so a fresh environment
//     is governed rather than wide open the moment someone opens the page —
//     and a seeding failure still lets the list render,
//   * the policy `kind` allow-list, and that an unknown kind is refused with
//     the valid ones NAMED,
//   * `action` defaults to require_approval: only the literal 'block' blocks,
//     so a typo cannot silently turn a gate into a hard stop,
//   * the decision is attributed to the SESSION, never the body,
//   * the loop-closing rule on /address: the agent is handed the REVIEWER'S
//     OWN words (summary + findings), not a paraphrase, and an already-approved
//     change has nothing to address,
//   * the status codes that carry meaning: 202 for a dispatched run (work
//     started, not finished), 503 when the devbox runtime is absent, 409 when
//     delivery itself was refused,
//   * the wire envelopes (`{policies}` / `{changes}` / `{change}`).

// Open-mode authz (no policy store) over the REAL Cedar seeds, so each route's
// action is decided by the role matrix the seeds define (DE-42).
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: {}, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../providers/sdlc.js', () => ({
  listChangeRequests: jest.fn(), getChangeRequest: jest.fn(),
  decideChange: jest.fn(), evaluateChange: jest.fn(), recordReview: jest.fn(),
  markInReview: jest.fn(), listEvaluations: jest.fn(), hasChangesRequestedBy: jest.fn(async () => false),
}));
jest.mock('../../lib/change-reviewer.js', () => ({ reviewDiff: jest.fn() }));
jest.mock('../../lib/sdlc-pipeline.js', () => ({
  deliverApprovedChange: jest.fn(), dispatchGovernedRun: jest.fn(),
}));
jest.mock('../../providers/agent-projects.js', () => ({
  getAgentProject: jest.fn(), checkoutPath: jest.fn(() => '/mnt/workspace/repo'),
}));
jest.mock('../../lib/devbox-arn.js', () => ({
  resolveDevboxArn: jest.fn(), devboxDataClient: jest.fn(() => ({})),
}));
const scope = { deny: new Set<string>(), calls: [] as Array<{ initiativeId: unknown; opts: unknown }> };
jest.mock('../../lib/initiative-scope.js', () => ({
  ORG_WIDE_INITIATIVE_ROLES: ['org-leader', 'hr-admin', 'admin'],
  stewardsInitiative: jest.fn(async (session: { role?: string } | null, initiativeId: string) =>
    !!session && (['org-leader', 'hr-admin', 'admin'].includes(session.role ?? '') || !scope.deny.has(initiativeId))),
  requireInitiativeScope: jest.fn(async (_req: unknown, res: { status(n: number): { json(b: unknown): void } }, initiativeId: string | null, opts: unknown) => {
    scope.calls.push({ initiativeId, opts });
    if (initiativeId && scope.deny.has(initiativeId)) { res.status(403).json({ error: 'not your initiative' }); return false; }
    return true;
  }),
}));

import express, { type Request, type Response, type NextFunction } from 'express';
import request from '../../test-support/http.js';
import { sdlcRouter } from '../sdlc.js';
import { errorHandler } from '../../lib/async-handler.js';
import {
  listChangeRequests, getChangeRequest, decideChange, evaluateChange,
  recordReview, markInReview, hasChangesRequestedBy,
} from '../../providers/sdlc.js';
import { sdlcPolicyVersions, sdlcPolicyProposals } from '../../mock/sdlc.js';
import { latestPolicySet } from '../../providers/sdlc-policy-sets.js';
import { recentAuthzEvents } from '../../lib/audit.js';
import { reviewDiff } from '../../lib/change-reviewer.js';
import { deliverApprovedChange, dispatchGovernedRun } from '../../lib/sdlc-pipeline.js';
import { getAgentProject } from '../../providers/agent-projects.js';
import { resolveDevboxArn } from '../../lib/devbox-arn.js';

const m = <T,>(fn: T): jest.Mock => fn as unknown as jest.Mock;

const CHANGE = {
  id: 'cr-1', projectId: 'ap-1', title: 'Add retry to the Data API call',
  status: 'changes_requested', diff: 'diff --git a b', diffTruncated: false,
  reviews: [{
    model: 'amazon.nova-pro-v1:0', verdict: 'changes_requested',
    summary: 'Retry is unbounded.',
    findings: [
      { file: 'src/a.ts', line: 12, note: 'cap the retries' },
      { file: null, line: null, note: 'add a test' },
    ],
  }],
};

const PROJECT = {
  id: 'ap-1', sessionId: 'sess-'.padEnd(40, 'x'), repoFullName: 'org/repo',
  defaultBranch: 'main', connectionName: 'orgiq-github-org',
};

const SME = { sub: 'u-eli', role: 'sme', tenant: 'orgiq' };
const HR = { sub: 'u-hr', role: 'hr-admin', tenant: 'orgiq' };
const HR2 = { sub: 'u-hr2', role: 'hr-admin', tenant: 'orgiq' };
const ADMIN = { sub: 'u-admin', role: 'admin', tenant: 'orgiq' };
const MEMBER = { sub: 'u-mel', role: 'member', tenant: 'orgiq' };

function buildApp(session: Record<string, unknown> | null = SME) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (session) (req as unknown as { session: unknown }).session = session;
    next();
  });
  app.use('/api/sdlc', sdlcRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  m(hasChangesRequestedBy).mockResolvedValue(false);
  sdlcPolicyVersions.reset('default');
  sdlcPolicyProposals.reset('default');
  scope.deny.clear(); scope.calls.length = 0;
});

describe('initiative scope on change routes (DE-44 rows 16–19)', () => {
  const ON_BILLING = { ...PROJECT, orgProjectId: 'p-billing' };
  beforeEach(() => {
    scope.deny.add('p-billing');
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(ON_BILLING);
    m(resolveDevboxArn).mockResolvedValue('arn:devbox');
  });

  it('refuses decide, rereview, address and deliver on a change outside the caller\'s initiatives', async () => {
    const app = buildApp({ sub: 'u-nora', role: 'sme' });
    expect((await request(app).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'approve' })).status).toBe(403);
    expect((await request(app).post('/api/sdlc/changes/cr-1/rereview').send({})).status).toBe(403);
    expect((await request(app).post('/api/sdlc/changes/cr-1/address').send({})).status).toBe(403);
    expect((await request(app).post('/api/sdlc/changes/cr-1/deliver').send({})).status).toBe(403);
    expect(decideChange).not.toHaveBeenCalled();
    expect(reviewDiff).not.toHaveBeenCalled();
    expect(dispatchGovernedRun).not.toHaveBeenCalled();
    expect(deliverApprovedChange).not.toHaveBeenCalled();
    // Addressing dispatches a run, so it is the one that asks the spend question.
    expect(scope.calls.map((c) => (c.opts as { spend?: boolean }).spend === true)).toEqual([false, false, true, false]);
  });

  it('a decide on an unknown change is a 404 before anything is asked', async () => {
    m(getChangeRequest).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-x/decide').send({ decision: 'approve' });
    expect(res.status).toBe(404);
    expect(decideChange).not.toHaveBeenCalled();
  });
});

describe('GET /policies', () => {
  it('lists the org set\'s current version, bootstrapped so a fresh environment is governed', async () => {
    sdlcPolicyVersions.rows().length = 0;
    const res = await request(buildApp()).get('/api/sdlc/policies');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['policies', 'scope', 'version']);
    expect(res.body).toMatchObject({ scope: 'org', version: 1 });
    expect(res.body.policies).toHaveLength(4);
  });

  // A scale audit flagged this as an unbounded read. `limit` is optional and
  // silently clamped rather than 400ing, so the no-params default still ships
  // everything a normal policy set has.
  it('clamps `limit`, defaulting to the full policy set', async () => {
    const full = await request(buildApp()).get('/api/sdlc/policies');
    expect(full.body.policies).toHaveLength(4);
    const capped = await request(buildApp()).get('/api/sdlc/policies?limit=1');
    expect(capped.body.policies).toHaveLength(1);
  });

  it('is a ManageDevbox read: a member gets 403', async () => {
    expect((await request(buildApp(MEMBER)).get('/api/sdlc/policies')).status).toBe(403);
  });
});

describe('POST /policies (legacy, writes a new org version)', () => {
  it('requires a name and refuses an unknown kind, NAMING the valid ones', async () => {
    const app = buildApp(HR);
    const noName = await request(app).post('/api/sdlc/policies').send({ kind: 'max_files' });
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/name is required/);

    const badKind = await request(app).post('/api/sdlc/policies').send({ name: 'x', kind: 'vibes' });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error).toMatch(/require_review, protected_paths, max_files, model_allowlist, max_cost/);
    expect((await latestPolicySet('org'))!.version).toBe(1);
  });

  it('defaults action to require_approval — only the literal "block" blocks', async () => {
    // A typo must not silently turn a gate that asks for a human into a hard
    // stop, or into one that no longer asks.
    const app = buildApp(HR);
    // Bound to a local, not inline: this is request INPUT, and the wire sweep
    // reads an inline `action:` string on a policy-shaped literal as a fixture
    // claiming a value the server sends.
    const typo = 'blocK';
    const actions: string[] = [];
    for (const action of [undefined, typo, 'block']) {
      const res = await request(app).post('/api/sdlc/policies').send({ name: 'a', kind: 'max_files', config: { max: 5 }, ...(action ? { action } : {}) });
      expect(res.status).toBe(201);
      actions.push(res.body.policy.action);
    }
    expect(actions).toEqual(['require_approval', 'require_approval', 'block']);
  });

  it('creates with 201 as a new org version attributed to the session, trimming the name', async () => {
    const res = await request(buildApp(HR)).post('/api/sdlc/policies').send({ name: '  Cap files  ', kind: 'max_files', config: { max: 9 } });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual(['policy']);
    expect(res.body.policy).toMatchObject({ name: 'Cap files', enabled: true, kind: 'max_files', action: 'require_approval' });
    expect(await latestPolicySet('org')).toMatchObject({ version: 2, changedBy: 'u-hr', basedOn: 1 });
  });

  it('sme gets 403 on POST and DELETE (EditSdlcPolicy, DE-42/43)', async () => {
    const app = buildApp(SME);
    const post = await request(app).post('/api/sdlc/policies').send({ name: 'a', kind: 'max_files' });
    expect(post.status).toBe(403);
    expect(post.body.action).toBe('EditSdlcPolicy');
    const policyId = (await latestPolicySet('org'))!.policies[1]!.id;
    expect((await request(app).delete(`/api/sdlc/policies/${policyId}`)).status).toBe(403);
    expect((await latestPolicySet('org'))!.version).toBe(1);
  });

  it('a loosening edit by hr-admin is 202 pending, evaluation unchanged until a second holder approves; the proposer gets 409', async () => {
    const large = (await latestPolicySet('org'))!.policies.find((p) => p.kind === 'max_files')!;
    const res = await request(buildApp(HR)).post('/api/sdlc/policies').send({ ...large, config: { max: 400 } });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ pending: true, proposal: { status: 'pending', proposedBy: 'u-hr', scope: 'org', baseVersion: 1 } });
    expect((await latestPolicySet('org'))!.version).toBe(1);

    const id = res.body.proposal.id as string;
    const own = await request(buildApp(HR)).post(`/api/sdlc/policy-proposals/${id}/decide`).send({ decision: 'approve' });
    expect(own.status).toBe(409);
    expect(own.body.gate).toBe('self-approval');
    // An SME holds no EditSdlcPolicy and is not an org-leader.
    expect((await request(buildApp(SME)).post(`/api/sdlc/policy-proposals/${id}/decide`).send({ decision: 'approve' })).status).toBe(403);

    const second = await request(buildApp(HR2)).post(`/api/sdlc/policy-proposals/${id}/decide`).send({ decision: 'approve' });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, status: 'approved', set: { version: 2 } });
    expect((await latestPolicySet('org'))!.policies.find((p) => p.id === large.id)!.config).toEqual({ max: 400 });
  });

  it('an org-leader may approve a loosening proposal (DE-43 §4)', async () => {
    const large = (await latestPolicySet('org'))!.policies.find((p) => p.kind === 'max_files')!;
    const res = await request(buildApp(HR)).post('/api/sdlc/policies').send({ ...large, enabled: false });
    expect(res.status).toBe(202);
    const out = await request(buildApp({ sub: 'u-vera', role: 'org-leader', tenant: 'orgiq' }))
      .post(`/api/sdlc/policy-proposals/${res.body.proposal.id}/decide`).send({ decision: 'approve' });
    expect(out.status).toBe(200);
  });

  it('a caller the rules have gated gets 409 self-gated', async () => {
    m(hasChangesRequestedBy).mockResolvedValue(true);
    const res = await request(buildApp(HR)).post('/api/sdlc/policies').send({ name: 'a', kind: 'max_files', config: { max: 5 } });
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('self-gated');
  });
});

describe('DELETE /policies/:id', () => {
  it('404s an unknown policy; removing an enabled one is loosening, so it waits', async () => {
    const missing = await request(buildApp(HR)).delete('/api/sdlc/policies/p-x');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/No such policy/);

    const cost = (await latestPolicySet('org'))!.policies.find((p) => p.kind === 'max_cost')!;
    const res = await request(buildApp(HR)).delete(`/api/sdlc/policies/${cost.id}`);
    expect(res.status).toBe(202);
    expect(res.body.proposal.loosening).toEqual([`removes "${cost.name}"`]);
  });

  it('refuses to remove the independent-review policy (DE-43 §5)', async () => {
    const review = (await latestPolicySet('org'))!.policies.find((p) => p.kind === 'require_review')!;
    const res = await request(buildApp(HR)).delete(`/api/sdlc/policies/${review.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/independent-review policy cannot be removed/);
  });
});

describe('policy sets (DE-46 routes)', () => {
  it('PUT applies a tightening edit as the next version; a stale baseVersion is 409', async () => {
    const policies = (await latestPolicySet('org'))!.policies.map((p) => (p.kind === 'max_files' ? { ...p, config: { max: 10 } } : p));
    const ok = await request(buildApp(HR)).put('/api/sdlc/policy-sets/org').send({ policies, baseVersion: 1, reason: 'tighter' });
    expect(ok.status).toBe(201);
    expect(ok.body.set).toMatchObject({ scope: 'org', version: 2, changedBy: 'u-hr', reason: 'tighter' });
    const stale = await request(buildApp(HR)).put('/api/sdlc/policy-sets/org').send({ policies, baseVersion: 1, reason: 'again' });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ gate: 'stale-base', currentVersion: 2 });
    const history = await request(buildApp(SME)).get('/api/sdlc/policy-sets/org/versions');
    expect(history.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
  });

  it('requires a reason', async () => {
    const policies = (await latestPolicySet('org'))!.policies;
    expect((await request(buildApp(HR)).put('/api/sdlc/policy-sets/org').send({ policies, baseVersion: 1 })).status).toBe(400);
  });

  it('an sme not on initiative A gets 403 on PUT /policy-sets/A', async () => {
    scope.deny.add('p-billing');
    const policies = (await latestPolicySet('org'))!.policies;
    const res = await request(buildApp(SME)).put('/api/sdlc/policy-sets/p-billing').send({ policies, baseVersion: 0, reason: 'x' });
    expect(res.status).toBe(403);
  });

  it('an initiative with no set of its own reads the org set it inherits', async () => {
    const res = await request(buildApp(SME)).get('/api/sdlc/policy-sets/p-billing');
    expect(res.body).toMatchObject({ scope: 'p-billing', inherited: true, set: { scope: 'org', version: 1 } });
  });
});

describe('GET /changes', () => {
  it('forwards projectId and the open flag only when they are set', async () => {
    m(listChangeRequests).mockResolvedValue([CHANGE]);
    const app = buildApp();
    const all = await request(app).get('/api/sdlc/changes');
    expect(Object.keys(all.body)).toEqual(['changes']);

    await request(app).get('/api/sdlc/changes?projectId=ap-1&open=true');
    await request(app).get('/api/sdlc/changes?open=false');
    expect(m(listChangeRequests).mock.calls.map((c) => c[0]))
      .toEqual([{}, { projectId: 'ap-1', open: true }, {}]);
  });

  it('GET /changes/:id 404s an unknown change', async () => {
    m(getChangeRequest).mockResolvedValue(null);
    const res = await request(buildApp()).get('/api/sdlc/changes/cr-x');
    expect(res.status).toBe(404);

    m(getChangeRequest).mockResolvedValue(CHANGE);
    const ok = await request(buildApp()).get('/api/sdlc/changes/cr-1');
    expect(Object.keys(ok.body)).toEqual(['change']);
    expect(ok.body.change.reviews[0].verdict).toBe('changes_requested');
  });
});

describe('POST /changes/:id/decide', () => {
  beforeEach(() => { m(getChangeRequest).mockResolvedValue({ ...CHANGE, requestedBy: 'u-nora' }); m(getAgentProject).mockResolvedValue({ ...PROJECT, orgProjectId: 'p-obs' }); });

  it('refuses anything but approve/reject', async () => {
    const app = buildApp();
    for (const decision of [undefined, 'maybe', 'Approve']) {
      const res = await request(app).post('/api/sdlc/changes/cr-1/decide').send({ decision });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/decision must be approve or reject/);
    }
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('a different SME on the initiative gets 200, attributed to the SESSION, not the body', async () => {
    m(decideChange).mockResolvedValue({ ok: true, status: 'approved' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/decide')
      .send({ decision: 'approve', note: 'ship it', by: 'somebody-else' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: 'approved' });
    expect(decideChange).toHaveBeenCalledWith('cr-1', 'approve', { by: 'u-eli', role: 'sme', note: 'ship it', override: false });
  });

  it('the requester gets 409 self-approval (DE-43)', async () => {
    const res = await request(buildApp({ sub: 'u-nora', role: 'sme', tenant: 'orgiq' })).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'approve' });
    expect(res.status).toBe(409);
    expect(res.body.gate).toBe('self-approval');
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('admin with override: true decides their own change and leaves one DecideAgentChange.Override audit line', async () => {
    m(getChangeRequest).mockResolvedValue({ ...CHANGE, requestedBy: 'u-admin' });
    m(decideChange).mockResolvedValue({ ok: true, status: 'approved' });
    const before = recentAuthzEvents({ limit: 1000 }).filter((e) => e.action === 'DecideAgentChange.Override').length;
    const res = await request(buildApp(ADMIN)).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'approve', override: true });
    expect(res.status).toBe(200);
    expect(decideChange).toHaveBeenCalledWith('cr-1', 'approve', expect.objectContaining({ by: 'u-admin', override: true }));
    expect(recentAuthzEvents({ limit: 1000 }).filter((e) => e.action === 'DecideAgentChange.Override').length).toBe(before + 1);
  });

  it('override is admin-only', async () => {
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'approve', override: true });
    expect(res.status).toBe(400);
  });

  it('no session gets 401, never a null decider', async () => {
    // An invalid cookie is "no session" even where the demo fallback would
    // otherwise stand in a demo user (who is then a real, named decider).
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as unknown as { sessionInvalid: boolean }).sessionInvalid = true; next(); });
    app.use('/api/sdlc', sdlcRouter);
    const res = await request(app).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'reject' });
    expect(res.status).toBe(401);
    expect(decideChange).not.toHaveBeenCalled();
  });

  it('409s a provider refusal that carries a gate, 400s one that does not', async () => {
    m(decideChange).mockResolvedValue({ ok: false, gate: 'unattributed', error: 'nobody is recorded' });
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'approve' })).status).toBe(409);
    m(decideChange).mockResolvedValue({ ok: false, error: 'change is already delivered' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/decide').send({ decision: 'approve' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('change is already delivered');
  });
});

describe('DE-42 actions on the change routes', () => {
  beforeEach(() => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue({ ...PROJECT, orgProjectId: 'p-obs' });
    m(resolveDevboxArn).mockResolvedValue('arn:devbox');
  });

  it('member gets 403 on decide, deliver, rereview and address, naming the action', async () => {
    const app = buildApp(MEMBER);
    const cases: Array<[string, string]> = [
      ['decide', 'DecideAgentChange'], ['deliver', 'DeliverAgentChange'],
      ['rereview', 'RunDevboxTask'], ['address', 'RunDevboxTask'],
    ];
    for (const [route, action] of cases) {
      const res = await request(app).post(`/api/sdlc/changes/cr-1/${route}`).send({ decision: 'approve' });
      expect([route, res.status, res.body.action]).toEqual([route, 403, action]);
    }
  });

  it('an sme on a change of an initiative they are not on gets 403 NOT_ON_INITIATIVE', async () => {
    // The refusal body comes from the real requireInitiativeScope (lib/initiative-scope.ts), pinned there.
    scope.deny.add('p-obs');
    for (const route of ['decide', 'deliver', 'rereview', 'address']) {
      expect((await request(buildApp()).post(`/api/sdlc/changes/cr-1/${route}`).send({ decision: 'approve' })).status).toBe(403);
    }
  });

  it('a social participant and an assessment assessor get 403 on /api/sdlc POSTs at the mount', async () => {
    const { requireTenant, requireSession } = jest.requireActual('../../lib/authz.js') as typeof import('../../lib/authz.js');
    for (const who of [{ sub: 'u-p', role: 'participant', tenant: 'social' }, { sub: 'u-a', role: 'assessor', tenant: 'assessment' }]) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { (req as unknown as { session: unknown }).session = who; next(); });
      app.use('/api/sdlc', requireTenant('orgiq'), requireSession('ViewSdlc'), sdlcRouter);
      for (const path of ['/api/sdlc/changes/cr-1/decide', '/api/sdlc/policies', '/api/sdlc/changes/cr-1/deliver']) {
        expect((await request(app).post(path).send({ decision: 'approve', name: 'a', kind: 'max_files' })).status).toBe(403);
      }
    }
  });

  it('rereview passes repin through and reports the version it used', async () => {
    m(reviewDiff).mockResolvedValue({ model: 'm', verdict: 'approve', summary: 's', findings: [] });
    m(evaluateChange).mockResolvedValue({ status: 'approved', policyScope: 'org', policyVersion: 2, evaluationSeq: 3, repinned: true });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/rereview').send({ repin: true });
    expect(res.status).toBe(200);
    expect(evaluateChange).toHaveBeenCalledWith('cr-1', { repin: true });
    expect(res.body).toMatchObject({ policyVersion: 2, repinned: true, evaluationSeq: 3 });
  });
});

describe('POST /changes/:id/rereview', () => {
  it('404s an unknown change and refuses one with no stored diff', async () => {
    m(getChangeRequest).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-x/rereview').send({})).status).toBe(404);

    m(getChangeRequest).mockResolvedValue({ ...CHANGE, diff: null });
    const noDiff = await request(buildApp()).post('/api/sdlc/changes/cr-1/rereview').send({});
    expect(noDiff.status).toBe(400);
    expect(noDiff.body.error).toMatch(/no stored diff/);
    expect(reviewDiff).not.toHaveBeenCalled();
  });

  it('marks in-review, re-reviews the STORED diff, records it, then re-evaluates', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(reviewDiff).mockResolvedValue({
      model: 'amazon.nova-pro-v1:0', verdict: 'approve', summary: 'fixed', findings: [],
    });
    m(evaluateChange).mockResolvedValue({ status: 'approved' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/rereview').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, verdict: 'approve', status: 'approved', repinned: false });

    // No new agent run — the diff is already captured, which is the point.
    expect(m(reviewDiff).mock.calls[0]![0]).toEqual({
      title: CHANGE.title, diff: CHANGE.diff, truncated: false, taskPrompt: null,
    });
    const order = [
      m(markInReview).mock.invocationCallOrder[0]!,
      m(reviewDiff).mock.invocationCallOrder[0]!,
      m(recordReview).mock.invocationCallOrder[0]!,
      m(evaluateChange).mock.invocationCallOrder[0]!,
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('POST /changes/:id/address', () => {
  it('refuses when there is nothing to address', async () => {
    const app = buildApp();
    m(getChangeRequest).mockResolvedValue({ ...CHANGE, reviews: [] });
    const noReview = await request(app).post('/api/sdlc/changes/cr-1/address').send({});
    expect(noReview.status).toBe(400);
    expect(noReview.body.error).toMatch(/no review feedback to address/);

    m(getChangeRequest).mockResolvedValue({
      ...CHANGE, reviews: [{ ...CHANGE.reviews[0]!, verdict: 'approve' }],
    });
    const approved = await request(app).post('/api/sdlc/changes/cr-1/address').send({});
    expect(approved.status).toBe(400);
    expect(dispatchGovernedRun).not.toHaveBeenCalled();
  });

  it('hands the agent the REVIEWER\'S OWN words, file:line and all', async () => {
    // The loop only closes if the agent is fixing the stated objections rather
    // than guessing what "changes requested" meant.
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(dispatchGovernedRun).mockResolvedValue({ ok: true, runId: 'run-9' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({ model: 'nova-pro' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, runId: 'run-9' });

    const prompt = (m(dispatchGovernedRun).mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain('Retry is unbounded.');
    expect(prompt).toContain('- src/a.ts:12: cap the retries');
    expect(prompt).toContain('- add a test');
    expect(prompt).toContain(CHANGE.title);
    expect(prompt).toMatch(/Do not revert your earlier work/);
    expect((m(dispatchGovernedRun).mock.calls[0]![0] as { model: string }).model).toBe('nova-pro');
  });

  it('refuses a project with no live workspace, and 404s one that is gone', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({})).status).toBe(404);

    m(getAgentProject).mockResolvedValue({ ...PROJECT, sessionId: null });
    const noWorkspace = await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({});
    expect(noWorkspace.status).toBe(400);
    expect(noWorkspace.body.error).toMatch(/re-clone it/);
    expect(dispatchGovernedRun).not.toHaveBeenCalled();
  });

  it('503s when the run could not be dispatched', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(dispatchGovernedRun).mockResolvedValue({ ok: false, error: 'devbox runtime not deployed' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/address').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('devbox runtime not deployed');
  });
});

describe('POST /changes/:id/deliver', () => {
  it('404s an unknown change or a vanished project', async () => {
    m(getChangeRequest).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-x/deliver').send({})).status).toBe(404);

    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(null);
    expect((await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({})).status).toBe(404);
    expect(deliverApprovedChange).not.toHaveBeenCalled();
  });

  it('503s — not 500 — when the devbox runtime is not deployed', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(resolveDevboxArn).mockResolvedValue(null);
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({});
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/devbox runtime is not deployed/);
    expect(deliverApprovedChange).not.toHaveBeenCalled();
  });

  it('delivers with the project\'s own checkout + repo identity and returns the PR url', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(resolveDevboxArn).mockResolvedValue('arn:devbox');
    m(deliverApprovedChange).mockResolvedValue({ ok: true, prUrl: 'https://github.com/org/repo/pull/7' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, prUrl: 'https://github.com/org/repo/pull/7' });
    expect(m(deliverApprovedChange).mock.calls[0]![0]).toMatchObject({
      runtimeArn: 'arn:devbox', changeId: 'cr-1',
      project: {
        sessionId: PROJECT.sessionId, checkout: '/mnt/workspace/repo',
        repoFullName: 'org/repo', defaultBranch: 'main', connectionName: 'orgiq-github-org',
      },
    });
  });

  it('409s a refused delivery with its own reason', async () => {
    m(getChangeRequest).mockResolvedValue(CHANGE);
    m(getAgentProject).mockResolvedValue(PROJECT);
    m(resolveDevboxArn).mockResolvedValue('arn:devbox');
    m(deliverApprovedChange).mockResolvedValue({ ok: false, error: 'change is not approved' });
    const res = await request(buildApp()).post('/api/sdlc/changes/cr-1/deliver').send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('change is not approved');
  });
});
