// The candidate's link (docs/interviews-tenant-plan.md row I2.1; decision 3): the recruiter's three routes
// (routes/interviews/invite.ts), the exchange and the guest's read (routes/interview-invite.ts), and the guest
// principal (lib/interviews/invite/guest.ts), mounted as index.ts mounts them behind the REAL session
// middleware, with ManageCandidates decided from the REAL seeds/roles/*/*.cedar files.
//
//   recruiter       issues, reads and revokes a link; the link is answered once and never again
//   lead            makes, re-makes and reads the link for a round they lead (the room's control); never revokes
//   hiring-manager  every invite route refused (404)
//   interviewer     every invite route refused (404) on a round they do not lead, the panel's seat included
//   another tenant  the tenant's usual refusal at the mount
//   a guest         exchanges the link for its own cookie and reads its own interview, nothing more; refused
//                   the moment the invite is revoked, expires, or a newer opening of the link replaces it
//
// The jest setup turns INSECURE_DEV_MODE on, so the demo fallback is live here: these tests also show a guest
// never becomes the demo identity. The whole-surface sweep is interviews-invite-sweep.test.ts.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn() }));

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-invite-test-key';

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireSession, requireTenant, resolveSession } from '../../lib/authz.js';
import { COOKIE_NAME, GUEST_COOKIE_NAME, sessionMiddleware, signSession, type Session } from '../../lib/session.js';
import { listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { EXCHANGE_FLOOR_MS, interviewInviteRouter, resetInviteThrottle } from '../interview-invite.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { interviewInvitesFixture } from '../../mock/interviews-invites.js';
import { interviewsFixture } from '../../mock/interviews.js';
import { newInviteToken } from '../../lib/interviews/invite/token.js';
import { config } from '../../config.js';
import * as liveHint from '../../lib/interviews/live-hint.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
];

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware());
// A staff persona by header, standing in for the signed cookie the real login sets.
app.use((req, _res, next) => {
  const me = USERS.find((x) => x.id === String(req.headers['x-user'] ?? ''));
  if (me) {
    const tenant = Object.keys(me.grants)[0]!;
    req.session = { sub: me.id, name: me.displayName, tenant, role: me.grants[tenant]![0], grants: me.grants, iat: 0, epoch: 0 } as Session;
    req.sessionInvalid = false;
    req.sessionSource = 'cookie'; // a signed-in staff session, as a verified cookie makes it
  }
  next();
});
app.use('/api/interview-invite', interviewInviteRouter);
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.get('/api/anything-signed-in', requireSession(), (req, res) => { res.json({ sub: resolveSession(req)?.sub }); });
app.use(errorHandler);

const IV = 'iv-k1p5w8ra';
const as = (user: string) => ({
  post: (p: string) => request(app).post(`/api/interviews${p}`).set('x-user', user).send({}),
  get: (p: string) => request(app).get(`/api/interviews${p}`).set('x-user', user),
  del: (p: string) => request(app).delete(`/api/interviews${p}`).set('x-user', user),
});
const GRETA = as('u-greta');

/** The guest cookie's `name=value` from a Set-Cookie answer. */
function guestCookie(res: { headers: Record<string, unknown> }): string {
  const set = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []);
  const line = set.find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
const exchange = (token: unknown) => request(app).post('/api/interview-invite/exchange').send({ token });
const readAsGuest = (cookie: string) => request(app).get('/api/interview-invite/interview').set('Cookie', cookie);
async function issue(id = IV): Promise<string> {
  const res = await GRETA.post(`/interviews/${id}/invite`);
  expect(res.status).toBe(201);
  return String(res.body.linkPath).split('#')[1]!;
}

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
});

