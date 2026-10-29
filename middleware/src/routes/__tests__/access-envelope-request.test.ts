// "Request budget" from the dispatch drawer (2026-10-28), end to end through
// the real cookie path, as access-requests-quick.test.ts walks the budget tier:
// an SME the grant-scoped dispatch gate refuses ("no active sprint grant")
// files `POST /api/access-requests/envelope` from Work with their message, the
// amount and the forecast; the request is an ORDINARY access request for the
// derived `envelope:<initiative>` item, decided in Access by the initiative's
// budget holder (else the org-leaders who approve there); the last approval
// provisions a budget_grants row through the same path POST /api/grants takes
// — and the SAME dispatch verdict that refused the SME now allows them.
//
// Plus the refusals: no amount, a zero amount, a forecast on another
// initiative's work item, an amount on a non-envelope item, a duplicate open
// request, "already holds" for an SME with an active envelope, and a derived
// item refused by PUT /configuration.

jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1', aurora: {}, cognito: { portalOrigin: '' },
    auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, mock: { aurora: true },
  },
}));
jest.mock('aws-jwt-verify', () => ({ CognitoJwtVerifier: { create: () => ({ verify: async () => ({}) }) } }));
jest.mock('../../lib/role-registry.js', () => {
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

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { sessionMiddleware, setGrantsResolver } from '../../lib/session.js';
import { resetRateLimits } from '../../lib/rate-limit.js';
import { getUser } from '../../providers/identity.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { grantScopedDispatchVerdict } from '../../lib/bot-runner.js';
import { listGrants } from '../../providers/budgets.js';
import { sessionRouter } from '../session.js';
import { accessRouter } from '../access.js';
import { accessQuickRouter } from '../access-requests-quick.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { budgetGrants } from '../../mock/budgets.js';
import { sprints } from '../../mock/sprints.js';
import type { AccessRequest, CatalogItem } from '../../lib/access/types.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware());
app.use('/api/session', sessionRouter);
app.use('/api/access', requireTenant('access'), accessRouter);
app.use('/api/access-requests', accessQuickRouter);
app.use(errorHandler);

let bell: Array<{ userId: string; kind: unknown }>;

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
  const value = all.map((c) => c.split(';')[0]!).filter((c) => c.startsWith('orgiq.session=') && c.length > 'orgiq.session='.length).at(-1);
  if (!value) throw new Error('no session cookie was issued');
  return value;
}

async function signIn(userId: string, tenant?: string, role?: string): Promise<string> {
  const login = await request(app).post('/api/session/login').send({ userId });
  expect(login.status).toBe(200);
  let cookie = cookieOf(login);
  if (tenant && (login.body as { tenant: string }).tenant !== tenant) {
    const sw = await request(app).post('/api/session/tenant').set('Cookie', cookie).send({ tenant });
    expect(sw.status).toBe(200);
    cookie = cookieOf(sw);
  }
  if (role) {
    const sw = await request(app).post('/api/session/role').set('Cookie', cookie).send({ role });
    if (sw.status === 200) cookie = cookieOf(sw);
  }
  return cookie;
}

const INITIATIVE = 'p-observability';
const ITEM = `envelope:${INITIATIVE}`;
const MESSAGE = 'Decommissioning the StatsD bridge needs two agent runs this sprint; the forecast fits a $30 envelope.';
const FORECAST = { workItemId: 'wi-obs-e1-s4', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', costUsdP25: 0.03, costUsdP75: 0.3 };
const envelope = (cookie: string, body: Record<string, unknown>) => request(app).post('/api/access-requests/envelope').set('Cookie', cookie).send(body);

beforeEach(() => {
  fixtureRegistry.resetAll('default');
  resetRateLimits();
  setGrantsResolver(async (id) => {
    const user = await getUser(id, { authoritative: true });
    return user ? { displayName: user.displayName, grants: user.grants, epoch: user.epoch } : null;
  });
  bell = [];
  setNotificationSink({ notifyUser: async (userId, item: NotificationInputLike) => { bell.push({ userId, kind: item.payload?.['kind'] }); } });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => { setNotificationSink(null); jest.restoreAllMocks(); });

it('an SME refused by the dispatch gate requests an envelope from Work; the budget holder approves; the grant row exists and the same gate now allows them', async () => {
  // Eli (p-011) is an SME on Observability whose only grant there is on a DONE sprint: the real gate refuses.
  const before = await grantScopedDispatchVerdict(INITIATIVE, { sub: 'u-eli', role: 'sme' });
  expect(before.kind).toBe('deny');

  const eli = await signIn('u-eli');
  // The derived catalog item exists for every initiative, and Eli does not hold it.
  const filed = await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30, forecast: FORECAST });
  expect(filed.status).toBe(201);
  const req1 = filed.body as AccessRequest;
  expect(req1).toMatchObject({
    kind: 'grant', status: 'submitted', duration: 'standing', requestedUsd: 30, forecast: FORECAST,
    requester: { id: 'u-eli' }, beneficiary: { id: 'u-eli' },
    item: { id: ITEM, kind: 'sprint-envelope', projectId: INITIATIVE, stewardRule: 'budget-holder', title: 'Sprint envelope on Observability Platform', heldByActor: false },
  });
  // No manager on record for Eli: one steward step. Observability's allocation
  // was set by the release manager (u-release), who holds no Access grant, so
  // the step falls to the org-leaders who approve in Access: Vera and Rachel.
  expect(req1.steps).toEqual([expect.objectContaining({ step: 1, kind: 'steward', status: 'current', escalated: null })]);
  expect(req1.steps[0]!.eligible.map((p) => p.id).sort()).toEqual(['u-rachel', 'u-vera']);
  expect(bell.map((b) => b.userId).sort()).toEqual(['u-rachel', 'u-vera']);

  // The status read and the duplicate refusal name the same request.
  const mine = (await request(app).get(`/api/access-requests/mine?itemId=${ITEM}`).set('Cookie', eli)).body as { items: AccessRequest[] };
  expect(mine.items.map((r) => [r.id, r.status])).toEqual([[req1.id, 'submitted']]);
  const dup = await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30 });
  expect(dup.status).toBe(409);
  expect(dup.body).toMatchObject({ requestId: req1.id });

  // Rachel decides it in Access, as any request; the last approval provisions.
  const rachel = await signIn('u-rachel', 'access');
  const approved = await request(app).post(`/api/access/requests/${req1.id}/steps/1/decide`).set('Cookie', rachel).send({ decision: 'approve', comment: 'Fits the sprint.' });
  expect(approved.status).toBe(200);
  expect((approved.body as AccessRequest).status).toBe('active');

  // ONE budget_grants row, on the initiative's ACTIVE sprint, for the requested amount,
  // authorized by the final approver, noted with the request id — in the registered fixture.
  const grants = (await listGrants(INITIATIVE)).filter((g) => g.note === req1.id);
  expect(grants).toHaveLength(1);
  expect(grants[0]).toMatchObject({ orgProjectId: INITIATIVE, granteePersonId: 'p-011', sprintId: 'spr-obs-s3', sprintStatus: 'active', allocatedUsd: 30, grantedBy: 'u-rachel' });
  expect(budgetGrants.rows().some((g) => g.note === req1.id)).toBe(true);
  expect(bell.some((b) => b.userId === 'u-eli' && b.kind === 'budget-grant')).toBe(true);

  // The dispatch gate that refused Eli reads the same rows and now allows.
  const after = await grantScopedDispatchVerdict(INITIATIVE, { sub: 'u-eli', role: 'sme' });
  expect(after.kind).toBe('allow');
  // ... and the catalog now says Eli holds it, so a second request is "already holds".
  const again = await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30 });
  expect(again.status).toBe(409);
  expect(again.body.error).toMatch(/already holds/);

  // Revoking the request in Access removes the grant row; the gate refuses again.
  const priya = await signIn('u-priya', 'access');
  const revoked = await request(app).post(`/api/access/requests/${req1.id}/revoke`).set('Cookie', priya).send({ reason: 'Sprint re-planned; envelope withdrawn.' });
  expect(revoked.status).toBe(200);
  expect((await listGrants(INITIATIVE)).some((g) => g.note === req1.id)).toBe(false);
  expect((await grantScopedDispatchVerdict(INITIATIVE, { sub: 'u-eli', role: 'sme' })).kind).toBe('deny');
});

