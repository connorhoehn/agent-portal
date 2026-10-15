// Lane A2 (docs/access-tenant-goal.md §A2), through the real cookie path with
// the access tenant's real Cedar files, the memory identity provider as the
// directory and the registered access fixtures:
//
//   * SoD at provisioning: a grant added between submit and the last approval
//     creates a block the submit pre-check never saw; provisioning refuses
//     (request stays `approved`, `sod-blocked` event, bell to the parties and
//     the access admins) until an access admin records an override, which
//     provisions it;
//   * the override: ManageAccessPolicy only (403 for an approver), a reason of
//     at least 20 characters (400), never on one's own request, once;
//   * manual revoke: ProvisionAccess only, 409 unless active, the
//     beneficiary's epoch bumped and their existing cookie retired;
//   * reviews: the seeded campaign, a campaign built from the directory's
//     standing grants, keep / revoke (a pre-approved revocation request revoked
//     through revokeAccess by the reviewer, events on both records), nobody
//     certifies their own access, a decided item is the 409, and the campaign
//     closes when every item is decided.

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
import { getUser, listUsers, setGrants } from '../../providers/identity.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { sessionRouter } from '../session.js';
import { accessRouter } from '../access.js';
import { accessCatalogFixture } from '../../mock/access-catalog.js';
import { accessPoliciesFixture } from '../../mock/access-policies.js';
import { accessPeopleFixture } from '../../mock/access-people.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture } from '../../mock/access-requests.js';
import { accessReviewItemsFixture, accessReviewsFixture } from '../../mock/access-reviews.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { initiatives } from '../../mock/initiatives.js';
import type { AccessEvent, AccessRequest, AccessReview, AccessReviewItem } from '../../lib/access/types.js';

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
const REASON = 'The release manager owns both halves of this quarter; finance reviewed it.';

