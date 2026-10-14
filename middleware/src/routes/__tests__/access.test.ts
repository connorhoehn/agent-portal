// /api/access (routes/access.ts) — the access tenant's route contracts for A0
// (docs/access-tenant-goal.md §Routes, wire shapes docs/access-tenant-api.md),
// mounted as index.ts mounts it: `requireTenant('access')` at the mount, the
// Cedar action per route decided from the REAL seeds/roles/access/*.cedar files
// (read off disk below, never a typed list), the registered fixtures as the
// store, and the directory mocked so each case names whose grants decide it.
//
// The two row rules Cedar cannot see are pinned here:
//   * nobody decides a request they submitted or benefit from — 403 naming it;
//   * a step is decided once — a second decision is a 409.
// Lane A1's end-to-end (provisioning, the epoch, the bell, the catalog) is
// routes/__tests__/access-provision.test.ts.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
  // The role → action matrix the open-mode authz derives from the Cedar seeds,
  // read from the access tenant's actual files (role-registry.ts itself cannot
  // load under jest: it resolves its directory with import.meta.url).
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const dir = path.join(__dirname, '..', '..', '..', 'seeds', 'roles', 'access');
  const roles = fs.readdirSync(dir).filter((f: string) => f.endsWith('.cedar')).map((f: string) => {
    const cedar = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
    const caps = new Set<string>();
    for (const block of cedar.split(/\bpermit\b/).slice(1)) {
      for (const m of (block.split(';')[0] ?? '').matchAll(/OrgIQ::Action::"([^"]+)"/g)) caps.add(m[1]!);
    }
    return { id: f.replace(/\.cedar$/, ''), tenant: 'access', label: '', summary: '', capabilities: [...caps] };
  });
  return { roleRegistry: () => [...roles, { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] }] };
});
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { listUsers, type UserInfo } from '../../providers/identity.js';
import { accessRouter } from '../access.js';
import { accessCatalogFixture } from '../../mock/access-catalog.js';
import { accessPoliciesFixture } from '../../mock/access-policies.js';
import { accessPeopleFixture } from '../../mock/access-people.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture } from '../../mock/access-requests.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { initiatives } from '../../mock/initiatives.js';
import type { AccessEvent, AccessPolicy, AccessRequest, CatalogItem } from '../../lib/access/types.js';
import type { Session } from '../../lib/session.js';

const u = (id: string, personId: string | null, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName: id, email: null, personId, epoch: 0, grants });
const BASE: UserInfo[] = [
  u('u-rhea', 'p-rhea', { access: ['requester'] }),
  u('u-omar', 'p-omar', { access: ['approver'] }),
  u('u-priya', 'p-priya', { access: ['access-admin'] }),
  u('u-nora', 'p-004', { orgiq: ['sme'], social: ['participant'] }),
  u('u-hr', null, { orgiq: ['hr-admin'] }),
  u('u-vera', 'p-002', { orgiq: ['org-leader', 'member'] }),
  u('u-dara', null, { pipelines: ['pipeline-admin'] }),
  u('u-operator', null, { orgiq: ['admin'], access: ['admin'] }),
];
let users: UserInfo[];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers['x-user'] ?? '');
  const me = users.find((x) => x.id === id);
  if (me) {
    const tenant = String(req.headers['x-tenant'] ?? 'access');
    const role = String(req.headers['x-role'] ?? me.grants[tenant]?.[0] ?? 'none');
    req.session = { sub: id, tenant, role, grants: me.grants, iat: 0, epoch: 0 } as Session;
  }
  next();
});
app.use('/api/access', requireTenant('access'), accessRouter);
app.use(errorHandler);

const get = (path: string, as: string, headers: Record<string, string> = {}) => request(app).get(path).set({ 'x-user': as, ...headers });
const post = (path: string, as: string, body: unknown) => request(app).post(path).set('x-user', as).send(body as object);
const put = (path: string, as: string, body: unknown) => request(app).put(path).set('x-user', as).send(body as object);
const decide = (id: string, step: number, as: string, body: unknown) => request(app).post(`/api/access/requests/${id}/steps/${step}/decide`).set('x-user', as).send(body as object);
const asReq = (res: { body: unknown }) => res.body as AccessRequest;
const ids = (res: { body: unknown }) => (res.body as { items: Array<{ id: string }> }).items.map((x) => x.id).sort();
const JUST = 'Need it for the SSO cutover stories this sprint.';

