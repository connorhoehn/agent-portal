// Lane A1 end to end (docs/access-tenant-goal.md §A1), through the real
// cookie path: picker login, sessionMiddleware with the directory's grants
// resolver, /api/session/*, and /api/access/* behind requireTenant('access')
// with the Cedar decisions read off seeds/roles/access/*.cedar. The directory
// is the real memory identity provider (MOCK_AURORA), so the grant
// provisioning writes is the grant the next sign-in reads.
//
//   Rhea requests SME in Work → Omar approves the manager step → Priya the
//   steward step → the request is active; Rhea's EXISTING cookie carries `sme`
//   after the grants refresh with no sign-out (A3: provisioning does not bump
//   the epoch), the catalog shows the item as held, the audit has the rows,
//   and the bell rang for each step.

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
import { sessionRouter } from '../session.js';
import { accessRouter } from '../access.js';
import { accessCatalogFixture } from '../../mock/access-catalog.js';
import { accessPoliciesFixture } from '../../mock/access-policies.js';
import { accessPeopleFixture } from '../../mock/access-people.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture } from '../../mock/access-requests.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { initiatives } from '../../mock/initiatives.js';
import type { AccessEvent, AccessRequest, CatalogItem } from '../../lib/access/types.js';

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware());
app.use('/api/session', sessionRouter);
app.use('/api/access', requireTenant('access'), accessRouter);
app.use(errorHandler);

let bell: Array<{ userId: string; kind: unknown; href: string | undefined }>;

/** The orgiq.session cookie a response set (the last non-clearing one). */
function cookieOf(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie'];
  const all = (Array.isArray(raw) ? raw : raw ? [raw] : []) as string[];
  const value = all.map((c) => c.split(';')[0]!).filter((c) => c.startsWith('orgiq.session=') && c.length > 'orgiq.session='.length).at(-1);
  if (!value) throw new Error('no session cookie was issued');
  return value;
}

/** Sign in through the picker and stand in `access`, as the portal does. */
async function signIn(userId: string): Promise<string> {
  const login = await request(app).post('/api/session/login').send({ userId });
  expect(login.status).toBe(200);
  let cookie = cookieOf(login);
  if ((login.body as { tenant: string }).tenant !== 'access') {
    const sw = await request(app).post('/api/session/tenant').set('Cookie', cookie).send({ tenant: 'access' });
    expect(sw.status).toBe(200);
    cookie = cookieOf(sw);
  }
  return cookie;
}

const JUST = 'I am picking up the SSO cutover stories and need to dispatch agent work.';

