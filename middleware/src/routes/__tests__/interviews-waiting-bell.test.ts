// The waiting candidate, told to the seats (gap audit 2026-11-20 §4; lib/interviews/waiting-room.ts), mounted as index.ts
// mounts the tenant and the guest's door, with the actions decided from the REAL seeds/roles/*/*.cedar files.
//
//   the bell        the first knock of a waiting spell rings exactly the round's seats (lead and panel), once; a
//                   refresh's knock rings nothing; a new spell rings again; admit, turn away, end and cancel resolve it
//   panel admit     a seated panel member in the call while the lead is not lets the candidate in; refused (403) while
//                   the lead is in the call, while they are not in it, and for turning away; not seated or the round
//                   not open: not found (404); another tenant's role: the tenant's refusal at the mount
//   told            the guest's admission read carries one boolean beside the admission, and nothing else
//
// Who is in the call is the call store's (lib/call-chat.ts usersInLobbyCall); here a test reader stands in for it.

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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn(), getUser: jest.fn() }));

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-waiting-bell-test-key';

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { GUEST_COOKIE_NAME, sessionMiddleware, type Session } from '../../lib/session.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { interviewInviteRouter, resetInviteThrottle } from '../interview-invite.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { admitAuthority, resetWaitingRoom, setRoomPresenceReader } from '../../lib/interviews/waiting-room.js';

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
app.use((req, _res, next) => {
  const me = USERS.find((x) => x.id === String(req.headers['x-user'] ?? ''));
  if (me) {
    const tenant = Object.keys(me.grants)[0]!;
    req.session = { sub: me.id, name: me.displayName, tenant, role: me.grants[tenant]![0], grants: me.grants, iat: 0, epoch: 0 } as Session;
    req.sessionInvalid = false;
    req.sessionSource = 'cookie';
  }
  next();
});
app.use('/api/interview-invite', interviewInviteRouter);
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

// The live round: Hugo leads, Wen is on the panel.
const LIVE = 'iv-s4e8u2zk';
// A ready round Hugo leads alone.
const SOLO = 'iv-k1p5w8ra';

const api = (user: string) => ({
  get: (p: string) => request(app).get(`/api/interviews${p}`).set('x-user', user),
  post: (p: string, body: unknown = {}) => request(app).post(`/api/interviews${p}`).set('x-user', user).send(body as object),
});
const GRETA = api('u-greta');
const HUGO = api('u-hugo');
const WEN = api('u-wen');

function guestCookie(res: { headers: Record<string, unknown> }): string {
  const set = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []);
  const line = set.find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
async function issue(id: string): Promise<string> {
  const res = await GRETA.post(`/interviews/${id}/invite`);
  expect(res.status).toBe(201);
  return String(res.body.linkPath).split('#')[1]!;
}
const exchange = async (token: string) => guestCookie(await request(app).post('/api/interview-invite/exchange').send({ token }));
const knock = (cookie: string) => request(app).post('/api/interview-invite/knock').set('Cookie', cookie).send();
const mine = (cookie: string) => request(app).get('/api/interview-invite/admission').set('Cookie', cookie);