describe('the recruiter\'s routes', () => {
  it('issues a link once: the token rides in the fragment, the answer is not cached, and no later read shows it', async () => {
    const res = await GRETA.post(`/interviews/${IV}/invite`);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.linkPath).toMatch(/^\/join#[A-Za-z0-9_-]{43}$/);
    expect(res.body.invite).toMatchObject({ state: 'live', issuedBy: { id: 'u-greta', name: 'Greta Lindqvist' }, openCount: 0, revokedAt: null });
    const token = String(res.body.linkPath).split('#')[1]!;
    const status = await GRETA.get(`/interviews/${IV}/invite`);
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toContain(token);
    expect(JSON.stringify(status.body)).not.toMatch(/[0-9a-f]{64}/);
    expect(JSON.stringify(interviewInvitesFixture.rows())).not.toContain(token);
  });

  it('issuing again revokes the link before it', async () => {
    const first = await issue();
    await issue();
    expect((await exchange(first)).status).toBe(404);
    expect(interviewInvitesFixture.rows().filter((r) => r.interviewId === IV && r.revokedAt === null)).toHaveLength(1);
  });

  it('refuses a link for an interview that is over, and answers not-found for one that is not there', async () => {
    expect((await GRETA.post('/interviews/iv-d7q4n9xe/invite')).status).toBe(409);
    expect((await GRETA.post('/interviews/iv-nope/invite')).status).toBe(404);
    expect((await GRETA.get('/interviews/iv-nope/invite')).status).toBe(404);
  });

  it.each([['an interviewer who does not lead it', 'u-wen'], ['the hiring manager', 'u-amara']])('%s may not issue, read or revoke a link (not-found, never 403)', async (_who, user) => {
    const them = as(user);
    expect((await them.post(`/interviews/${IV}/invite`)).status).toBe(404);
    expect((await them.get(`/interviews/${IV}/invite`)).status).toBe(404);
    expect((await them.del(`/interviews/${IV}/invite`)).status).toBe(404);
  });

  it('the round\'s lead makes, re-makes and reads the link for their own round, but may not revoke it', async () => {
    const HUGO = as('u-hugo'); // leads Mateo's design round (IV)
    const made = await HUGO.post(`/interviews/${IV}/invite`);
    expect(made.status).toBe(201);
    expect(made.headers['cache-control']).toBe('no-store');
    expect(made.body.invite).toMatchObject({ state: 'live', issuedBy: { id: 'u-hugo', name: 'Hugo Marchetti' } });
    const first = String(made.body.linkPath).split('#')[1]!;
    const status = await HUGO.get(`/interviews/${IV}/invite`);
    expect(status.status).toBe(200);
    expect(JSON.stringify(status.body)).not.toContain(first);
    // A new link revokes the one before, as it does for the recruiter.
    expect((await HUGO.post(`/interviews/${IV}/invite`)).status).toBe(201);
    expect((await exchange(first)).status).toBe(404);
    expect((await HUGO.del(`/interviews/${IV}/invite`)).status).toBe(404);
    // The rules still hold for the lead: a round that is over gets no link (Ingrid's coding round, lead Hugo).
    expect((await HUGO.post('/interviews/iv-d7q4n9xe/invite')).status).toBe(409);
  });

  it('a panel member and another round\'s interviewer may not make or read the link (not-found, never 403)', async () => {
    const PANEL = 'iv-n5z9f2cq'; // Nadia's leadership round: Wen leads, Hugo sits on the panel
    expect((await as('u-hugo').post(`/interviews/${PANEL}/invite`)).status).toBe(404);
    expect((await as('u-hugo').get(`/interviews/${PANEL}/invite`)).status).toBe(404);
    expect((await as('u-wen').post(`/interviews/${PANEL}/invite`)).status).toBe(201);
    const AIKO = 'iv-c3k8w2ma'; // Aiko's coding round: Wen leads, Hugo has no seat
    expect((await as('u-hugo').post(`/interviews/${AIKO}/invite`)).status).toBe(404);
    expect((await as('u-hugo').get(`/interviews/${AIKO}/invite`)).status).toBe(404);
    expect(interviewInvitesFixture.rows().some((r) => r.interviewId === AIKO)).toBe(false);
  });

  it('another tenant\'s role is refused at the mount', async () => {
    expect((await as('u-priya').post(`/interviews/${IV}/invite`)).status).toBe(403);
  });

  it('revokes the live link and says so in the status', async () => {
    await issue();
    const res = await GRETA.del(`/interviews/${IV}/invite`);
    expect(res.status).toBe(200);
    expect(res.body.invite).toMatchObject({ state: 'revoked' });
    expect(res.body.invite.revokedAt).not.toBeNull();
  });
});