beforeEach(() => {
  for (const f of [accessCatalogFixture, accessPoliciesFixture, accessPeopleFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture, identityGrantWritesFixture, initiatives]) f.reset();
  users = structuredClone(BASE);
  jest.mocked(listUsers).mockImplementation(async () => structuredClone(users));
});

describe('the tenant boundary and the Cedar gates', () => {
  it('refuses a session parked in another tenant at the mount', async () => {
    const res = await get('/api/access/summary', 'u-nora', { 'x-tenant': 'orgiq' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ requiredTenant: 'access' });
  });
  it('requester: no inbox, no scope=all, no policy edits', async () => {
    expect((await get('/api/access/approvals', 'u-rhea')).status).toBe(403);
    expect((await get('/api/access/requests?scope=all', 'u-rhea')).status).toBe(403);
    expect((await put('/api/access/policies/sod-001', 'u-rhea', { severity: 'warn' })).status).toBe(403);
    expect((await decide('req-0001', 1, 'u-rhea', { decision: 'approve' })).status).toBe(403);
  });
  it('approver decides but never configures; access-admin configures', async () => {
    expect((await put('/api/access/policies/sod-001', 'u-omar', { severity: 'warn' })).status).toBe(403);
    const res = await put('/api/access/policies/sod-001', 'u-priya', { severity: 'warn', reason: 'Downgraded while the envelope audit runs.' });
    expect(res.status).toBe(200);
    expect(res.body as AccessPolicy).toMatchObject({ id: 'sod-001', severity: 'warn', updatedBy: { id: 'u-priya' } });
    expect((await put('/api/access/policies/sod-404', 'u-priya', { severity: 'warn' })).status).toBe(404);
    expect((await put('/api/access/policies/sod-001', 'u-priya', { severity: 'never' })).status).toBe(400);
    expect((await put('/api/access/policies/sod-001', 'u-priya', {})).status).toBe(400);
  });
  it('every write refuses an unknown body key with a 400', async () => {
    expect((await post('/api/access/requests', 'u-rhea', { itemId: 'role:assessment:assessor', justification: JUST, duration: '7d', override: true })).status).toBe(400);
    expect((await decide('req-0001', 1, 'u-omar', { decision: 'approve', bulk: true })).status).toBe(400);
    expect((await put('/api/access/policies/sod-001', 'u-priya', { severity: 'warn', left: {} })).status).toBe(400);
    expect((await post('/api/access/requests/req-0001/withdraw', 'u-rhea', { status: 'approved' })).status).toBe(400);
  });
});