beforeEach(() => {
  for (const f of [accessCatalogFixture, accessPoliciesFixture, accessPeopleFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture, identityGrantWritesFixture, initiatives]) f.reset();
  // Start with no open SME request for Rhea (the seed's req-0001 is one), so she files it here.
  const drop = <T extends { requestId?: string | null; id?: string }>(rows: T[]) => {
    for (let i = rows.length - 1; i >= 0; i--) if ((rows[i]!.requestId ?? rows[i]!.id) === 'req-0001') rows.splice(i, 1);
  };
  drop(accessRequestsFixture.rows()); drop(accessStepsFixture.rows()); drop(accessEventsFixture.rows());
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

it('Rhea requests SME in Work, Omar and Priya approve, and her open cookie holds it after the grants refresh', async () => {
  const rhea = await signIn('u-rhea');
  const me0 = await request(app).get('/api/session/me').set('Cookie', rhea);
  expect(me0.body).toMatchObject({ sub: 'u-rhea', tenant: 'access', grants: { access: ['requester'] } });
  expect(me0.body.grants.orgiq).toBeUndefined();

  // Submit: the chain is computed live, and the bell reaches whoever may decide step 1 now.
  const filed = await request(app).post('/api/access/requests').set('Cookie', rhea).send({ itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' });
  expect(filed.status).toBe(201);
  const id = (filed.body as AccessRequest).id;
  expect(bell).toEqual([{ userId: 'u-omar', kind: 'access-submitted', href: `/access/requests/${id}` }]);

  // Omar, her manager, approves step 1; Rhea hears, and Priya (the escalated steward) is asked.
  bell = [];
  const omar = await signIn('u-omar');
  const step1 = await request(app).post(`/api/access/requests/${id}/steps/1/decide`).set('Cookie', omar).send({ decision: 'approve', comment: 'Fine for the cutover.' });
  expect(step1.status).toBe(200);
  expect((step1.body as AccessRequest).status).toBe('pending');
  expect(bell).toEqual([
    { userId: 'u-rhea', kind: 'access-approved-step', href: `/access/requests/${id}` },
    { userId: 'u-priya', kind: 'access-awaiting', href: `/access/requests/${id}` },
  ]);

  // Priya approves the last step: provisioned and active.
  bell = [];
  const priya = await signIn('u-priya');
  const step2 = await request(app).post(`/api/access/requests/${id}/steps/2/decide`).set('Cookie', priya).send({ decision: 'approve' });
  expect(step2.status).toBe(200);
  const done = step2.body as AccessRequest;
  expect(done).toMatchObject({ status: 'active', provisionedAt: expect.any(String), expiresAt: expect.any(String) });
  expect(Date.parse(done.expiresAt!) - Date.parse(done.provisionedAt!)).toBe(7 * 24 * 3_600_000);
  expect(bell).toEqual([{ userId: 'u-rhea', kind: 'access-provisioned', href: `/access/requests/${id}` }]);

  // A3: provisioning does not bump her epoch. Her EXISTING cookie stays valid:
  // a strict read sees the grant at once…
  const now = await request(app).get('/api/session/me').set('Cookie', rhea);
  expect(now.status).toBe(200);
  expect(now.body.grants).toEqual({ access: ['requester'], orgiq: ['sme'] });
  // …and the grants refresh (the cookie is past GRANTS_REFRESH_S) re-mints that
  // same cookie carrying `sme` — no sign-out, no new sign-in.
  jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60_000);
  const refreshed = await request(app).get('/api/access/catalog').set('Cookie', rhea);
  jest.mocked(Date.now).mockRestore();
  expect(refreshed.status).toBe(200);
  const reminted = cookieOf(refreshed);
  const payload = JSON.parse(Buffer.from(reminted.slice('orgiq.session='.length).split('.')[0]!, 'base64url').toString('utf8')) as { sub: string; grants: Record<string, string[]>; tenant: string };
  expect(payload).toMatchObject({ sub: 'u-rhea', tenant: 'access', grants: { access: ['requester'], orgiq: ['sme'] } });
  // The catalog (read on that refreshed cookie) shows the item as held; asking again is the 409.
  expect((refreshed.body as { items: CatalogItem[] }).items.find((i) => i.id === 'role:orgiq:sme')).toMatchObject({ heldByActor: true });
  const rhea2 = reminted;
  expect((await request(app).post('/api/access/requests').set('Cookie', rhea2).send({ itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' })).status).toBe(409);

  // The audit has every row, the provisioning attributed to the system.
  const audit = (await request(app).get(`/api/access/audit?requestId=${id}`).set('Cookie', priya)).body as { items: AccessEvent[] };
  expect(audit.items.map((e) => [e.kind, e.actor?.id ?? null]).reverse()).toEqual([
    ['submitted', 'u-rhea'], ['step-approved', 'u-omar'], ['step-approved', 'u-priya'], ['approved', 'u-priya'], ['provisioned', null],
  ]);
  // Rhea reads her own request's trail as a requester.
  expect(((await request(app).get(`/api/access/audit?requestId=${id}`).set('Cookie', rhea2)).body as { items: AccessEvent[] }).items).toHaveLength(5);
});

it('a rejection and a request for information ring the parties, not the approver who decided', async () => {
  const omar = await signIn('u-omar');
  const rhea = await signIn('u-rhea');
  const filed = await request(app).post('/api/access/requests').set('Cookie', rhea).send({ itemId: 'role:assessment:assessor', justification: JUST, duration: '24h' });
  const id = (filed.body as AccessRequest).id;
  bell = [];
  const info = await request(app).post(`/api/access/requests/${id}/steps/1/decide`).set('Cookie', omar).send({ decision: 'info', comment: 'Which team?' });
  expect(info.status).toBe(200);
  const reject = await request(app).post(`/api/access/requests/${id}/steps/1/decide`).set('Cookie', omar).send({ decision: 'reject', comment: 'Not this quarter.' });
  expect((reject.body as AccessRequest).status).toBe('rejected');
  expect(bell.map((b) => [b.userId, b.kind])).toEqual([['u-rhea', 'access-info-requested'], ['u-rhea', 'access-rejected']]);
  // Nothing was provisioned.
  expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'] });
});

it('an initiative membership provisions the contribution and the record says active', async () => {
  const priya = await signIn('u-priya');
  // req-0002: Rhea → Auth Migration, Omar approved step 1; the steward step escalated to Priya.
  const res = await request(app).post('/api/access/requests/req-0002/steps/2/decide').set('Cookie', priya).send({ decision: 'approve' });
  expect(res.status).toBe(200);
  expect((res.body as AccessRequest).status).toBe('active');
  expect(initiatives.rows().find((p) => p.id === 'p-auth-migration')!.smes).toContain('p-rhea');
  const rhea = await signIn('u-rhea');
  const items = ((await request(app).get('/api/access/catalog?kind=initiative-membership').set('Cookie', rhea)).body as { items: CatalogItem[] }).items;
  expect(items.find((i) => i.id === 'initiative:p-auth-migration')).toMatchObject({ heldByActor: true });
});