describe('the exchange and the guest\'s read', () => {
  it('trades a live link for a guest cookie of its own, scoped to the guest routes, and shows the opening, the round and the time', async () => {
    const token = await issue();
    const res = await exchange(token);
    expect(res.status).toBe(200);
    const set = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`))!;
    expect(set).toMatch(/Path=\/api\/interview-invite/);
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]).some((c) => c.startsWith(`${COOKIE_NAME}=`))).toBe(false);
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const iv = interviewsFixture.rows().find((i) => i.id === IV)!;
    expect(res.body.interview).toEqual({ opening: { title: expect.any(String) }, round: { name: 'Coding', minutes: iv.minutes }, scheduledAt: iv.scheduledAt });
    // Nothing of the panel or the candidate's record in the exchange.
    for (const name of ['Hugo', 'Wen', 'Greta', 'Amara', 'Mateo', 'app-', 'u-']) expect(JSON.stringify(res.body)).not.toContain(name);
    const read = await readAsGuest(guestCookie(res));
    expect(read.status).toBe(200);
    // The read adds who the candidate is meeting: the lead's display name and how many others sit on the panel.
    expect(read.body).toEqual({ interview: { ...res.body.interview, panel: { lead: 'Hugo Marchetti', others: iv.panelIds.length } } });
    // Nothing else of the panel's or the candidate's record: no ids, no emails, no other names.
    const text = JSON.stringify(read.body);
    for (const name of ['Wen', 'Greta', 'Amara', 'Mateo', 'app-', 'u-', '@']) expect(text).not.toContain(name);
  });

  it('the guest\'s read counts the other interviewers and names no one the directory does not know', async () => {
    const cookie = guestCookie(await exchange(await issue()));
    (listUsers as jest.Mock).mockResolvedValue(USERS.filter((x) => x.id !== 'u-hugo'));
    expect((await readAsGuest(cookie)).body.interview.panel).toEqual({ lead: null, others: 0 });
    (listUsers as jest.Mock).mockRejectedValue(new Error('directory down'));
    expect((await readAsGuest(cookie)).body.interview.panel).toEqual({ lead: null, others: 0 });

    (listUsers as jest.Mock).mockResolvedValue(USERS);
    const withPanel = interviewsFixture.rows().find((i) => i.id === 'iv-n5z9f2cq')!;
    expect(withPanel.panelIds.length).toBeGreaterThan(0);
    const read = await readAsGuest(guestCookie(await exchange(await issue(withPanel.id))));
    expect(read.status).toBe(200);
    expect(read.body.interview.panel).toEqual({ lead: 'Wen Zhao', others: withPanel.panelIds.length });
    for (const name of ['Hugo', ...withPanel.panelIds]) expect(JSON.stringify(read.body)).not.toContain(name);
  });

  it('answers a wrong, malformed, revoked, expired or closed link the same way, no sooner than the floor', async () => {
    const revoked = await issue('iv-c3k8w2ma');
    await GRETA.del('/interviews/iv-c3k8w2ma/invite');
    const expired = await issue('iv-h4m7c3vu');
    interviewInvitesFixture.rows().find((r) => r.interviewId === 'iv-h4m7c3vu')!.expiresAt = new Date(Date.now() - 1000).toISOString();
    const closed = await issue('iv-m8t3h6ng');
    interviewsFixture.rows().find((i) => i.id === 'iv-m8t3h6ng')!.state = 'cancelled';
    const answers = [];
    for (const t of [newInviteToken(), 'not-a-token', '', 42, revoked, expired, closed]) {
      const startedAt = Date.now();
      const res = await exchange(t);
      answers.push({ status: res.status, body: res.body, cookie: res.headers['set-cookie'] ?? null, slow: Date.now() - startedAt >= EXCHANGE_FLOOR_MS - 5 });
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 404, body: { error: 'This link no longer works.' }, cookie: null, slow: true });
  });

  it('reuse: the link keeps working, every opening is recorded, and a new opening ends the guest session before it', async () => {
    const token = await issue();
    const first = guestCookie(await exchange(token));
    const second = guestCookie(await exchange(token));
    expect((await readAsGuest(first)).status).toBe(404);
    expect((await readAsGuest(second)).status).toBe(200);
    const status = (await GRETA.get(`/interviews/${IV}/invite`)).body.invite;
    expect(status.openCount).toBe(2);
    expect(status.firstOpenedAt).not.toBeNull();
  });

  it('revocation ends the guest at once', async () => {
    const cookie = guestCookie(await exchange(await issue()));
    expect((await readAsGuest(cookie)).status).toBe(200);
    await GRETA.del(`/interviews/${IV}/invite`);
    const res = await readAsGuest(cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'This link no longer works.' });
  });

  it('expiry ends the guest at once, and so does the interview closing', async () => {
    const cookie = guestCookie(await exchange(await issue()));
    interviewInvitesFixture.rows().find((r) => r.interviewId === IV && r.revokedAt === null)!.expiresAt = new Date(Date.now() - 1).toISOString();
    expect((await readAsGuest(cookie)).status).toBe(404);
    fixtureRegistry.resetAll('default');
    const again = guestCookie(await exchange(await issue()));
    interviewsFixture.rows().find((i) => i.id === IV)!.state = 'ended';
    expect((await readAsGuest(again)).status).toBe(404);
  });

  it('one interview only: the guest\'s read answers for its own interview whatever it asks for', async () => {
    const cookie = guestCookie(await exchange(await issue()));
    await issue('iv-c3k8w2ma');
    const res = await request(app).get('/api/interview-invite/interview?id=iv-c3k8w2ma').set('Cookie', cookie);
    expect(res.body.interview.round.name).toBe('Coding');
    expect((await request(app).get('/api/interview-invite/interview/iv-c3k8w2ma').set('Cookie', cookie)).status).toBe(404);
  });

  it('a forged or borrowed cookie is no guest: a staff session value in the guest cookie, a guest value in the staff cookie', async () => {
    const staff = await signSession({ sub: 'u-greta', tenant: 'interviews', role: 'recruiter', grants: { interviews: ['recruiter'] }, iat: Math.floor(Date.now() / 1000), epoch: 0 } as Session);
    expect((await readAsGuest(`${GUEST_COOKIE_NAME}=${staff}`)).status).toBe(404);
    const guest = guestCookie(await exchange(await issue())).split('=').slice(1).join('=');
    const res = await request(app).get('/api/anything-signed-in').set('Cookie', `${COOKIE_NAME}=${guest}`);
    expect(res.status).toBe(401);
  });

  it('the exchange is throttled per client', async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await exchange('x')).status;
    expect(last).toBe(429);
  }, 30_000);
});

describe('a guest against the staff side, and staff against the guest side', () => {
  it('a guest cookie alone is never the demo identity: every staff gate refuses it', async () => {
    const cookie = guestCookie(await exchange(await issue()));
    expect((await request(app).get('/api/anything-signed-in')).status).toBe(200); // the demo fallback is live here
    expect((await request(app).get('/api/anything-signed-in').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).get(`/api/interviews/interviews/${IV}`).set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).get(`/api/interviews/interviews/${IV}/invite`).set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).post(`/api/interviews/interviews/${IV}/invite`).set('Cookie', cookie).send({})).status).toBe(401);
  });

  it('a recruiter on the guest routes is not a guest, and keeps their own session while holding a guest cookie', async () => {
    expect((await request(app).get('/api/interview-invite/interview').set('x-user', 'u-greta')).status).toBe(404);
    const cookie = guestCookie(await exchange(await issue()));
    const res = await request(app).get(`/api/interviews/interviews/${IV}/invite`).set('x-user', 'u-greta').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });
});

describe('the flag', () => {
  it('with INTERVIEWS_ENABLED off, the exchange, the guest\'s read and the recruiter\'s routes are not found', async () => {
    const token = await issue();
    const cookie = guestCookie(await exchange(token));
    process.env['INTERVIEWS_ENABLED'] = 'false';
    expect((await exchange(token)).status).toBe(404);
    expect((await readAsGuest(cookie)).status).toBe(404);
    expect((await GRETA.post(`/interviews/${IV}/invite`)).status).toBe(404);
    expect((await GRETA.get(`/interviews/${IV}/invite`)).status).toBe(404);
  });
});

// ── Row I2.2 (lane SEAT): the waiting room and the guest's realtime token ─────────────────────────────────────
describe('the waiting room', () => {
  const HUGO = as('u-hugo');
  const knock = (cookie: string) => request(app).post('/api/interview-invite/knock').set('Cookie', cookie).send();
  const mine = (cookie: string) => request(app).get('/api/interview-invite/admission').set('Cookie', cookie);
  const decide = (who: ReturnType<typeof as>, admit: unknown, id = IV) =>
    request(app).post(`/api/interviews/interviews/${id}/admit`).set('x-user', who === HUGO ? 'u-hugo' : who === GRETA ? 'u-greta' : 'u-wen').send({ admit });
  async function guest(): Promise<string> { return guestCookie(await exchange(await issue())); }

  it('knock, wait, be let in: the guest and the lead read the same admission', async () => {
    const cookie = await guest();
    expect((await mine(cookie)).body).toEqual({ admission: { state: 'not-knocked', knockedAt: null, decidedAt: null } });
    expect((await HUGO.get(`/interviews/${IV}/waiting`)).body.admission.state).toBe('not-knocked');
    const knocked = await knock(cookie);
    expect(knocked.status).toBe(200);
    expect(knocked.body.admission).toMatchObject({ state: 'waiting', decidedAt: null });
    expect((await HUGO.get(`/interviews/${IV}/waiting`)).body.admission.state).toBe('waiting');
    const admitted = await decide(HUGO, true);
    expect(admitted.status).toBe(200);
    expect(admitted.body.admission.state).toBe('admitted');
    expect((await mine(cookie)).body.admission.state).toBe('admitted');
  });

  it('turned away, the guest may knock again; a new opening of the link starts over', async () => {
    const token = await issue();
    const cookie = guestCookie(await exchange(token));
    await knock(cookie);
    expect((await decide(HUGO, false)).body.admission.state).toBe('turned-away');
    expect((await decide(HUGO, true)).status).toBe(409);
    expect((await knock(cookie)).body.admission.state).toBe('waiting');
    const again = guestCookie(await exchange(token));
    expect((await mine(again)).body.admission.state).toBe('not-knocked');
  });

  it('only the lead decides; the recruiter and the hiring manager (no ConductInterview) and other interviewers all read not-found', async () => {
    const cookie = await guest();
    await knock(cookie);
    expect((await decide(GRETA, true)).status).toBe(404);
    expect((await decide(as('u-wen'), true)).status).toBe(404);
    expect((await GRETA.get(`/interviews/${IV}/waiting`)).status).toBe(404);
    expect((await as('u-amara').get(`/interviews/${IV}/waiting`)).status).toBe(404);
    expect((await decide(HUGO, 'yes')).status).toBe(400);
    expect((await mine(cookie)).body.admission.state).toBe('waiting');
  });

  it('nobody to let in without a live link; a revoked link ends the guest\'s knock too', async () => {
    expect((await decide(HUGO, true)).status).toBe(409);
    const cookie = await guest();
    await knock(cookie);
    await GRETA.del(`/interviews/${IV}/invite`);
    expect((await HUGO.get(`/interviews/${IV}/waiting`)).body.admission.state).toBe('not-knocked');
    expect((await decide(HUGO, true)).status).toBe(409);
    expect((await knock(cookie)).status).toBe(404);
  });

  it('the guest\'s realtime token: a token for its own interview under guest realtime, not-found when it is off', async () => {
    const cookie = await guest();
    const prev = process.env['INTERVIEWS_GUEST_REALTIME'];
    try {
      const res = await request(app).get('/api/interview-invite/realtime-token').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const claims = JSON.parse(Buffer.from(String(res.body.token).split('.')[1]!, 'base64url').toString('utf8'));
      expect(claims).toMatchObject({ role: 'interview-guest', tenants: [], org: 'interviews', guest: { interviewId: IV } });
      expect(Date.parse(res.body.expiresAt)).toBeGreaterThan(Date.now());
      process.env['INTERVIEWS_GUEST_REALTIME'] = 'false';
      expect((await request(app).get('/api/interview-invite/realtime-token').set('Cookie', cookie)).status).toBe(404);
      expect((await request(app).get('/api/interview-invite/realtime-token')).status).toBe(404);
    } finally {
      if (prev === undefined) delete process.env['INTERVIEWS_GUEST_REALTIME']; else process.env['INTERVIEWS_GUEST_REALTIME'] = prev;
    }
  });

  // D1 (row I2.4, the candidate's side): the room, only once let in, and the ended page after.
  it('the room: not-found until the lead lets the guest in; then the call to join; ended after the lead ends it; not-found once turned away', async () => {
    const room = (cookie: string) => request(app).get('/api/interview-invite/room').set('Cookie', cookie);
    const roomWrite = async (what: 'start' | 'end') => {
      const revision = (await HUGO.get(`/interviews/${IV}/room`)).body.room.revision;
      return request(app).post(`/api/interviews/interviews/${IV}/${what}`).set('x-user', 'u-hugo').send({ revision });
    };
    expect((await request(app).get('/api/interview-invite/room')).status).toBe(404);
    const cookie = await guest();
    expect((await room(cookie)).status).toBe(404);
    await knock(cookie);
    const waiting = await room(cookie);
    expect([waiting.status, waiting.body]).toEqual([404, { error: 'This link no longer works.' }]);
    await decide(HUGO, true);
    const open = await room(cookie);
    expect(open.status).toBe(200);
    expect(open.headers['cache-control']).toBe('no-store');
    expect(open.headers['referrer-policy']).toBe('no-referrer');
    expect(open.body.room).toMatchObject({
      interviewId: IV, lobbyName: `interviews:interview:${IV}`, self: { displayName: 'Candidate' },
      round: { type: 'technical', minutes: 60 }, startedAt: null, state: 'open',
    });
    expect(String(open.body.room.self.userId)).toMatch(/^guest:/);
    // The lead's call id names whose tile carries the lead's name (E4 #32; the call's frames carry it anyway); no name, no other id.
    expect(open.body.room.leadCallId).toBe('u-hugo');
    const { leadCallId: _lead, ...rest } = open.body.room as Record<string, unknown>;
    expect(JSON.stringify(rest)).not.toMatch(/u-hugo|Hugo|u-greta|Greta|Mateo/);
    expect((await roomWrite('start')).status).toBe(200);
    expect((await room(cookie)).body.room.state).toBe('open');
    expect((await roomWrite('end')).status).toBe(200);
    const ended = await room(cookie);
    expect([ended.status, ended.body.room?.state]).toEqual([200, 'ended']);
    // Every other guest route treats the closed interview as a dead link.
    expect((await mine(cookie)).status).toBe(404);
  });

  it('a knock and the end each send the room one live hint, once a write really happened', async () => {
    const hint = jest.spyOn(liveHint, 'publishInterviewHint').mockResolvedValue(undefined);
    try {
      const cookie = await guest();
      await knock(cookie);
      expect(hint.mock.calls).toEqual([[IV, 'knock']]);
      await knock(cookie); // a second knock while waiting changes nothing
      expect(hint).toHaveBeenCalledTimes(1);
      await decide(HUGO, true);
      const first = (await HUGO.get(`/interviews/${IV}/room`)).body.room.revision;
      expect((await request(app).post(`/api/interviews/interviews/${IV}/start`).set('x-user', 'u-hugo').send({ revision: first })).status).toBe(200);
      const revision = (await HUGO.get(`/interviews/${IV}/room`)).body.room.revision;
      expect((await request(app).post(`/api/interviews/interviews/${IV}/end`).set('x-user', 'u-hugo').send({ revision: revision + 99 })).status).toBe(409);
      expect(hint).toHaveBeenCalledTimes(1);
      const live = (await HUGO.get(`/interviews/${IV}/room`)).body.room.revision;
      expect((await request(app).post(`/api/interviews/interviews/${IV}/end`).set('x-user', 'u-hugo').send({ revision: live })).status).toBe(200);
      expect(hint.mock.calls.at(-1)).toEqual([IV, 'ended']);
    } finally { hint.mockRestore(); }
  });

  it('the room is not-found for a guest the lead turned away, and after a revoke', async () => {
    const room = (cookie: string) => request(app).get('/api/interview-invite/room').set('Cookie', cookie);
    const cookie = await guest();
    await knock(cookie);
    await decide(HUGO, true);
    expect((await room(cookie)).status).toBe(200);
    await GRETA.del(`/interviews/${IV}/invite`);
    expect((await room(cookie)).status).toBe(404);
    const again = await guest();
    await knock(again);
    await decide(HUGO, false);
    expect((await room(again)).status).toBe(404);
  });

  it('the guest\'s realtime token carries the browser-facing endpoints the staff bridge sends, and nothing else new', async () => {
    const cookie = await guest();
    const saved = (config as { realtime?: unknown }).realtime;
    try {
      (config as { realtime?: unknown }).realtime = { gatewayUrl: 'http://gateway.test', platformApiUrl: 'http://platform.test', videoUrl: 'http://video.test' };
      const res = await request(app).get('/api/interview-invite/realtime-token').set('Cookie', cookie);
      expect(Object.keys(res.body).sort()).toEqual(['expiresAt', 'gatewayUrl', 'platformApiUrl', 'token', 'videoUrl']);
      expect(res.body).toMatchObject({ gatewayUrl: 'http://gateway.test', platformApiUrl: 'http://platform.test', videoUrl: 'http://video.test' });
      (config as { realtime?: unknown }).realtime = undefined;
      expect(Object.keys((await request(app).get('/api/interview-invite/realtime-token').set('Cookie', cookie)).body).sort()).toEqual(['expiresAt', 'token']);
    } finally {
      (config as { realtime?: unknown }).realtime = saved;
    }
  });
});