// ── a notification service with resolve, in memory ──────────────────────────
type Item = NotificationInputLike & { id: string };
const inboxes = new Map<string, Item[]>();
const resolved: Array<[string, string[]]> = [];
const sink = {
  async notifyUser(userId: string, input: NotificationInputLike) { inboxes.set(userId, [...(inboxes.get(userId) ?? []), input as Item]); },
  async listForUser(userId: string) { return (inboxes.get(userId) ?? []).map((i) => ({ id: i.id, payload: i.payload })); },
  async resolveMany(userId: string, keys: readonly string[]) {
    resolved.push([userId, [...keys]]);
    inboxes.set(userId, (inboxes.get(userId) ?? []).filter((i) => !keys.includes(i.id)));
  },
};
const waitingBells = (userId: string) => (inboxes.get(userId) ?? []).filter((i) => i.payload?.['kind'] === 'interview-waiting');
const rungTo = () => [...inboxes.entries()].filter(([, items]) => items.some((i) => i.payload?.['kind'] === 'interview-waiting')).map(([k]) => k).sort();
/** The bell is sent off the knock's path: wait (bounded) until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let k = 0; k < 50 && !done(); k++) await new Promise((r) => setTimeout(r, 10));
}
const settle = () => new Promise((r) => setTimeout(r, 60));

let inCall: string[] = [];

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
  resetWaitingRoom();
  inboxes.clear();
  resolved.length = 0;
  inCall = [];
  setRoomPresenceReader(async (lobby) => (lobby.endsWith(LIVE) || lobby.endsWith(SOLO) ? inCall : []));
  setNotificationSink(sink);
});
afterAll(() => { setNotificationSink(null); setRoomPresenceReader(null); });

describe('the bell on the first knock', () => {
  it('rings exactly the round\'s seats, once; a refresh\'s knock rings nothing', async () => {
    const cookie = await exchange(await issue(LIVE));
    expect((await knock(cookie)).status).toBe(200);
    await until(() => rungTo().length === 2);
    expect(rungTo()).toEqual(['u-hugo', 'u-wen']);
    const bell = waitingBells('u-wen')[0]!;
    expect(bell.action).toEqual({ label: 'Open the room', href: `/interviews/rounds/${LIVE}/room` });
    expect(bell.payload).toMatchObject({ tenant: 'interviews', kind: 'interview-waiting', audience: 'interviewer' });
    // Nothing of the candidate's in the shared store.
    expect(JSON.stringify(bell)).not.toMatch(/Kwame|app-|cand-/i);
    expect(inboxes.get('u-greta')).toBeUndefined();
    // A refresh: the same guest session knocks again while waiting.
    await knock(cookie);
    await settle();
    expect(waitingBells('u-hugo')).toHaveLength(1);
    expect(waitingBells('u-wen')).toHaveLength(1);
  });

  it('a new spell (the link opened again) rings again, and the earlier spell\'s bell leaves first', async () => {
    const token = await issue(LIVE);
    await knock(await exchange(token));
    await until(() => rungTo().length === 2);
    const first = waitingBells('u-hugo')[0]!.id;
    await new Promise((r) => setTimeout(r, 5)); // a later knock instant
    await knock(await exchange(token));
    await until(() => waitingBells('u-hugo')[0]?.id !== first);
    expect(waitingBells('u-hugo')).toHaveLength(1);
    expect(waitingBells('u-hugo')[0]!.id).not.toBe(first);
  });

  it('letting the candidate in resolves the bells in every seat\'s inbox', async () => {
    const cookie = await exchange(await issue(LIVE));
    await knock(cookie);
    await until(() => rungTo().length === 2);
    expect((await HUGO.post(`/interviews/${LIVE}/admit`, { admit: true })).status).toBe(200);
    await until(() => rungTo().length === 0);
    expect(rungTo()).toEqual([]);
    expect(resolved.map(([who]) => who).sort()).toEqual(['u-hugo', 'u-wen']);
  });

  it('turning away resolves them, and a knock after that rings again', async () => {
    const cookie = await exchange(await issue(LIVE));
    await knock(cookie);
    await until(() => rungTo().length === 2);
    expect((await HUGO.post(`/interviews/${LIVE}/admit`, { admit: false })).status).toBe(200);
    await until(() => rungTo().length === 0);
    expect(rungTo()).toEqual([]);
    await knock(cookie);
    await until(() => rungTo().length === 2);
    expect(rungTo()).toEqual(['u-hugo', 'u-wen']);
  });

  it('ending the round resolves them', async () => {
    await knock(await exchange(await issue(LIVE)));
    await until(() => rungTo().length === 2);
    const revision = (await HUGO.get(`/interviews/${LIVE}/room`)).body.room.revision;
    expect((await HUGO.post(`/interviews/${LIVE}/end`, { revision })).status).toBe(200);
    await until(() => rungTo().length === 0);
    expect(rungTo()).toEqual([]);
  });

  it('cancelling the round resolves them', async () => {
    await knock(await exchange(await issue(SOLO)));
    await until(() => rungTo().length === 1);
    expect(rungTo()).toEqual(['u-hugo']);
    const revision = (await GRETA.get(`/interviews/${SOLO}`)).body.interview?.revision
      ?? (await HUGO.get(`/interviews/${SOLO}/room`)).body.room.revision;
    expect((await GRETA.post(`/interviews/${SOLO}/cancel`, { revision, reason: 'rescheduling' })).status).toBe(200);
    await until(() => rungTo().length === 0);
    expect(rungTo()).toEqual([]);
  });

  it('a service without resolve leaves the bell where it is', async () => {
    setNotificationSink({ notifyUser: sink.notifyUser, listForUser: sink.listForUser });
    const cookie = await exchange(await issue(LIVE));
    await knock(cookie);
    await until(() => rungTo().length === 2);
    expect((await HUGO.post(`/interviews/${LIVE}/admit`, { admit: true })).status).toBe(200);
    await settle();
    expect(rungTo()).toEqual(['u-hugo', 'u-wen']);
    expect(resolved).toEqual([]);
  });
});

describe('the candidate\'s told', () => {
  it('false until a bell went out, then true; the read carries the admission and that one boolean, nothing else', async () => {
    setNotificationSink(null); // no bell can go out
    const cookie = await exchange(await issue(LIVE));
    const before = await mine(cookie);
    expect(before.body).toEqual({ admission: { state: 'not-knocked', knockedAt: null, decidedAt: null }, told: false });
    const knocked = await knock(cookie);
    expect(Object.keys(knocked.body).sort()).toEqual(['admission', 'told']);
    await settle();
    const waiting = await mine(cookie);
    expect(Object.keys(waiting.body).sort()).toEqual(['admission', 'told']);
    expect(Object.keys(waiting.body.admission).sort()).toEqual(['decidedAt', 'knockedAt', 'state']);
    expect(waiting.body.told).toBe(false);
    // A bell for the same spell (the service back, and a new spell rung).
    setNotificationSink(sink);
    await HUGO.post(`/interviews/${LIVE}/admit`, { admit: false });
    await knock(cookie);
    await until(() => rungTo().length === 2);
    expect((await mine(cookie)).body.told).toBe(true);
    expect(JSON.stringify((await mine(cookie)).body)).not.toMatch(/hugo|wen|Marchetti|Zhao/i);
  });

  it('true with no bell when a seat is in the call', async () => {
    setNotificationSink(null);
    const cookie = await exchange(await issue(LIVE));
    await knock(cookie);
    expect((await mine(cookie)).body.told).toBe(false);
    inCall = ['u-wen'];
    expect((await mine(cookie)).body.told).toBe(true);
  });
});

describe('a panel member\'s admit', () => {
  async function waitingGuest(): Promise<string> {
    const cookie = await exchange(await issue(LIVE));
    await knock(cookie);
    return cookie;
  }

  it('in the call while the lead is not: lets the candidate in, and the room and the waiting read say mayAdmit', async () => {
    const cookie = await waitingGuest();
    inCall = ['u-wen'];
    expect((await WEN.get(`/interviews/${LIVE}/room`)).body.room.mayAdmit).toBe(true);
    expect((await WEN.get(`/interviews/${LIVE}/waiting`)).body).toMatchObject({ mayAdmit: true, admission: { state: 'waiting' } });
    const admitted = await WEN.post(`/interviews/${LIVE}/admit`, { admit: true });
    expect(admitted.status).toBe(200);
    expect(admitted.body.admission.state).toBe('admitted');
    expect((await mine(cookie)).body.admission.state).toBe('admitted');
  });

  it('while the lead is in the call: 403 with a reason, and mayAdmit is false', async () => {
    const cookie = await waitingGuest();
    inCall = ['u-wen', 'u-hugo'];
    expect((await WEN.get(`/interviews/${LIVE}/room`)).body.room.mayAdmit).toBe(false);
    const refused = await WEN.post(`/interviews/${LIVE}/admit`, { admit: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/lead is in the call/);
    expect((await mine(cookie)).body.admission.state).toBe('waiting');
  });

  it('not in the call themselves: 403, and mayAdmit is false', async () => {
    await waitingGuest();
    inCall = [];
    expect((await WEN.get(`/interviews/${LIVE}/waiting`)).body.mayAdmit).toBe(false);
    const refused = await WEN.post(`/interviews/${LIVE}/admit`, { admit: true });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Join the call first/);
  });

  it('turning the candidate away stays the lead\'s: 403 for the panel, even alone in the call', async () => {
    const cookie = await waitingGuest();
    inCall = ['u-wen'];
    const refused = await WEN.post(`/interviews/${LIVE}/admit`, { admit: false });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/Only the lead/);
    expect((await mine(cookie)).body.admission.state).toBe('waiting');
  });

  it('the lead\'s admit is unchanged, in the call or not, and the lead\'s mayAdmit is true', async () => {
    await waitingGuest();
    inCall = ['u-wen'];
    expect((await HUGO.get(`/interviews/${LIVE}/room`)).body.room.mayAdmit).toBe(true);
    expect((await HUGO.post(`/interviews/${LIVE}/admit`, { admit: true })).status).toBe(200);
  });

  it('not seated on the round: not found; another tenant\'s role: the mount\'s refusal; nobody without ConductInterview admits', async () => {
    await exchange(await issue(SOLO)).then(knock);
    inCall = ['u-wen'];
    expect((await WEN.post(`/interviews/${SOLO}/admit`, { admit: true })).status).toBe(404);
    expect((await WEN.get(`/interviews/${SOLO}/waiting`)).status).toBe(404);
    expect((await api('u-amara').post(`/interviews/${SOLO}/admit`, { admit: true })).status).toBe(404);
    expect((await GRETA.post(`/interviews/${SOLO}/admit`, { admit: true })).status).toBe(404);
    expect((await api('u-priya').post(`/interviews/${LIVE}/admit`, { admit: true })).status).toBe(403);
  });

  it('a round not open for its call (ended): not found, for the panel as for the lead', async () => {
    await waitingGuest();
    const revision = (await HUGO.get(`/interviews/${LIVE}/room`)).body.room.revision;
    expect((await HUGO.post(`/interviews/${LIVE}/end`, { revision })).status).toBe(200);
    inCall = ['u-wen'];
    expect((await WEN.post(`/interviews/${LIVE}/admit`, { admit: true })).status).toBe(404);
    expect((await HUGO.post(`/interviews/${LIVE}/admit`, { admit: true })).status).toBe(404);
  });
});

describe('admitAuthority, the rule', () => {
  it('the lead always; the panel only to let in, only in the call, only while the lead is not', () => {
    expect(admitAuthority('lead', true, { lead: false, self: false })).toBe(true);
    expect(admitAuthority('lead', false, { lead: false, self: false })).toBe(true);
    expect(admitAuthority('panel', true, { lead: false, self: true })).toBe(true);
    expect(admitAuthority('panel', true, { lead: true, self: true })).toBe('lead-here');
    expect(admitAuthority('panel', true, { lead: false, self: false })).toBe('not-in-call');
    expect(admitAuthority('panel', false, { lead: false, self: true })).toBe('lead-only');
  });
});