it('provisions a standing (sprint-less) grant when the initiative has no active sprint', async () => {
  // Close every Design System v3 sprint in the calendar (a registered fixture; the reset reopens them), so the envelope is initiative-level.
  for (const s of sprints.rows()) if (s.orgProjectId === 'p-design-v3') s.status = 'done';
  const theo = await signIn('u-theo'); // a Work member with a linked person (p-001) and no envelope anywhere
  const filed = await envelope(theo, { initiativeId: 'p-design-v3', justification: MESSAGE, requestedUsd: 12 });
  expect(filed.status).toBe(201);
  const r = filed.body as AccessRequest;
  const vera = await signIn('u-vera', 'access');
  const decided = await request(app).post(`/api/access/requests/${r.id}/steps/${r.steps.at(-1)!.step}/decide`).set('Cookie', vera).send({ decision: 'approve' });
  expect(decided.status).toBe(200);
  expect((decided.body as AccessRequest).status).toBe('active');
  const grant = (await listGrants('p-design-v3')).find((g) => g.note === r.id);
  expect(grant).toMatchObject({ granteePersonId: 'p-001', allocatedUsd: 12, sprintId: null, grantedBy: 'u-vera' });
});

describe('envelope request refusals', () => {
  it('needs a positive amount, a forecast on this initiative, and an initiative that exists', async () => {
    const eli = await signIn('u-eli');
    expect((await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE })).status).toBe(400);
    expect((await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 0 })).status).toBe(400);
    expect((await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: '30' })).status).toBe(400);
    const other = await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30, forecast: { ...FORECAST, workItemId: 'wi-auth-e2-s2' } });
    expect(other.status).toBe(400);
    expect(other.body.error).toMatch(/not the initiative/);
    expect((await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30, forecast: { workItemId: 'wi-nope' } })).status).toBe(400);
    expect((await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30, forecast: { extra: 1 } })).status).toBe(400);
    expect((await envelope(eli, { initiativeId: 'p-nothing', justification: MESSAGE, requestedUsd: 30 })).status).toBe(400);
    expect((await envelope(eli, { initiativeId: INITIATIVE, justification: 'too short', requestedUsd: 30 })).status).toBe(400);
    expect((await envelope(eli, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30, beneficiaryId: 'u-vera' })).status).toBe(400);
    expect((await request(app).get(`/api/access-requests/mine?itemId=${ITEM}`).set('Cookie', eli)).body).toEqual({ items: [] });
  });

  it('refuses an amount on a non-envelope item, and "already holds" for an SME with an active envelope', async () => {
    const layla = await signIn('u-layla'); // holds bg-obs-3 on the active Observability sprint
    const held = await envelope(layla, { initiativeId: INITIATIVE, justification: MESSAGE, requestedUsd: 30 });
    expect(held.status).toBe(409);
    expect(held.body.error).toMatch(/already holds/);
    const theo = await signIn('u-theo');
    const amount = await request(app).post('/api/access-requests/quick').set('Cookie', theo).send({ itemId: 'capability:orgiq:budgets-read', justification: MESSAGE, duration: '30d', requestedUsd: 5 });
    expect(amount.status).toBe(400);
  });

  it('lists the derived item in the catalog but refuses to edit it through the configuration', async () => {
    const priya = await signIn('u-priya', 'access');
    const catalog = (await request(app).get('/api/access/catalog?kind=sprint-envelope').set('Cookie', priya)).body as { items: CatalogItem[] };
    expect(catalog.items.map((i) => i.id)).toContain(ITEM);
    const config = (await request(app).get('/api/access/configuration').set('Cookie', priya)).body as { stewards: Array<{ scope: string; rule: string }>; items: Array<{ id: string }> };
    expect(config.stewards).toContainEqual(expect.objectContaining({ scope: 'sprint-envelope', rule: 'budget-holder' }));
    expect(config.items.map((i) => i.id)).not.toContain(ITEM);
    const put = await request(app).put('/api/access/configuration').set('Cookie', priya).send({ items: [{ id: ITEM, sensitive: true }] });
    expect(put.status).toBe(400);
    expect(put.body.error).toMatch(/derived/);
  });
});