describe('reads', () => {
  it('summary counts from rows, per actor', async () => {
    expect((await get('/api/access/summary', 'u-rhea')).body).toEqual({ openRequests: 2, pendingForMe: 0, activeElevations: 0, policies: 4, reviews: 1 });
    expect((await get('/api/access/summary', 'u-omar')).body).toMatchObject({ openRequests: 2, pendingForMe: 1 });
    expect((await get('/api/access/summary', 'u-priya')).body).toMatchObject({ pendingForMe: 1, activeElevations: 1 });
  });
  it('catalog computes heldByActor and SoD conflicts from the actor\'s current grants', async () => {
    users.find((x) => x.id === 'u-rhea')!.grants = { access: ['requester'], orgiq: ['sme'] };
    const res = await get('/api/access/catalog', 'u-rhea');
    const items = (res.body as { items: CatalogItem[] }).items;
    expect(items).toHaveLength(9);
    expect(items.find((i) => i.id === 'role:orgiq:sme')).toMatchObject({ heldByActor: true, sodConflicts: [] });
    expect(items.find((i) => i.id === 'role:orgiq:org-leader')?.sodConflicts).toEqual([expect.objectContaining({ policyId: 'sod-001', severity: 'block' })]);
    expect(ids(await get('/api/access/catalog?kind=initiative-membership', 'u-rhea'))).toEqual(['initiative:p-auth-migration', 'initiative:p-observability']);
    expect((await get('/api/access/catalog?tenant=nowhere', 'u-rhea')).status).toBe(400);
  });
  it('scope: mine, reports (through people.manager_id) and all (DecideAccess, under the read rule)', async () => {
    expect(ids(await get('/api/access/requests', 'u-rhea'))).toEqual(['req-0001', 'req-0002', 'req-0005', 'req-0006']);
    expect(ids(await get('/api/access/requests?scope=reports', 'u-rhea'))).toEqual([]);
    expect(ids(await get('/api/access/requests?scope=reports', 'u-omar'))).toEqual(['req-0001', 'req-0002', 'req-0005', 'req-0006']);
    expect(ids(await get('/api/access/requests?scope=mine', 'u-omar'))).toEqual(['req-0003']);
    expect(ids(await get('/api/access/requests?scope=all', 'u-priya'))).toHaveLength(6);
    expect(ids(await get('/api/access/requests?scope=all&status=active', 'u-priya'))).toEqual(['req-0004']);
    expect((await get('/api/access/requests?scope=everyone', 'u-priya')).status).toBe(400);
  });
  it('a request outside the read rule is a 404, inside it carries chain, sod, can and thread', async () => {
    expect((await get('/api/access/requests/req-0004', 'u-rhea')).status).toBe(404);
    expect((await get('/api/access/requests/req-9999', 'u-priya')).status).toBe(404);
    const res = await get('/api/access/requests/req-0001', 'u-omar');
    expect(res.status).toBe(200);
    expect(asReq(res)).toMatchObject({
      id: 'req-0001', status: 'submitted', thread: 'access:req:req-0001',
      requester: { id: 'u-rhea', personId: 'p-rhea' }, item: { id: 'role:orgiq:sme', kind: 'tenant-role' },
      sod: { verdict: 'clear', conflicts: [] }, can: { decide: true, withdraw: false, viewAudit: true },
    });
    expect(asReq(res).steps.map((s) => [s.step, s.kind, s.status, s.eligible.map((p) => p.id)])).toEqual([
      [1, 'manager', 'current', ['u-omar']],
      // hr-admin stewards orgiq roles but holds no access grant: escalated to access-admin.
      [2, 'steward', 'waiting', ['u-priya']],
    ]);
  });
  it('approvals lists only steps the actor may decide now', async () => {
    expect(ids(await get('/api/access/approvals', 'u-omar'))).toEqual(['req-0001']);
    expect(ids(await get('/api/access/approvals', 'u-priya'))).toEqual(['req-0002']);
  });
  it('audit follows the request read rule; only an access admin reads every event', async () => {
    const own = (await get('/api/access/audit', 'u-rhea')).body as { items: AccessEvent[] };
    expect(new Set(own.items.map((e) => e.requestId))).toEqual(new Set(['req-0001', 'req-0002', 'req-0005', 'req-0006']));
    // Omar reads his own request and his report Rhea's — never Nora's req-0004, whose record he cannot open.
    const omar = (await get('/api/access/audit', 'u-omar')).body as { items: AccessEvent[] };
    expect(new Set(omar.items.map((e) => e.requestId))).toEqual(new Set(['req-0001', 'req-0002', 'req-0003', 'req-0005', 'req-0006']));
    expect(ids(await get('/api/access/audit?requestId=req-0004', 'u-omar'))).toEqual([]);
    expect((await get('/api/access/requests/req-0004', 'u-omar')).status).toBe(404);
    expect(ids(await get('/api/access/audit?requestId=req-0003', 'u-omar'))).toEqual(['evt-0004', 'evt-0005', 'evt-0006', 'evt-0007']);
    const all = (await get('/api/access/audit', 'u-priya')).body as { items: AccessEvent[] };
    expect(all.items).toHaveLength(accessEventsFixture.rows().length);
  });
  it('policies and reviews', async () => {
    expect(ids(await get('/api/access/policies', 'u-rhea'))).toEqual(['sod-001', 'sod-002', 'sod-003', 'sod-004']);
    // Lane A2: the seeded campaign; a requester sees it, but none of its items (they are not hers).
    expect((await get('/api/access/reviews', 'u-rhea')).body).toMatchObject({ items: [{ id: 'rev-0001', status: 'open', progress: { total: 0 }, can: { decide: false } }] });
  });
});

