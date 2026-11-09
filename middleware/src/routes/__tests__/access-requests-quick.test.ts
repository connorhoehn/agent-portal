// The in-tenant quick request (routes/access-requests-quick.ts, decided
// 2026-10-13) end to end, through the real cookie path as access-provision.test.ts
// walks it: a Work member meets locked budget figures on /api/graph/projects,
// files `capability:orgiq:budgets-read` from Work (no Access grant, no tenant
// switch), an access admin approves it in Access, and the member's EXISTING
// cookie shows the figures after the grants refresh — no sign-out.
//
// Plus the quick routes' refusals: another tenant's item (403), a duplicate
// open request (409 naming it), unknown keys (400), a session with no
// directory account (403), and the tier holder's projects payload unchanged.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1', aurora: {}, cognito: { portalOrigin: '' },
    auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, mock: { aurora: true },
  },
}));
jest.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) } }));
jest.mock('../../lib/role-registry.js', () => {
  // The open-mode matrix from the access tenant's REAL Cedar files (role-registry.ts
  // cannot load under jest: import.meta.url). Same derivation as access.test.ts.
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  // Social's too (G27): the plane names the Social role that grants posting by asking these.
  const roles = ['access', 'social'].flatMap((tenant: string) => {
    const dir = path.join(__dirname, '..', '..', '..', 'seeds', 'roles', tenant);
    return fs.readdirSync(dir).filter((f: string) => f.endsWith('.cedar')).map((f: string) => ({ f, dir, tenant }));
  }).map(({ f, dir, tenant }: { f: string; dir: string; tenant: string }) => {
    const cedar = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
    const caps = new Set<string>();
    for (const block of cedar.split(/\bpermit\b/).slice(1)) {
      for (const m of (block.split(';')[0] ?? '').matchAll(/OrgIQ::Action::"([^"]+)"/g)) caps.add(m[1]!);
    }
    return { id: f.replace(/\.cedar$/, ''), tenant, label: '', summary: '', capabilities: [...caps] };
  });
  return { roleRegistry: () => [...roles, { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] }] };
});
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { sessionMiddleware, setGrantsResolver } from '../../lib/session.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { getUser } from '../../providers/identity.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { sessionRouter } from '../session.js';
import { accessRouter } from '../access.js';
import { accessQuickRouter } from '../access-requests-quick.js';
import { projectsRouter } from '../projects.js';
import { accessCatalogFixture } from '../../mock/access-catalog.js';
import { accessPoliciesFixture } from '../../mock/access-policies.js';
import { accessPeopleFixture } from '../../mock/access-people.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture } from '../../mock/access-requests.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { initiatives } from '../../mock/initiatives.js';
import { BUDGET_READ_ITEM_ID } from '../../lib/budget-read-tier.js';
import type { AccessRequest } from '../../lib/access/types.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware());
app.use('/api/session', sessionRouter);
app.use('/api/access', requireTenant('access'), accessRouter);
app.use('/api/access-requests', accessQuickRouter);
app.use('/api/graph/projects', requireTenant('orgiq'), projectsRouter);
app.use(errorHandler);

let bell: Array<{ userId: string; kind: unknown; href: string | undefined }>;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
  const value = all.map((c) => c.split(';')[0]!).filter((c) => c.startsWith('orgiq.session=') && c.length > 'orgiq.session='.length).at(-1);
  if (!value) throw new Error('no session cookie was issued');
  return value;
}

/** Picker login, then (optionally) stand in `tenant`. */
async function signIn(userId: string, tenant?: string): Promise<string> {
  const login = await request(app).post('/api/session/login').send({ userId });
  expect(login.status).toBe(200);
  let cookie = cookieOf(login);
  if (tenant && (login.body as { tenant: string }).tenant !== tenant) {
    const sw = await request(app).post('/api/session/tenant').set('Cookie', cookie).send({ tenant });
    expect(sw.status).toBe(200);
    cookie = cookieOf(sw);
  }
  return cookie;
}

const JUST = 'I run the weekly delivery review and need to read spend against allocation.';
const quick = (cookie: string, body: Record<string, unknown>) => request(app).post('/api/access-requests/quick').set('Cookie', cookie).send(body);
type Row = { id: string; agentSpendUsd?: number | null; allocatedUsd?: number | null; budgetAccess?: { visible: boolean; reason: string; requestItemId: string } };

