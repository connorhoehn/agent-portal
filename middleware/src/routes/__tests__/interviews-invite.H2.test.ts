// Hardening lane H2, row I2.1 and the candidate's side of I2.4: the edges interviews-invite.test.ts leaves open, on the same
// mounting (the REAL session middleware, ManageCandidates from the REAL seeds/roles/*/*.cedar files).
//
//   the exchange's throttle behind a proxy        a forwarded address counts only when the proxy is trusted (O-047)
//   the guest cookie past its own age, then the link opened again                                        (O-048)
//   a reschedule moves the link's expiry, through the routes                                             (O-049)
//   the flag turned off and on again on one running app                                                  (O-050)
//   a link with no origin when the portal origin is not set                                              (O-052)
//   the realtime token asked after the end: not-found, and the cookie is dropped                         (O-072, server half)
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

// The date is pinned: the interviews seed places interviews on workdays, so the seed's "tomorrow" depends on the weekday the suite runs (O-049).
const PINNED_NOW = new Date('2026-11-18T10:00:00Z'); // a Wednesday
beforeAll(() => { jest.useFakeTimers({ now: PINNED_NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'queueMicrotask', 'performance', 'hrtime', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'] }); });
afterAll(() => { jest.useRealTimers(); });

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
});


import { resetInterviewsClock, setInterviewsClockOffset } from '../../lib/interviews/clock.js';
import { GUEST_SESSION_MAX_AGE_S } from '../../lib/interviews/invite/guest.js';
import { trustedProxyHops } from '../../lib/trusted-proxy.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
afterEach(() => { resetInterviewsClock(); delete process.env['TRUST_PROXY_HOPS']; });

/** The Set-Cookie line for the guest cookie, or null when the answer sets none. */
const guestSetCookie = (res: { headers: Record<string, unknown> }): string | null =>
  ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`)) ?? null;
/** A whole minute `ms` from now (a time is refused otherwise). */
const minuteFromNow = (ms: number) => new Date(Math.ceil((Date.now() + ms) / 60_000) * 60_000).toISOString();
async function moveTime(scheduledAt: string): Promise<void> {
  const revision = (await GRETA.get(`/interviews/${IV}`)).body.interview.revision;
  const res = await request(app).put(`/api/interviews/interviews/${IV}/time`).set('x-user', 'u-greta').send({ revision, scheduledAt });
  expect([res.status, res.body.error]).toEqual([200, undefined]);
}

describe('the exchange\'s throttle behind a proxy (O-047)', () => {
  // index.ts sets `trust proxy` from TRUST_PROXY_HOPS; this app is the same router behind one trusted hop.
  function behindProxy(): express.Express {
    process.env['TRUST_PROXY_HOPS'] = '1';
    const proxied = express();
    proxied.set('trust proxy', trustedProxyHops());
    proxied.use(express.json());
    proxied.use(cookieParser());
    proxied.use('/api/interview-invite', interviewInviteRouter);
    proxied.use(errorHandler);
    return proxied;
  }
  const from = (target: express.Express, forwarded: string) =>
    request(target).post('/api/interview-invite/exchange').set('x-forwarded-for', forwarded).send({ token: 'x' });

  it('behind a trusted proxy each forwarded client has its own window: one client throttled leaves another alone', async () => {
    const proxied = behindProxy();
    const first = await Promise.all(Array.from({ length: 31 }, () => from(proxied, '203.0.113.7')));
    expect(first.map((r) => r.status).filter((s) => s === 429)).toHaveLength(1);
    expect((await from(proxied, '203.0.113.7')).status).toBe(429);
    expect((await from(proxied, '198.51.100.9')).status).toBe(404);
  }, 30_000);

  it('with no trusted proxy a forwarded address is ignored: a new X-Forwarded-For on every call does not escape the window', async () => {
    const answers = await Promise.all(Array.from({ length: 31 }, (_, i) => from(app, `203.0.113.${i + 1}`)));
    expect(answers.map((r) => r.status).filter((s) => s === 429)).toHaveLength(1);
    expect((await from(app, '192.0.2.200')).status).toBe(429);
  }, 30_000);

  it('the throttle answers in words and sets no guest cookie', async () => {
    const proxied = behindProxy();
    await Promise.all(Array.from({ length: 30 }, () => from(proxied, '203.0.113.8')));
    const res = await from(proxied, '203.0.113.8');
    expect([res.status, res.body]).toEqual([429, { error: 'Too many requests. Wait a minute and try again.' }]);
    expect(guestSetCookie(res)).toBeNull();
  }, 30_000);
});

describe('the guest cookie past its own age, then the link opened again (O-048)', () => {
  it('the cookie is good for at most twelve hours; past that the guest is refused and the cookie dropped, and the same link opens a new session', async () => {
    const token = await issue();
    const opened = await exchange(token);
    const line = guestSetCookie(opened)!;
    const maxAge = Number(/Max-Age=(\d+)/i.exec(line)?.[1]);
    expect(maxAge).toBeGreaterThan(0);
    expect(maxAge).toBeLessThanOrEqual(GUEST_SESSION_MAX_AGE_S);
    const cookie = line.split(';')[0]!;
    expect((await readAsGuest(cookie)).status).toBe(200);

    // Thirteen hours on: the link is still alive (the interview is tomorrow), the cookie is not.
    expect(setInterviewsClockOffset(13 * HOUR, true)).toBe(true);
    const late = await readAsGuest(cookie);
    expect([late.status, late.body]).toEqual([404, { error: 'This link no longer works.' }]);
    expect(guestSetCookie(late)).toMatch(/Expires=Thu, 01 Jan 1970/);

    const again = await exchange(token);
    expect(again.status).toBe(200);
    const fresh = guestCookie(again);
    expect((await readAsGuest(fresh)).status).toBe(200);
    expect((await readAsGuest(cookie)).status).toBe(404);
    expect((await GRETA.get(`/interviews/${IV}/invite`)).body.invite.openCount).toBe(2);
  });
});

describe('a reschedule moves the link\'s expiry, through the routes (O-049)', () => {
  it('moving the interview earlier ends the link sooner; the recruiter\'s status says the new expiry', async () => {
    const token = await issue();
    const at = (offset: number) => { setInterviewsClockOffset(offset, true); return exchange(token); };
    expect((await at(27 * HOUR)).status).toBe(200); // tomorrow's round: the link lives a day past it
    resetInterviewsClock();
    const soon = minuteFromNow(2 * HOUR);
    await moveTime(soon);
    expect((await GRETA.get(`/interviews/${IV}/invite`)).body.invite.expiresAt).toBe(new Date(Date.parse(soon) + DAY).toISOString());
    expect((await at(25 * HOUR)).status).toBe(200);
    expect((await at(27 * HOUR)).status).toBe(404);
  });

  it('moving it later keeps the link alive past where it would have ended, never past the ceiling', async () => {
    await moveTime(minuteFromNow(DAY)); // start from tomorrow whatever the seed's workday calendar says (a Friday's seed is Monday)
    const token = await issue();
    const at = (offset: number) => { setInterviewsClockOffset(offset, true); return exchange(token); };
    expect((await at(3 * DAY)).status).toBe(404);
    resetInterviewsClock();
    await moveTime(minuteFromNow(5 * DAY));
    expect((await at(3 * DAY)).status).toBe(200);
    resetInterviewsClock();
    await moveTime(minuteFromNow(60 * DAY));
    expect((await at(29 * DAY)).status).toBe(200);
    expect((await at(31 * DAY)).status).toBe(404); // the thirty-day ceiling from issue
  });
  // A guest already in cannot outlive a moved expiry by its cookie either: the cookie's own twelve hours end sooner than any
  // future time's day-after (O-048), so the move is seen through the link, as above.
});

describe('the flag turned off and on on one running app (O-050)', () => {
  it('read on every request: off, every guest route and the recruiter\'s are not-found with the cookie kept; on again, the same cookie and link work', async () => {
    const token = await issue();
    const cookie = guestCookie(await exchange(token));
    const guestRoutes = () => Promise.all([
      readAsGuest(cookie),
      request(app).get('/api/interview-invite/consents').set('Cookie', cookie),
      request(app).post('/api/interview-invite/knock').set('Cookie', cookie).send(),
      request(app).get('/api/interview-invite/admission').set('Cookie', cookie),
      request(app).get('/api/interview-invite/room').set('Cookie', cookie),
      request(app).get('/api/interview-invite/realtime-token').set('Cookie', cookie),
    ]);
    process.env['INTERVIEWS_ENABLED'] = 'false';
    const off = await guestRoutes();
    expect(off.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
    expect(off.map(guestSetCookie).filter(Boolean)).toEqual([]); // the gate answers before the guard: nothing dropped
    expect((await exchange(token)).status).toBe(404);
    expect((await GRETA.get(`/interviews/${IV}/invite`)).status).toBe(404);
    process.env['INTERVIEWS_ENABLED'] = 'true';
    expect((await readAsGuest(cookie)).status).toBe(200);
    expect((await GRETA.get(`/interviews/${IV}/invite`)).status).toBe(200);
    expect((await exchange(token)).status).toBe(200);
  });
});

describe('a link with no origin when the portal origin is not set (O-052)', () => {
  const mint = (headers: Record<string, string>) => {
    let r = request(app).post(`/api/interviews/interviews/${IV}/invite`).set('x-user', 'u-greta');
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send({});
  };
  it('is the bare path: never an origin made up from Host, a forwarded host or a malformed Origin', async () => {
    expect(config.cognito.portalOrigin).toBe('');
    for (const headers of <Array<Record<string, string>>>[{}, { host: 'attacker.example' }, { 'x-forwarded-host': 'attacker.example' }, { origin: 'null' },
      { origin: 'https://attacker.example/path' }, { origin: 'javascript:alert(1)' }, { origin: 'https://a b.example' }]) {
      const res = await mint(headers);
      expect([JSON.stringify(headers), res.status, res.body.link]).toEqual([JSON.stringify(headers), 201, res.body.linkPath]);
      expect(res.body.link).toMatch(/^\/join#/);
    }
  });
  it('a well-formed Origin is used as it came', async () => {
    const res = await mint({ origin: 'https://portal.example' });
    expect(res.body.link).toBe(`https://portal.example${res.body.linkPath}`);
  });
});

