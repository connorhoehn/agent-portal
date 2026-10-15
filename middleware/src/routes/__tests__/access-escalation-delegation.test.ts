// Escalation timers and delegation (2026-10-14; docs/access-tenant-api.md
// § "Escalation timers and delegation"; docs/access-tenant-goal.md §A3),
// through the real cookie path with the access tenant's real Cedar files, the
// memory identity provider as the directory and the registered fixtures:
//
//   * a step left current past the SLA escalates once per level — the access
//     admins, then the platform admins — with an `escalated` event and a bell
//     item to the people it newly reaches; the step's own decider keeps the
//     right, an escalated decider decides it, and a decision restarts the clock
//     on the next step;
//   * an approver delegates to another approver for a window: the delegate
//     sees and decides the delegator's steps "on behalf of" them (step and
//     event record it), never their own request, never an access-admin step
//     without holding access-admin, never through a second delegation; self,
//     a non-approver, an overlapping window, a chain and a party to a request
//     waiting on the delegator are refused; ending is the delegator's or an
//     access admin's, once.

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
import { accessReviewItemsFixture, accessReviewsFixture } from '../../mock/access-reviews.js';
import { accessDelegationsFixture } from '../../mock/access-delegations.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';
import { identityClonesFixture } from '../../mock/identity-clones.js';
import { requestReadableBy } from '../../lib/access/thread.js';
import { sweepAccessEscalations } from '../../lib/access-escalation.js';
import type { ReplicaFleet } from '../../lib/replica-fleet.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { initiatives } from '../../mock/initiatives.js';
import type { AccessDelegation, AccessEvent, AccessRequest, Person } from '../../lib/access/types.js';

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
const T0 = '2026-10-14T09:00:00.000Z';
const HOUR = 3_600_000;
const at = (h: number) => new Date(Date.parse(T0) + h * HOUR).toISOString();
let restoreClock: () => void;
const setClock = (iso: string) => { restoreClock(); restoreClock = freezeClock(iso); };
const solo: ReplicaFleet = {
  id: 'solo', async heartbeat() {}, async members() { return ['solo']; }, async peers() { return []; },
  async withLock<T>(_n: string, _t: number, fn: () => Promise<T>) { return fn(); }, async leave() {}, stop() {},
};