beforeEach(() => {
  for (const f of [accessCatalogFixture, accessPoliciesFixture, accessPeopleFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture, identityGrantWritesFixture, initiatives]) f.reset();
  resetRateLimits();
  setGrantsResolver(async (id) => {
    const user = await getUser(id, { authoritative: true });
    return user ? { displayName: user.displayName, grants: user.grants, epoch: user.epoch } : null;
  });
  bell = [];
  setNotificationSink({ notifyUser: async (userId, item: NotificationInputLike) => { bell.push({ userId, kind: item.payload?.['kind'], href: item.action?.href }); } });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { setNotificationSink(null); jest.restoreAllMocks(); });

it('a Work member sees locked figures, requests the tier from Work, a budget owner approves, and the figures appear on the same cookie', async () => {
  const theo = await signIn('u-theo');
  const before = await request(app).get('/api/graph/projects').set('Cookie', theo);
  expect(before.status).toBe(200);
  const locked = before.body as Row[];
  expect(locked.length).toBeGreaterThan(0);
  for (const row of locked) {
    expect(row).not.toHaveProperty('agentSpendUsd');
    expect(row).not.toHaveProperty('allocatedUsd');
    expect(row.budgetAccess).toEqual({ visible: false, reason: expect.stringContaining('budgets read tier'), requestItemId: BUDGET_READ_ITEM_ID });
  }
  const detail = await request(app).get(`/api/graph/projects/${locked[0]!.id}`).set('Cookie', theo);
  expect(detail.body).not.toHaveProperty('agentSpendUsd');
  expect(detail.body.budgetAccess).toMatchObject({ visible: false });

  // Nothing open yet; file from Work (Theo holds no Access grant).
  expect((await request(app).get(`/api/access-requests/mine?itemId=${BUDGET_READ_ITEM_ID}`).set('Cookie', theo)).body).toEqual({ items: [] });
  const filed = await quick(theo, { itemId: BUDGET_READ_ITEM_ID, justification: JUST, duration: '30d' });
  expect(filed.status).toBe(201);
  const req1 = filed.body as AccessRequest;
  expect(req1).toMatchObject({ kind: 'grant', status: 'submitted', requester: { id: 'u-theo' }, beneficiary: { id: 'u-theo' }, item: { id: BUDGET_READ_ITEM_ID, kind: 'capability', stewardRule: 'budget-owner' } });
  // No manager on record for Theo: the chain is the budget owner's step. The
  // org leaders who also approve in Access (Vera, Rachel) decide it; Sienna
  // holds no Access grant, so she is not asked.
  expect(req1.steps).toEqual([expect.objectContaining({ step: 1, kind: 'steward', status: 'current', escalated: null })]);
  expect(req1.steps[0]!.eligible.map((p) => p.id).sort()).toEqual(['u-rachel', 'u-vera']);
  expect(bell.map((b) => b.userId).sort()).toEqual(['u-rachel', 'u-vera']);

  // The status read and the duplicate refusal name the same request.
  const mine = (await request(app).get(`/api/access-requests/mine?itemId=${BUDGET_READ_ITEM_ID}`).set('Cookie', theo)).body as { items: AccessRequest[] };
  expect(mine.items.map((r) => [r.id, r.status])).toEqual([[req1.id, 'submitted']]);
  const dup = await quick(theo, { itemId: BUDGET_READ_ITEM_ID, justification: JUST, duration: '30d' });
  expect(dup.status).toBe(409);
  expect(dup.body).toMatchObject({ requestId: req1.id });

  // A budget owner decides it in Access, as any request.
  const rachel = await signIn('u-rachel', 'access');
  const approved = await request(app).post(`/api/access/requests/${req1.id}/steps/1/decide`).set('Cookie', rachel).send({ decision: 'approve' });
  expect(approved.status).toBe(200);
  expect((approved.body as AccessRequest).status).toBe('active');
  expect((await getUser('u-theo'))!.grants['orgiq']).toEqual(['member', 'budgets-reader']);

  // The capability is not a role: Theo still acts as member and cannot pick it.
  const me = await request(app).get('/api/session/me').set('Cookie', theo);
  expect(me.body).toMatchObject({ role: 'member', tenant: 'orgiq' });
  expect(me.body.availableRoles).not.toContain('budgets-reader');

  // Past the grants refresh, the SAME cookie carries the capability and the figures appear.
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
  const after = await request(app).get('/api/graph/projects').set('Cookie', theo);
  jest.mocked(Date.now).mockRestore();
  expect(after.status).toBe(200);
  for (const row of after.body as Row[]) {
    expect(row).toHaveProperty('agentSpendUsd');
    expect(row).toHaveProperty('allocatedUsd');
    expect(row).not.toHaveProperty('budgetAccess');
  }
  const status = (await request(app).get(`/api/access-requests/mine?itemId=${BUDGET_READ_ITEM_ID}`).set('Cookie', cookieOf(after))).body as { items: AccessRequest[] };
  expect(status.items.map((r) => r.status)).toEqual(['active']);
});

it('a budgets-tier holder gets the projects payload unchanged', async () => {
  const mia = await signIn('u-mia'); // program-owner
  const role = await request(app).post('/api/session/role').set('Cookie', mia).send({ role: 'program-owner' });
  const cookie = role.status === 200 ? cookieOf(role) : mia;
  const rows = (await request(app).get('/api/graph/projects').set('Cookie', cookie)).body as Row[];
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) {
    expect(row).toHaveProperty('agentSpendUsd');
    expect(row).not.toHaveProperty('budgetAccess');
  }
});