describe('submit', () => {
  it('computes the chain live and writes submitted + an event', async () => {
    const res = await post('/api/access/requests', 'u-rhea', { itemId: 'role:assessment:assessor', justification: JUST, duration: '7d' });
    expect(res.status).toBe(201);
    const r = asReq(res);
    expect(r).toMatchObject({ id: 'req-0007', status: 'submitted', duration: '7d', thread: 'access:req:req-0007', can: { decide: false, withdraw: true } });
    expect(r.steps.map((s) => [s.kind, s.status, s.eligible.map((p) => p.id)])).toEqual([['manager', 'current', ['u-omar']], ['steward', 'waiting', ['u-priya']]]);
    expect(accessEventsFixture.rows().filter((e) => e.requestId === 'req-0007').map((e) => e.kind)).toEqual(['submitted']);
    // The new row is in the store: Omar's inbox has it now.
    expect(ids(await get('/api/access/approvals', 'u-omar'))).toEqual(['req-0001', 'req-0007']);
  });
  it('a sensitive item adds an access-admin step', async () => {
    const r = asReq(await post('/api/access/requests', 'u-rhea', { itemId: 'role:assessment:lead-assessor', justification: JUST, duration: '7d' }));
    expect(r.steps.map((s) => s.kind)).toEqual(['manager', 'steward', 'access-admin']);
  });
  it('400s a bad body: short justification, unknown item, bad duration', async () => {
    expect((await post('/api/access/requests', 'u-rhea', { itemId: 'role:assessment:assessor', justification: 'too short', duration: '7d' })).status).toBe(400);
    expect((await post('/api/access/requests', 'u-rhea', { itemId: 'role:orgiq:admin', justification: JUST, duration: '7d' })).status).toBe(400);
    expect((await post('/api/access/requests', 'u-rhea', { itemId: 'role:assessment:assessor', justification: JUST, duration: 'forever' })).status).toBe(400);
  });
  it('on behalf: needs DecideAccess, and an approver files only for a report', async () => {
    expect((await post('/api/access/requests', 'u-rhea', { itemId: 'role:assessment:assessor', justification: JUST, duration: '7d', beneficiaryId: 'u-omar' })).status).toBe(403);
    expect((await post('/api/access/requests', 'u-omar', { itemId: 'role:assessment:assessor', justification: JUST, duration: '7d', beneficiaryId: 'u-priya' })).status).toBe(403);
    const res = await post('/api/access/requests', 'u-omar', { itemId: 'role:assessment:assessor', justification: JUST, duration: '7d', beneficiaryId: 'u-rhea' });
    expect(res.status).toBe(201);
    expect(asReq(res)).toMatchObject({ requester: { id: 'u-omar' }, beneficiary: { id: 'u-rhea' } });
    // Omar is Rhea's manager but the requester: the manager step escalates past him.
    expect(asReq(res).steps[0]).toMatchObject({ kind: 'manager', eligible: [{ id: 'u-priya' }] });
  });
  it('SoD block is a 409 carrying the conflicts; already-held and duplicate-open are 409s', async () => {
    const sod = await post('/api/access/requests', 'u-priya', { itemId: 'role:orgiq:org-leader', justification: JUST, duration: '7d', beneficiaryId: 'u-nora' });
    expect(sod.status).toBe(409);
    expect(sod.body).toMatchObject({ sod: { verdict: 'block', conflicts: [{ policyId: 'sod-001', severity: 'block' }] } });
    expect((await post('/api/access/requests', 'u-priya', { itemId: 'role:orgiq:sme', justification: JUST, duration: '7d', beneficiaryId: 'u-nora' })).status).toBe(409);
    expect((await post('/api/access/requests', 'u-rhea', { itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' })).body).toMatchObject({ requestId: 'req-0001' });
  });
});

describe('decide — the row rules', () => {
  it('nobody decides a request they submitted or benefit from (own request → 403)', async () => {
    const mine = asReq(await post('/api/access/requests', 'u-omar', { itemId: 'role:assessment:assessor', justification: JUST, duration: '7d' }));
    expect(mine.steps[0]).toMatchObject({ kind: 'manager', eligible: [{ id: 'u-priya' }] });
    const res = await decide(mine.id, 1, 'u-omar', { decision: 'approve' });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/^You cannot decide your own request/);
    // Filed on Rhea's behalf: Omar submitted it, so he cannot decide it either.
    const forRhea = asReq(await post('/api/access/requests', 'u-omar', { itemId: 'role:social:moderator', justification: JUST, duration: '7d', beneficiaryId: 'u-rhea' }));
    expect((await decide(forRhea.id, 1, 'u-omar', { decision: 'approve' })).body).toMatchObject({ error: expect.stringMatching(/own request — you submitted/) });
  });
  it('a step is decided once: the second decision is a 409', async () => {
    const first = await decide('req-0001', 1, 'u-omar', { decision: 'approve', comment: 'Fine for the sprint.' });
    expect(first.status).toBe(200);
    expect(asReq(first)).toMatchObject({ status: 'pending', can: { decide: false } });
    expect(asReq(first).steps.map((s) => s.status)).toEqual(['approved', 'current']);
    const again = await decide('req-0001', 1, 'u-omar', { decision: 'approve' });
    expect(again.status).toBe(409);
    expect((await decide('req-0001', 1, 'u-omar', { decision: 'reject', comment: 'changed my mind' })).status).toBe(409);
  });
  it('an approver not eligible for the step is refused; the last approval provisions (A1: approved → active)', async () => {
    await decide('req-0001', 1, 'u-omar', { decision: 'approve' });
    expect((await decide('req-0001', 2, 'u-omar', { decision: 'approve' })).status).toBe(403);
    const done = await decide('req-0001', 2, 'u-priya', { decision: 'approve' });
    expect(done.status).toBe(200);
    expect(asReq(done)).toMatchObject({ status: 'active', provisionedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(Date.parse(asReq(done).expiresAt!) - Date.parse(asReq(done).provisionedAt!)).toBe(30 * 24 * 3_600_000);
    expect(asReq(done).decidedAt).toEqual(expect.any(String));
    expect(accessEventsFixture.rows().filter((e) => e.requestId === 'req-0001').map((e) => e.kind)).toEqual(['submitted', 'step-approved', 'step-approved', 'approved', 'provisioned']);
    expect((await decide('req-0001', 2, 'u-priya', { decision: 'approve' })).status).toBe(409);
  });
  it('a waiting step is a 409; a missing step is a 409; an unreadable request is a 404', async () => {
    expect((await decide('req-0001', 2, 'u-priya', { decision: 'approve' })).status).toBe(409);
    expect((await decide('req-0001', 7, 'u-omar', { decision: 'approve' })).status).toBe(409);
    expect((await decide('req-0001', 0, 'u-omar', { decision: 'approve' })).status).toBe(400);
    users.push(u('u-zed', 'p-zed', { access: ['approver'] }));
    expect((await decide('req-0001', 1, 'u-zed', { decision: 'approve' })).status).toBe(404);
  });
  it('reject needs a comment, ends the request and skips the rest', async () => {
    expect((await decide('req-0001', 1, 'u-omar', { decision: 'reject' })).status).toBe(400);
    const res = await decide('req-0001', 1, 'u-omar', { decision: 'reject', comment: 'Not this quarter.' });
    expect(asReq(res)).toMatchObject({ status: 'rejected' });
    expect(asReq(res).steps.map((s) => s.status)).toEqual(['rejected', 'skipped']);
  });
  it('info keeps the step open for a later decision', async () => {
    const info = await decide('req-0002', 2, 'u-priya', { decision: 'info', comment: 'Which two sprints?' });
    expect(asReq(info).steps[1]).toMatchObject({ status: 'info-requested', comment: 'Which two sprints?' });
    expect(asReq(await decide('req-0002', 2, 'u-priya', { decision: 'approve' })).status).toBe('active');
  });
  it('eligibility is live: a demoted approver can no longer decide', async () => {
    users.find((x) => x.id === 'u-omar')!.grants = {};
    // Omar's signed session still says approver (Cedar passes); the live directory does not.
    const res = await request(app).post('/api/access/requests/req-0001/steps/1/decide').set({ 'x-user': 'u-omar', 'x-role': 'approver' }).send({ decision: 'approve' });
    // He still reads it (people.manager_id makes him Rhea's manager) but may not decide it.
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toMatch(/not eligible/);
    expect(ids(await get('/api/access/approvals', 'u-priya'))).toEqual(['req-0001', 'req-0002']);
  });
});

describe('withdraw', () => {
  it('the requester withdraws an open request once; a closed one is a 409', async () => {
    const res = await post('/api/access/requests/req-0001/withdraw', 'u-rhea', { reason: 'Picked up other work.' });
    expect(res.status).toBe(200);
    expect(asReq(res)).toMatchObject({ status: 'withdrawn', can: { withdraw: false } });
    expect(asReq(res).steps.map((s) => s.status)).toEqual(['skipped', 'skipped']);
    expect((await post('/api/access/requests/req-0001/withdraw', 'u-rhea', {})).status).toBe(409);
    expect((await post('/api/access/requests/req-0005/withdraw', 'u-rhea', {})).status).toBe(409);
  });
  it('someone who may read it but is no party cannot withdraw it; an unreadable one is a 404', async () => {
    expect((await post('/api/access/requests/req-0002/withdraw', 'u-omar', {})).status).toBe(403);
    expect((await post('/api/access/requests/req-0004/withdraw', 'u-rhea', {})).status).toBe(404);
  });
});