describe('the realtime token asked after the end (O-072, the server half)', () => {
  it('is not-found and keeps the cookie, so a reload still reads the ended room (I2.4e); without the cookie nothing answers', async () => {
    const cookie = guestCookie(await exchange(await issue()));
    const roomWrite = async (what: 'start' | 'end') => {
      const revision = (await as('u-hugo').get(`/interviews/${IV}/room`)).body.room.revision;
      return request(app).post(`/api/interviews/interviews/${IV}/${what}`).set('x-user', 'u-hugo').send({ revision });
    };
    await request(app).post('/api/interview-invite/knock').set('Cookie', cookie).send();
    expect((await request(app).post(`/api/interviews/interviews/${IV}/admit`).set('x-user', 'u-hugo').send({ admit: true })).status).toBe(200);
    expect((await request(app).get('/api/interview-invite/realtime-token').set('Cookie', cookie)).status).toBe(200);
    expect((await roomWrite('start')).status).toBe(200);
    expect((await roomWrite('end')).status).toBe(200);
    const after = await request(app).get('/api/interview-invite/realtime-token').set('Cookie', cookie);
    expect([after.status, after.body]).toEqual([404, { error: 'This link no longer works.' }]);
    expect(guestSetCookie(after) ?? '').not.toMatch(/Expires=Thu, 01 Jan 1970/);
    // The browser keeps sending it: the room answers `ended` (the candidate's reload shows the ended page); with no cookie, nothing does.
    expect((await request(app).get('/api/interview-invite/room').set('Cookie', cookie)).body.room?.state).toBe('ended');
    expect((await request(app).get('/api/interview-invite/room')).status).toBe(404);
  });
});