describe('quick request refusals', () => {
  it('refuses an item of another tenant, an unknown item, unknown keys, a short justification and a bad duration', async () => {
    const theo = await signIn('u-theo');
    const other = await quick(theo, { itemId: 'role:assessment:assessor', justification: JUST, duration: '24h' });
    expect(other.status).toBe(403);
    expect(other.body.error).toMatch(/another workspace/);
    expect((await quick(theo, { itemId: 'capability:orgiq:nothing', justification: JUST, duration: '24h' })).status).toBe(400);
    const extra = await quick(theo, { itemId: BUDGET_READ_ITEM_ID, justification: JUST, duration: '24h', beneficiaryId: 'u-vera' });
    expect(extra.status).toBe(400);
    expect(extra.body.error).toMatch(/Unknown field: beneficiaryId/);
    expect((await quick(theo, { itemId: BUDGET_READ_ITEM_ID, justification: 'too short', duration: '24h' })).status).toBe(400);
    expect((await quick(theo, { itemId: BUDGET_READ_ITEM_ID, justification: JUST, duration: 'forever' })).status).toBe(400);
    expect((await request(app).get('/api/access-requests/mine').set('Cookie', theo)).status).toBe(400);
    expect((await request(app).get(`/api/access-requests/mine?itemId=${BUDGET_READ_ITEM_ID}&scope=all`).set('Cookie', theo)).status).toBe(400);
    expect((await request(app).get('/api/access-requests/mine?itemId=role:assessment:assessor').set('Cookie', theo)).status).toBe(403);
    // Nothing was filed by any of those.
    expect(accessRequestsFixture.rows().filter((r) => r.requesterId === 'u-theo')).toEqual([]);
  });

  it('files the Social plane\'s own request item from another workspace (G27), and only that one', async () => {
    const helen = await signIn('u-hr');
    const plane = await request(app).get('/api/access-requests/mine?itemId=role:social:moderator').set('Cookie', helen);
    expect(plane.status).toBe(200);
    const filed = await quick(helen, { itemId: 'role:social:moderator', justification: 'Requested by voice from the orgiq workspace: I need to message the team.', duration: '7d' });
    expect(filed.status).toBe(201);
    expect(filed.body).toMatchObject({ item: expect.objectContaining({ id: 'role:social:moderator' }), status: expect.any(String) });
    // Any other Social item stays another workspace's.
    const other = await quick(helen, { itemId: 'role:social:community-admin', justification: JUST, duration: '7d' });
    expect([400, 403]).toContain(other.status);
  });

  it('runs the same separation-of-duties pre-check as the Access form', async () => {
    const vera = await signIn('u-vera');
    const theo = await signIn('u-theo');
    const sme = await quick(vera, { itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' });
    // org-leader + sme is a blocking SoD pair (sod-001): the same pre-check the Access form runs.
    expect(sme.status).toBe(409);
    expect(sme.body.sod).toMatchObject({ verdict: 'block' });
    expect((await quick(theo, { itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' })).status).toBe(201);
  });

  it('needs a session, and a directory account to grant to', async () => {
    const anon = await request(app).post('/api/access-requests/quick').send({ itemId: BUDGET_READ_ITEM_ID, justification: JUST, duration: '30d' });
    // No cookie: either the session floor (401) or the cookie-less demo persona, which has no account (403).
    expect([401, 403]).toContain(anon.status);
    expect(accessRequestsFixture.rows().filter((r) => r.itemId === BUDGET_READ_ITEM_ID)).toEqual([]);
  });
});