beforeEach(() => {
  restoreClock = freezeClock(T0);
  for (const f of [accessCatalogFixture, accessPoliciesFixture, accessPeopleFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture,
    accessReviewsFixture, accessReviewItemsFixture, accessDelegationsFixture, identityGrantWritesFixture, initiatives]) { f.reset(); f.rows(); }
  // ↑ rows() materialises the seed now, at T0: a fixture builds its rows (and their clock-relative stamps) on first read.
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
afterEach(() => { setNotificationSink(null); restoreClock(); unfreezeClock(); jest.restoreAllMocks(); });

const get = (url: string, cookie: string) => request(app).get(url).set('Cookie', cookie);
const post = (url: string, cookie: string, body: object = {}) => request(app).post(url).set('Cookie', cookie).send(body);
const record = async (id: string, cookie: string) => (await get(`/api/access/requests/${id}`, cookie)).body as AccessRequest;
const inbox = async (cookie: string) => ((await get('/api/access/approvals', cookie)).body as { items: AccessRequest[] }).items.map((r) => r.id);
const kinds = (id: string) => accessEventsFixture.rows().filter((e) => e.requestId === id).map((e) => e.kind);
const ids = (people: Person[]) => people.map((p) => p.id);

describe('escalation timers', () => {
  it('a step past its SLA reaches the access admins, then the platform admins, once per level', async () => {
    // req-0001 step 1 (manager: Omar) has been current since T0 - 3h.
    const [omar, priya] = [await signIn('u-omar'), await signIn('u-priya')];
    expect(await inbox(priya)).not.toContain('req-0001');
    const before = (await record('req-0001', omar)).steps[0]!;
    expect(before).toMatchObject({ status: 'current', escalationLevel: 0, escalatedAt: null, escalatesAt: at(45) });
    expect(ids(before.eligible)).toEqual(['u-omar']);

    setClock(at(44));
    // req-0002's steward step (current since T0 - 24h) is due first. Its own tier was already the
    // access admins (the initiative owner holds no deciding role in Access), so level 1 adds
    // nobody new and it goes straight to the platform admins.
    expect((await sweepAccessEscalations(solo)).escalated).toEqual(['req-0002#2→2']);
    bell = [];
    setClock(at(46));
    expect((await sweepAccessEscalations(solo)).escalated).toEqual(['req-0001#1→1']);
    // The same tick again changes nothing: the claim is the once-only rule.
    expect((await sweepAccessEscalations(solo)).escalated).toEqual([]);
    expect(kinds('req-0001')).toEqual(['submitted', 'escalated']);
    expect(accessEventsFixture.rows().filter((e) => e.requestId === 'req-0001').at(-1)!.reason)
      .toBe('Step 1 (manager) waited 2 days without a decision: escalated to the access admins. Now also: Priya Venkataraman.');
    expect(bell).toEqual([{ userId: 'u-priya', kind: 'access-escalated', href: '/access/requests/req-0001' }]);

    const step = (await record('req-0001', priya)).steps[0]!;
    expect(step).toMatchObject({ escalationLevel: 1, escalatedAt: at(46), escalatesAt: at(94) });
    expect(ids(step.eligible)).toEqual(['u-omar', 'u-priya']);
    expect(step.escalated).toBe('No decision in time: escalated to the access admins.');
    expect(await inbox(priya)).toContain('req-0001');

    setClock(at(95));
    bell = [];
    expect((await sweepAccessEscalations(solo)).escalated).toEqual(['req-0001#1→2']);
    expect(bell.map((b) => b.userId)).toEqual(['u-operator']);
    expect(ids((await record('req-0001', priya)).steps[0]!.eligible)).toEqual(['u-omar', 'u-operator', 'u-priya']);
    // At the top: no further escalation, however long it waits.
    setClock(at(400));
    expect((await sweepAccessEscalations(solo)).escalated).toEqual([]);
    expect((await record('req-0001', priya)).steps[0]!.escalatesAt).toBeNull();
  });

  it('an escalated decider decides; the own decider keeps the right; the next step starts its own clock', async () => {
    setClock(at(46));
    const swept = await sweepAccessEscalations(solo);
    expect(swept.escalated).toEqual(['req-0001#1→1', 'req-0002#2→2']);
    const priya = await signIn('u-priya');
    const decided = await post('/api/access/requests/req-0001/steps/1/decide', priya, { decision: 'approve', comment: 'Omar is away; approving as the access admin.' });
    expect(decided.status).toBe(200);
    const r = decided.body as AccessRequest;
    expect(r.steps[0]).toMatchObject({ status: 'approved', decidedBy: { id: 'u-priya' }, decidedOnBehalfOf: null });
    expect(r.steps[1]).toMatchObject({ status: 'current', currentSince: at(46), escalationLevel: 0, escalatesAt: at(94) });
    // The decided step never escalates again.
    setClock(at(200));
    expect((await sweepAccessEscalations(solo)).escalated).toEqual(['req-0001#2→2']);
  });

  it('two replicas escalate a step once (the fleet lock, then the step claim)', async () => {
    const locks = new Map<string, string>();
    const make = (id: string, peer: string): ReplicaFleet => ({
      id, async heartbeat() {}, async members() { return [id, peer]; }, async peers() { return [peer]; },
      async withLock<T>(name: string, _ttl: number, fn: () => Promise<T>) {
        if (locks.has(name)) return null;
        locks.set(name, id);
        try { return await fn(); } finally { if (locks.get(name) === id) locks.delete(name); }
      },
      async leave() {}, stop() {},
    });
    setClock(at(46));
    const [a, b] = await Promise.all([sweepAccessEscalations(make('replica-a', 'replica-b')), sweepAccessEscalations(make('replica-b', 'replica-a'))]);
    expect([a.ran, b.ran].sort()).toEqual(['locked-elsewhere', 'swept']);
    expect([...a.escalated, ...b.escalated]).toEqual(['req-0001#1→1', 'req-0002#2→2']);
    // Without the lock (it expired mid-sweep), the step claim still decides: two solo sweeps, one escalation.
    setClock(at(95));
    const [c, d] = await Promise.all([sweepAccessEscalations(solo), sweepAccessEscalations(solo)]);
    expect([...c.escalated, ...d.escalated]).toEqual(['req-0001#1→2']);
    expect(kinds('req-0001').filter((k) => k === 'escalated')).toHaveLength(2);
  });

  it('GET /configuration shows the SLA and the tiers read-only; PUT refuses them', async () => {
    const priya = await signIn('u-priya');
    expect((await get('/api/access/configuration', priya)).body).toMatchObject({ escalation: { stepSlaHours: 48, tiers: ['access-admins', 'platform-admins'] }, delegation: { maxDays: 30 } });
    const put = await request(app).put('/api/access/configuration').set('Cookie', priya).send({ escalation: { stepSlaHours: 1 }, items: [] });
    expect(put.status).toBe(400);
  });
});

describe('delegation', () => {
  const window = (h: number) => ({ startsAt: T0, endsAt: at(h) });
  const REASON = 'Out of office at the governance summit.';

  it('the delegate decides the delegator\'s step on behalf of them; the step and the event say so', async () => {
    const [omar, priya] = [await signIn('u-omar'), await signIn('u-priya')];
    expect(ids(((await get('/api/access/delegates', omar)).body as { items: Person[] }).items)).toEqual(['u-priya']);
    expect(await inbox(priya)).not.toContain('req-0001');
    const made = await post('/api/access/delegations', omar, { delegateId: 'u-priya', ...window(72), reason: REASON });
    expect(made.status).toBe(201);
    const d = made.body as AccessDelegation;
    expect(d).toMatchObject({ id: 'dlg-0002', delegator: { id: 'u-omar' }, delegate: { id: 'u-priya' }, state: 'active', can: { end: true } });
    expect(bell).toEqual([{ userId: 'u-priya', kind: 'access-delegated', href: '/access/approvals' }]);
    expect(accessEventsFixture.rows().at(-1)).toMatchObject({ kind: 'delegated', delegationId: 'dlg-0002', requestId: null, actorId: 'u-omar' });

    expect(await inbox(priya)).toContain('req-0001');
    const step = (await record('req-0001', priya)).steps[0]!;
    expect(step.eligible).toEqual([
      { id: 'u-omar', displayName: 'Omar Haddad', personId: 'p-omar' },
      { id: 'u-priya', displayName: 'Priya Venkataraman', personId: 'p-priya', onBehalfOf: { id: 'u-omar', displayName: 'Omar Haddad', personId: 'p-omar' } },
    ]);
    const decided = await post('/api/access/requests/req-0001/steps/1/decide', priya, { decision: 'approve', comment: 'Covering for Omar.' });
    expect(decided.status).toBe(200);
    expect((decided.body as AccessRequest).steps[0]).toMatchObject({ decidedBy: { id: 'u-priya' }, decidedOnBehalfOf: { id: 'u-omar' } });
    expect(accessEventsFixture.rows().filter((e) => e.requestId === 'req-0001').at(-1)).toMatchObject({ kind: 'step-approved', actorId: 'u-priya', reason: 'Covering for Omar. — decided on behalf of Omar Haddad' });
    expect(accessStepsFixture.rows().find((s) => s.requestId === 'req-0001' && s.step === 1)).toMatchObject({ delegatedFrom: 'u-omar' });
  });

  it('a delegation outside its window grants nothing; ending it early takes the steps back', async () => {
    const [omar, priya, rhea] = [await signIn('u-omar'), await signIn('u-priya'), await signIn('u-rhea')];
    const later = await post('/api/access/delegations', omar, { delegateId: 'u-priya', startsAt: at(24), endsAt: at(48), reason: REASON });
    expect((later.body as AccessDelegation).state).toBe('scheduled');
    expect(await inbox(priya)).not.toContain('req-0001');
    setClock(at(25));
    expect(await inbox(priya)).toContain('req-0001');
    const id = (later.body as AccessDelegation).id;
    // Only the delegator (or an access admin) ends it; outside the read rule it does not exist.
    // Rhea holds no DecideAccess: Cedar refuses before the row is looked at.
    expect((await post(`/api/access/delegations/${id}/end`, rhea)).status).toBe(403);
    const ended = await post(`/api/access/delegations/${id}/end`, omar, { reason: 'Back early.' });
    expect(ended.status).toBe(200);
    expect((ended.body as AccessDelegation)).toMatchObject({ state: 'ended', endedBy: { id: 'u-omar' }, endedAt: at(25), can: { end: false } });
    expect((await post(`/api/access/delegations/${id}/end`, omar)).status).toBe(409);
    // The seed's dlg-0001 ran its course two weeks ago: nothing left to end.
    expect((await post('/api/access/delegations/dlg-0001/end', omar)).status).toBe(409);
    expect(await inbox(priya)).not.toContain('req-0001');
    setClock(at(49));
    expect(((await get('/api/access/delegations', omar)).body as { items: AccessDelegation[] }).items.map((x) => [x.id, x.state])).toEqual([[id, 'ended'], ['dlg-0001', 'ended']]);
  });

  it('refuses self, a non-approver, an overlapping window, a chain and a party to a request waiting on the delegator', async () => {
    const [omar, priya, rhea] = [await signIn('u-omar'), await signIn('u-priya'), await signIn('u-rhea')];
    expect((await post('/api/access/delegations', omar, { delegateId: 'u-omar', ...window(24), reason: REASON })).status).toBe(403);
    const nonApprover = await post('/api/access/delegations', omar, { delegateId: 'u-rhea', ...window(24), reason: REASON });
    expect(nonApprover.status).toBe(409);
    expect((nonApprover.body as { error: string }).error).toMatch(/no deciding role/);
    expect((await post('/api/access/delegations', omar, { delegateId: 'u-priya', startsAt: at(10), endsAt: at(5), reason: REASON })).status).toBe(400);
    expect((await post('/api/access/delegations', omar, { delegateId: 'u-priya', ...window(24 * 31), reason: REASON })).status).toBe(400);
    expect((await post('/api/access/delegations', omar, { delegateId: 'u-priya', ...window(24), reason: 'short' })).status).toBe(400);
    expect((await post('/api/access/delegations', omar, { delegateId: 'u-priya', ...window(24), reason: REASON, extra: 1 })).status).toBe(400);
    // A requester cannot delegate at all (no DecideAccess).
    expect((await post('/api/access/delegations', rhea, { delegateId: 'u-omar', ...window(24), reason: REASON })).status).toBe(403);
    expect((await get('/api/access/delegates', rhea)).status).toBe(403);

    expect((await post('/api/access/delegations', omar, { delegateId: 'u-priya', ...window(24), reason: REASON })).status).toBe(201);
    const overlap = await post('/api/access/delegations', omar, { delegateId: 'u-priya', startsAt: at(12), endsAt: at(36), reason: REASON });
    expect(overlap.status).toBe(409);
    // Priya cannot hand her decisions to Omar while Omar's are with her: no chains, no loops.
    const loop = await post('/api/access/delegations', priya, { delegateId: 'u-omar', ...window(24), reason: REASON });
    expect(loop.status).toBe(409);
    expect((loop.body as { error: string }).error).toMatch(/never passed on/);

    // No delegation to the requester: Omar files for himself; his manager Priya decides step 1; she may not hand it to him.
    setClock(at(30));
    const filed = await post('/api/access/requests', omar, { itemId: 'role:orgiq:sme', justification: JUST, duration: '7d' });
    expect(filed.status).toBe(201);
    const party = await post('/api/access/delegations', priya, { delegateId: 'u-omar', startsAt: at(30), endsAt: at(40), reason: REASON });
    expect(party.status).toBe(409);
    expect((party.body as { error: string }).error).toMatch(new RegExp(`party to ${(filed.body as AccessRequest).id}`));
  });

  it('never makes a delegate eligible on their own request, or on an access-admin step without access-admin', async () => {
    const [omar, priya, rhea] = [await signIn('u-omar'), await signIn('u-priya'), await signIn('u-rhea')];
    // Rhea asks for Org leader (sensitive): manager (Omar), steward (no hr-admin decides in Access → the access admins), access-admin.
    const filed = await post('/api/access/requests', rhea, { itemId: 'role:orgiq:org-leader', justification: JUST, duration: '7d' });
    expect(filed.status).toBe(201);
    const id = (filed.body as AccessRequest).id;
    expect((await post('/api/access/delegations', priya, { delegateId: 'u-omar', ...window(48), reason: REASON })).status).toBe(201);
    expect((await post(`/api/access/requests/${id}/steps/1/decide`, omar, { decision: 'approve' })).status).toBe(200);
    const r = await record(id, omar);
    // Step 2 escalated to the access admins: Omar decides it for Priya; step 3 is an access-admin step he may not.
    expect(r.steps[1]!.eligible.find((p) => p.id === 'u-omar')).toMatchObject({ onBehalfOf: { id: 'u-priya' } });
    expect(ids(r.steps[2]!.eligible)).not.toContain('u-omar');
    // Omar also may not decide step 2 twice over by being the step-1 decider? He may: separate steps, same chain rules as before.
    expect((await post(`/api/access/requests/${id}/steps/2/decide`, omar, { decision: 'approve' })).status).toBe(200);
    expect((await post(`/api/access/requests/${id}/steps/3/decide`, omar, { decision: 'approve' })).status).toBe(403);

    // Omar's own request: Priya's delegate (Omar) never decides it.
    const own = await post('/api/access/requests', omar, { itemId: 'role:social:moderator', justification: JUST, duration: '7d' });
    expect(own.status).toBe(201);
    const ownId = (own.body as AccessRequest).id;
    const ownRecord = await record(ownId, omar);
    expect(ownRecord.steps.every((s) => !ids(s.eligible).includes('u-omar'))).toBe(true);
    expect((await post(`/api/access/requests/${ownId}/steps/1/decide`, omar, { decision: 'approve' })).status).toBe(403);
  });
});

describe('a session signed in as an identity clone (lane M) acts as its persona', () => {
  const clone = (id: string, from: string, personId: string, grants: Record<string, string[]>, displayName: string) => identityClonesFixture.rows().push({
    id, from, label: 'lane-a', displayName, email: null, personId, grants, epoch: 0, createdAt: T0, expiresAt: at(2),
  });
  afterEach(() => identityClonesFixture.reset());

  it('previews and files its own request, and reads its request thread', async () => {
    clone('u-rhea-clone-a', 'u-rhea', 'p-rhea', { access: ['requester'] }, 'Rhea Castellanos');
    clone('u-priya-clone-a', 'u-priya', 'p-priya', { access: ['access-admin'] }, 'Priya Venkataraman');
    const rhea = await signIn('u-rhea-clone-a');
    // Before 2026-10-14 the clone was "Unknown beneficiary" (400): listUsers leaves clones out.
    const preview = await post('/api/access/requests/preview', rhea, { itemId: 'role:pipelines:operator' });
    expect(preview.status).toBe(200);
    // A clone acts as its persona for record ownership (lib/record-owner.ts): the request is Rhea's.
    expect((preview.body as { beneficiary: Person }).beneficiary.id).toBe('u-rhea');
    // Her manager is Omar through the persona's person (p-rhea): no fixture-specific code.
    expect(ids((preview.body as { steps: Array<{ eligible: Person[] }> }).steps[0]!.eligible)).toEqual(['u-omar']);
    // The access-admin clone reads every request thread, as Priya does.
    expect(await requestReadableBy('req-0002', 'u-priya-clone-a')).toBe(true);
    expect(await requestReadableBy('req-0004', 'u-rhea-clone-a')).toBe(false);
  });

  it('lists the persona\'s requests, decides as the persona, and never stands beside it in a chain', async () => {
    clone('u-rhea-clone-b', 'u-rhea', 'p-rhea', { access: ['requester'] }, 'Rhea Castellanos');
    clone('u-omar-clone-b', 'u-omar', 'p-omar', { access: ['approver'] }, 'Omar Haddad');
    const rhea = await signIn('u-rhea-clone-b');
    // Rhea's seeded requests are keyed by u-rhea; her clone lists and opens them.
    const mine = await get('/api/access/requests?scope=mine', rhea);
    expect(mine.status).toBe(200);
    const listed = (mine.body as { items: AccessRequest[] }).items;
    expect(listed.some((r) => r.id === 'req-0001')).toBe(true);
    // ...and only them: Omar's own request stays his (personas stay isolated).
    expect(listed.every((r) => r.requester.id === 'u-rhea' || r.beneficiary.id === 'u-rhea')).toBe(true);
    expect((await get('/api/access/requests/req-0001', rhea)).status).toBe(200);
    // Omar's clone: the manager step names Omar once (not "Omar Haddad, Omar Haddad").
    const omar = await signIn('u-omar-clone-b');
    const r = await record('req-0001', omar);
    const first = r.steps.find((st) => st.step === 1)!;
    expect(ids(first.eligible).filter((id) => id.startsWith('u-omar'))).toEqual(['u-omar']);
  });
});