beforeEach(() => {
  for (const f of [accessCatalogFixture, accessPoliciesFixture, accessPeopleFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture,
    accessReviewsFixture, accessReviewItemsFixture, identityGrantWritesFixture, initiatives]) f.reset();
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

const events = async (id: string, cookie: string) =>
  ((await request(app).get(`/api/access/audit?requestId=${id}`).set('Cookie', cookie)).body as { items: AccessEvent[] }).items.map((e) => [e.kind, e.actor?.id ?? null]).reverse();

/** Rhea files SME in Work (clear at submit); org-leader then lands in her grants; Omar and Rachel approve. */
async function blockedAtProvision(): Promise<{ id: string; rhea: string; omar: string; priya: string; approved: AccessRequest }> {
  const rhea = await signIn('u-rhea');
  const filed = await request(app).post('/api/access/requests').set('Cookie', rhea).send({ itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' });
  expect(filed.status).toBe(201);
  const id = (filed.body as AccessRequest).id;
  expect((filed.body as AccessRequest).sod.verdict).toBe('clear');
  // Between submit and approval, a grant the approvers never saw: org-leader, which sod-001 blocks with sme.
  await setGrants('u-rhea', { access: ['requester'], orgiq: ['org-leader'] });
  const omar = await signIn('u-omar');
  expect((await request(app).post(`/api/access/requests/${id}/steps/1/decide`).set('Cookie', omar).send({ decision: 'approve' })).status).toBe(200);
  // Rachel stewards Work roles (hr-admin, approving in Access) and decides the last step.
  const rachel = await signIn('u-rachel');
  const priya = await signIn('u-priya');
  bell = [];
  const last = await request(app).post(`/api/access/requests/${id}/steps/2/decide`).set('Cookie', rachel).send({ decision: 'approve' });
  expect(last.status).toBe(200);
  // The record as the access admin reads it (only she may override the block).
  const approved = (await request(app).get(`/api/access/requests/${id}`).set('Cookie', priya)).body as AccessRequest;
  return { id, rhea, omar, priya, approved };
}

describe('SoD at provisioning (A7)', () => {
  it('a grant added between submit and approval blocks provisioning; the request stays approved and says why', async () => {
    const { id, priya, approved } = await blockedAtProvision();
    expect(approved).toMatchObject({ status: 'approved', provisionedAt: null, sod: { verdict: 'block', overriddenBy: null }, can: { overrideSod: true, revoke: false } });
    expect(approved.sod.conflicts).toEqual([expect.objectContaining({ policyId: 'sod-001', severity: 'block' })]);
    // Nothing was written to the grant store.
    expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'], orgiq: ['org-leader'] });
    // The parties and the access admins hear, once; no `provision-failed`.
    expect(bell.map((b) => [b.userId, b.kind])).toEqual([['u-rhea', 'access-sod-blocked'], ['u-priya', 'access-sod-blocked']]);
    expect(bell.every((b) => b.href === `/access/requests/${id}`)).toBe(true);
    expect((await events(id, priya)).map(([k]) => k)).toEqual(['submitted', 'step-approved', 'step-approved', 'sod-blocked']);
  });

  it('an access admin\'s override (reason ≥ 20 chars) provisions it; an approver is refused; it is recorded once', async () => {
    const { id, rhea, omar, priya } = await blockedAtProvision();
    // Cedar: an approver holds no ManageAccessPolicy.
    expect((await request(app).post(`/api/access/requests/${id}/sod-override`).set('Cookie', omar).send({ reason: REASON })).status).toBe(403);
    // A requester cannot either, and certainly not on her own request.
    expect((await request(app).post(`/api/access/requests/${id}/sod-override`).set('Cookie', rhea).send({ reason: REASON })).status).toBe(403);
    expect((await request(app).post(`/api/access/requests/${id}/sod-override`).set('Cookie', priya).send({ reason: 'Fine by me.' })).status).toBe(400);
    expect((await request(app).post(`/api/access/requests/${id}/sod-override`).set('Cookie', priya).send({ reason: REASON, extra: 1 })).status).toBe(400);

    const res = await request(app).post(`/api/access/requests/${id}/sod-override`).set('Cookie', priya).send({ reason: REASON });
    expect(res.status).toBe(200);
    expect(res.body as AccessRequest).toMatchObject({
      status: 'active', provisionedAt: expect.any(String),
      sod: { verdict: 'block', overriddenBy: { id: 'u-priya' }, overrideReason: REASON }, can: { overrideSod: false, revoke: true },
    });
    expect((await getUser('u-rhea'))!.grants).toEqual({ access: ['requester'], orgiq: ['org-leader', 'sme'] });
    expect(await events(id, priya)).toEqual([
      ['submitted', 'u-rhea'], ['step-approved', 'u-omar'], ['step-approved', 'u-rachel'],
      ['sod-blocked', null], ['sod-override', 'u-priya'], ['provisioned', null],
    ]);
    // Once: a second override is the 409.
    expect((await request(app).post(`/api/access/requests/${id}/sod-override`).set('Cookie', priya).send({ reason: REASON })).status).toBe(409);
  });

  it('an override needs a live block and is never recorded on one\'s own request', async () => {
    const priya = await signIn('u-priya');
    // req-0003 (Omar → Operator in Pipelines) is approved with no conflict: nothing to override.
    expect((await request(app).post('/api/access/requests/req-0003/sod-override').set('Cookie', priya).send({ reason: REASON })).status).toBe(409);
    // Priya files for herself and an operator grant lands under her: she may not wave her own block through.
    await setGrants('u-priya', { access: ['access-admin'], pipelines: ['author'] });
    accessRequestsFixture.rows().push({ ...accessRequestsFixture.rows().find((r) => r.id === 'req-0003')!, id: 'req-0099', requesterId: 'u-priya', beneficiaryId: 'u-priya' });
    const own = await request(app).post('/api/access/requests/req-0099/sod-override').set('Cookie', priya).send({ reason: REASON });
    expect(own.status).toBe(403);
    expect(own.body.error).toMatch(/submitted or benefit from/);
  });
});

describe('manual revoke', () => {
  it('an access admin revokes an active grant: the role is removed, the epoch bumps, the old cookie is retired; 409 unless active', async () => {
    const nora = cookieOf(await request(app).post('/api/session/login').send({ userId: 'u-nora' }));
    expect((await request(app).get('/api/session/me').set('Cookie', nora)).status).toBe(200);
    const priya = await signIn('u-priya');
    const omar = await signIn('u-omar');
    const epoch = (await getUser('u-nora'))!.epoch;

    // Cedar: an approver holds no ProvisionAccess.
    expect((await request(app).post('/api/access/requests/req-0004/revoke').set('Cookie', omar).send({ reason: 'Leaving the team.' })).status).toBe(403);
    expect((await request(app).post('/api/access/requests/req-0004/revoke').set('Cookie', priya).send({})).status).toBe(400);
    // Not active: approved (req-0003), rejected (req-0005).
    expect((await request(app).post('/api/access/requests/req-0003/revoke').set('Cookie', priya).send({ reason: 'Not needed.' })).status).toBe(409);
    expect((await request(app).post('/api/access/requests/req-0005/revoke').set('Cookie', priya).send({ reason: 'Not needed.' })).status).toBe(409);

    bell = [];
    const res = await request(app).post('/api/access/requests/req-0004/revoke').set('Cookie', priya).send({ reason: 'Moved off the maintenance rotation.' });
    expect(res.status).toBe(200);
    expect(res.body as AccessRequest).toMatchObject({ status: 'revoked', revokedAt: expect.any(String), can: { revoke: false } });
    expect((await getUser('u-nora'))!.grants.orgiq ?? []).not.toContain('sme');
    expect((await getUser('u-nora'))!.epoch).toBe(epoch + 1);
    // The epoch bump retires every cookie Nora holds at its next read.
    expect((await request(app).get('/api/session/me').set('Cookie', nora)).status).toBe(401);
    expect((await events('req-0004', priya)).at(-1)).toEqual(['revoked', 'u-priya']);
    // Twice is the 409.
    expect((await request(app).post('/api/access/requests/req-0004/revoke').set('Cookie', priya).send({ reason: 'Again.' })).status).toBe(409);
  });
});

describe('access reviews', () => {
  type ReviewBody = { review: AccessReview; items: AccessReviewItem[] };

  it('the seeded campaign: the owner sees every item and its progress; a requester sees none that are not hers', async () => {
    const priya = await signIn('u-priya');
    const list = (await request(app).get('/api/access/reviews').set('Cookie', priya)).body as { items: AccessReview[] };
    expect(list.items).toEqual([expect.objectContaining({ id: 'rev-0001', tenant: 'orgiq', status: 'open', owner: expect.objectContaining({ id: 'u-priya' }),
      progress: { total: 4, decided: 2, kept: 2, revoked: 0 }, can: { decide: true } })]);
    const one = (await request(app).get('/api/access/reviews/rev-0001').set('Cookie', priya)).body as ReviewBody;
    expect(one.items.map((i) => [i.user.id, i.role, i.decision, i.can.decide])).toEqual([
      ['u-caleb', 'sme', null, true], ['u-eli', 'sme', 'keep', false], ['u-layla', 'sme', null, true], ['u-nora', 'sme', 'keep', false],
    ]);
    const rhea = await signIn('u-rhea');
    expect(((await request(app).get('/api/access/reviews/rev-0001').set('Cookie', rhea)).body as ReviewBody).items).toEqual([]);
    expect((await request(app).get('/api/access/reviews/rev-9999').set('Cookie', priya)).status).toBe(404);
  });

  it('keep records; revoke is a pre-approved revocation revoked by the reviewer; the campaign closes when every item is decided', async () => {
    const priya = await signIn('u-priya');
    const omar = await signIn('u-omar');
    const calebEpoch = (await getUser('u-caleb'))!.epoch;
    // An approver who neither owns the campaign nor is an access admin.
    expect((await request(app).post('/api/access/reviews/rev-0001/items/ri-0003/decide').set('Cookie', omar).send({ decision: 'keep' })).status).toBe(403);
    expect((await request(app).post('/api/access/reviews/rev-0001/items/ri-0003/decide').set('Cookie', priya).send({ decision: 'maybe' })).status).toBe(400);

    const kept = await request(app).post('/api/access/reviews/rev-0001/items/ri-0003/decide').set('Cookie', priya).send({ decision: 'keep', comment: 'Still dispatching.' });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ review: { status: 'open', progress: { decided: 3 } }, item: { id: 'ri-0003', decision: 'keep', decidedBy: { id: 'u-priya' } } });
    // Decided once.
    expect((await request(app).post('/api/access/reviews/rev-0001/items/ri-0003/decide').set('Cookie', priya).send({ decision: 'revoke', comment: 'Changed my mind.' })).status).toBe(409);
    // A revoke states its reason.
    expect((await request(app).post('/api/access/reviews/rev-0001/items/ri-0004/decide').set('Cookie', priya).send({ decision: 'revoke' })).status).toBe(400);

    bell = [];
    const revoked = await request(app).post('/api/access/reviews/rev-0001/items/ri-0004/decide').set('Cookie', priya).send({ decision: 'revoke', comment: 'No dispatched work since July.' });
    expect(revoked.status).toBe(200);
    const body = revoked.body as { review: AccessReview; item: AccessReviewItem };
    expect(body.review).toMatchObject({ status: 'closed', closedAt: expect.any(String), progress: { total: 4, decided: 4, kept: 3, revoked: 1 }, can: { decide: false } });
    expect(body.item).toMatchObject({ decision: 'revoke', revocationRequestId: expect.stringMatching(/^req-/) });
    // The grant is gone and Caleb's cookies are retired.
    const after = (await getUser('u-caleb'))!;
    expect(after.grants.orgiq ?? []).not.toContain('sme');
    expect(after.epoch).toBe(calebEpoch + 1);
    // The revocation is a request of its own, pre-approved by the reviewer, revoked by her.
    const rev = (await request(app).get(`/api/access/requests/${body.item.revocationRequestId}`).set('Cookie', priya)).body as AccessRequest;
    expect(rev).toMatchObject({ kind: 'revocation', reviewId: 'rev-0001', status: 'revoked', requester: { id: 'u-priya' }, beneficiary: { id: 'u-caleb' },
      item: { id: 'role:orgiq:sme' }, steps: [expect.objectContaining({ kind: 'access-admin', status: 'approved', decidedBy: expect.objectContaining({ id: 'u-priya' }) })] });
    expect(await events(rev.id, priya)).toEqual([['submitted', 'u-priya'], ['approved', 'u-priya'], ['revoked', 'u-priya']]);
    // A closed campaign takes no decision.
    expect((await request(app).post('/api/access/reviews/rev-0001/items/ri-0001/decide').set('Cookie', priya).send({ decision: 'keep' })).status).toBe(409);
  });

  it('a campaign is built from the directory\'s standing grants in one tenant; revoking a grant a request provisioned revokes that request too', async () => {
    const omar = await signIn('u-omar');
    expect((await request(app).post('/api/access/reviews').set('Cookie', omar).send({ tenant: 'orgiq', title: 'Work Q4' })).status).toBe(403);
    const priya = await signIn('u-priya');
    expect((await request(app).post('/api/access/reviews').set('Cookie', priya).send({ tenant: 'access', title: 'Access Q4' })).status).toBe(400);
    expect((await request(app).post('/api/access/reviews').set('Cookie', priya).send({ tenant: 'orgiq' })).status).toBe(400);

    const made = await request(app).post('/api/access/reviews').set('Cookie', priya).send({ tenant: 'orgiq', title: 'Work Q4 certification' });
    expect(made.status).toBe(201);
    const { review, items } = made.body as ReviewBody;
    expect(review).toMatchObject({ id: 'rev-0002', tenant: 'orgiq', status: 'open', owner: { id: 'u-priya' }, can: { decide: true } });
    // One item per (user, role) the directory holds in orgiq now; the cross-tenant admin is not reviewed here.
    const expected = (await listUsers({ authoritative: true }))
      .flatMap((u) => (u.grants['orgiq'] ?? []).filter((r) => r !== 'admin').map((r) => `${u.id}:${r}`)).sort();
    expect(items.map((i) => `${i.user.id}:${i.role}`).sort()).toEqual(expected);
    expect(review.progress).toEqual({ total: expected.length, decided: 0, kept: 0, revoked: 0 });

    // Nora's sme came from req-0004 (active, standing): revoking it ends that request as well.
    const nora = items.find((i) => i.user.id === 'u-nora' && i.role === 'sme')!;
    const res = await request(app).post(`/api/access/reviews/${review.id}/items/${nora.id}/decide`).set('Cookie', priya).send({ decision: 'revoke', comment: 'Rotation ended.' });
    expect(res.status).toBe(200);
    const original = (await request(app).get('/api/access/requests/req-0004').set('Cookie', priya)).body as AccessRequest;
    expect(original.status).toBe('revoked');
    expect((await events('req-0004', priya)).at(-1)).toEqual(['revoked', 'u-priya']);
  });

  it('nobody certifies their own access', async () => {
    await setGrants('u-priya', { access: ['access-admin'], orgiq: ['member'] });
    const priya = await signIn('u-priya');
    const made = (await request(app).post('/api/access/reviews').set('Cookie', priya).send({ tenant: 'orgiq', title: 'Work Q4 certification' })).body as ReviewBody;
    const own = made.items.find((i) => i.user.id === 'u-priya')!;
    expect(own.can.decide).toBe(false);
    const res = await request(app).post(`/api/access/reviews/${made.review.id}/items/${own.id}/decide`).set('Cookie', priya).send({ decision: 'keep' });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/your own access/);
  });
});

describe('configuration', () => {
  type Config = { durations: { offered: string[]; standingReasonMin: number }; stewards: Array<{ scope: string; rule: string; role: string | null }>; items: Array<{ id: string; defaultDuration: string; sensitive: boolean }> };

  it('GET answers JSON for every access role: durations, stewards and the catalog items\' defaults', async () => {
    const rhea = await signIn('u-rhea');
    const res = await request(app).get('/api/access/configuration').set('Cookie', rhea);
    expect(res.status).toBe(200);
    const body = res.body as Config;
    expect(body.durations).toEqual({ offered: ['8h', '24h', '7d', '30d', 'standing'], standingReasonMin: 20 });
    expect(body.stewards).toEqual(expect.arrayContaining([
      expect.objectContaining({ scope: 'tenant-role', role: 'hr-admin' }), expect.objectContaining({ scope: 'initiative-membership', rule: 'initiative-owner' }),
    ]));
    expect(body.items.find((i) => i.id === 'role:orgiq:org-leader')).toMatchObject({ defaultDuration: '7d', sensitive: true });
  });

  it('PUT (ManageAccessPolicy) edits an item\'s default duration and sensitive flag; unknown keys, fixed rules and bad values are 400', async () => {
    const omar = await signIn('u-omar');
    expect((await request(app).put('/api/access/configuration').set('Cookie', omar).send({ items: [] })).status).toBe(403);
    const priya = await signIn('u-priya');
    const put = (body: unknown) => request(app).put('/api/access/configuration').set('Cookie', priya).send(body as object);
    expect((await put({ items: [], colour: 'red' })).status).toBe(400);
    expect((await put({ stewards: [] })).status).toBe(400);
    expect((await put({ items: [{ id: 'role:orgiq:sme', defaultDuration: '90d' }] })).status).toBe(400);
    expect((await put({ items: [{ id: 'role:orgiq:sme', sensitive: 'yes' }] })).status).toBe(400);
    expect((await put({ items: [{ id: 'role:orgiq:nope', sensitive: true }] })).status).toBe(400);
    expect((await put({ items: [{ id: 'role:orgiq:sme', stewardRule: 'initiative-owner' }] })).status).toBe(400);
    // A refused batch writes nothing, even its valid entries.
    expect((await put({ items: [{ id: 'role:orgiq:sme', sensitive: true }, { id: 'x' }] })).status).toBe(400);
    expect(accessCatalogFixture.rows().find((i) => i.id === 'role:orgiq:sme')!.sensitive).toBe(false);

    const ok = await put({ items: [{ id: 'role:orgiq:sme', defaultDuration: '7d', sensitive: true }] });
    expect(ok.status).toBe(200);
    expect((ok.body as Config).items.find((i) => i.id === 'role:orgiq:sme')).toMatchObject({ defaultDuration: '7d', sensitive: true });
    // A sensitive item now adds the access-admin step to a new request.
    const rhea = await signIn('u-rhea');
    const filed = await request(app).post('/api/access/requests').set('Cookie', rhea).send({ itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' });
    expect((filed.body as AccessRequest).steps.map((s) => s.kind)).toEqual(['manager', 'steward', 'access-admin']);
  });
});

describe('escalation when a step has nobody eligible (decided during A0)', () => {
  it('Omar files for Rhea: he is her manager AND the requester, so the manager step escalates to the access admins and says why', async () => {
    const omar = await signIn('u-omar');
    const filed = await request(app).post('/api/access/requests').set('Cookie', omar)
      .send({ itemId: 'role:pipelines:operator', justification: JUST, duration: '7d', beneficiaryId: 'u-rhea' });
    expect(filed.status).toBe(201);
    const steps = (filed.body as AccessRequest).steps;
    expect(steps[0]).toMatchObject({ kind: 'manager', eligible: [expect.objectContaining({ id: 'u-priya' })], escalated: expect.stringMatching(/access admins: the manager is a party/) });
    // The pipelines steward (Dara) holds no deciding role in Access: the steward step escalates too.
    expect(steps[1]).toMatchObject({ kind: 'steward', eligible: [expect.objectContaining({ id: 'u-priya' })], escalated: expect.stringMatching(/no deciding role in Access/) });
    // Priya sees it in her inbox and decides it; the record is never stuck on nobody.
    const priya = await signIn('u-priya');
    expect(((await request(app).get('/api/access/approvals').set('Cookie', priya)).body as { items: AccessRequest[] }).items.map((r) => r.id)).toContain((filed.body as AccessRequest).id);
  });

  it('a candidate who becomes ineligible later moves the step on at the next read', async () => {
    const rhea = await signIn('u-rhea');
    const filed = await request(app).post('/api/access/requests').set('Cookie', rhea).send({ itemId: 'role:assessment:assessor', justification: JUST, duration: '7d' });
    const id = (filed.body as AccessRequest).id;
    expect((filed.body as AccessRequest).steps[0]).toMatchObject({ eligible: [expect.objectContaining({ id: 'u-omar' })], escalated: null });
    // Omar loses his deciding role in Access.
    await setGrants('u-omar', { access: ['requester'] });
    const now = (await request(app).get(`/api/access/requests/${id}`).set('Cookie', rhea)).body as AccessRequest;
    expect(now.steps[0]).toMatchObject({ eligible: [expect.objectContaining({ id: 'u-priya' })], escalated: expect.stringMatching(/no deciding role in Access/) });
  });

  it('when every access admin is a party, the platform admins decide', async () => {
    const priya = await signIn('u-priya');
    // Priya asks for a sensitive item for herself: she is the only access admin.
    const filed = await request(app).post('/api/access/requests').set('Cookie', priya).send({ itemId: 'role:orgiq:org-leader', justification: JUST, duration: '7d' });
    expect(filed.status).toBe(201);
    const steps = (filed.body as AccessRequest).steps;
    expect(steps.at(-1)).toMatchObject({ kind: 'access-admin', eligible: [expect.objectContaining({ id: 'u-operator' })], escalated: expect.stringMatching(/platform admins/) });
    expect(steps.every((s) => s.eligible.length > 0)).toBe(true);
  });
});

describe('policy audit', () => {
  it('saving a policy records a policy-updated event (no request) with severity before/after, read by DecideAccess holders only', async () => {
    const priya = await signIn('u-priya');
    const res = await request(app).put('/api/access/policies/sod-003').set('Cookie', priya).send({ severity: 'block', reason: 'Lead assessors no longer approve exceptions on scores they can also enter.' });
    expect(res.status).toBe(200);
    const audit = async (cookie: string, q = '') => ((await request(app).get(`/api/access/audit${q}`).set('Cookie', cookie)).body as { items: AccessEvent[] }).items;
    const ev = (await audit(priya)).find((e) => e.kind === 'policy-updated');
    expect(ev).toMatchObject({ requestId: null, policyId: 'sod-003', actor: { id: 'u-priya' }, before: 'warn', after: 'block', reason: expect.stringMatching(/Score and approve exceptions: reason now/) });
    const omar = await signIn('u-omar');
    expect((await audit(omar)).some((e) => e.kind === 'policy-updated')).toBe(true);
    // A requester reads her own requests' events, never policy changes; a requestId filter never includes them.
    const rhea = await signIn('u-rhea');
    expect((await audit(rhea)).some((e) => e.kind === 'policy-updated')).toBe(false);
    expect((await audit(priya, '?requestId=req-0002')).some((e) => e.kind === 'policy-updated')).toBe(false);
  });
});
