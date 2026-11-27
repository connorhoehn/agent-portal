// The candidate's "I can't make this time" (gap audit 2026-11-20 §6; lib/interviews/cant-make.ts), mounted as index.ts
// mounts the tenant and the guest's door, with the actions decided from the REAL seeds/roles/*/*.cedar files.

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
import { resetWaitingRoom, setRoomPresenceReader } from '../../lib/interviews/waiting-room.js';
import { CANT_MAKE_NOTE_MAX, resetCantMake } from '../../lib/interviews/cant-make.js';
import { cantMakeEraser } from '../../lib/interviews/retention/erasers.js';
import { resetInterviewsClock, setInterviewsClockOffset } from '../../lib/interviews/clock.js';
import { interviewsFixture } from '../../mock/interviews.js';
import { interviewCandidatesFixture } from '../../mock/interviews.js';

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

let inCall: string[] = [];

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
  resetWaitingRoom();
  resetCantMake();
  resetInterviewsClock();
  inboxes.clear();
  resolved.length = 0;
  inCall = [];
  setRoomPresenceReader(async (lobby) => (lobby.endsWith(LIVE) || lobby.endsWith(SOLO) ? inCall : []));
  setNotificationSink(sink);
});
afterAll(() => { setNotificationSink(null); setRoomPresenceReader(null); resetInterviewsClock(); });

const cantMake = (cookie: string, body: unknown = {}) => request(app).post('/api/interview-invite/cant-make').set('Cookie', cookie).send(body as object);
const bells = (userId: string) => (inboxes.get(userId) ?? []).filter((i) => i.payload?.['kind'] === 'interview-cant-make');
const row = (id: string) => interviewsFixture.rows().find((i) => i.id === id)!;
const TOLD = 'The recruiter has been told you cannot make this time. They will be in touch about what happens next.';

describe("the candidate's \"I can't make this time\"", () => {
  it('writes one record (when and the note), rings the recruiters only, names no candidate, and changes nothing else', async () => {
    const before = structuredClone(row(SOLO));
    const cookie = await exchange(await issue(SOLO));
    const res = await cantMake(cookie, { note: '  Travelling that week.\n Could we do Friday?  ' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cantMake: { sentAt: expect.any(String) }, message: TOLD });
    const after = row(SOLO);
    expect(after.cantMake).toEqual({ at: res.body.cantMake.sentAt, note: 'Travelling that week.\n Could we do Friday?' });
    expect({ ...after, cantMake: undefined, revision: 0 }).toEqual({ ...before, cantMake: undefined, revision: 0 });
    expect([...inboxes.keys()].filter((k) => bells(k).length)).toEqual(['u-greta']);
    const bell = bells('u-greta')[0]!;
    const names = interviewCandidatesFixture.rows().map((c) => c.name);
    const words = `${bell.title} ${bell.body ?? ''}`;
    for (const n of names) expect(words).not.toContain(n);
    expect(words).not.toContain('Friday');
    expect(bell.title).toMatch(/^The candidate can't make Coding for /);
    expect((bell as { action?: { href: string } }).action?.href).toBe(`/interviews/rounds/${SOLO}`);
    // The guest reads back that they told, and when: never the note.
    const mine = await request(app).get('/api/interview-invite/interview').set('Cookie', cookie);
    expect(mine.body.interview.cantMake).toEqual({ sentAt: res.body.cantMake.sentAt });
    expect(JSON.stringify(mine.body)).not.toContain('Friday');
  });

  it('a repeat within 12 hours answers the same, writes nothing and rings nothing, even after the recruiter clears it; after 12 hours it rings again', async () => {
    const cookie = await exchange(await issue(SOLO));
    const first = await cantMake(cookie, { note: 'First' });
    const revision = row(SOLO).revision;
    const again = await cantMake(cookie, { note: 'Second' });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ cantMake: { sentAt: first.body.cantMake.sentAt }, message: TOLD });
    expect(row(SOLO).revision).toBe(revision);
    expect(row(SOLO).cantMake?.note).toBe('First');
    expect(await GRETA.post(`/interviews/${SOLO}/cant-make/clear`, { revision }).then((r) => r.status)).toBe(200);
    expect(row(SOLO).cantMake).toBeUndefined();
    expect((await cantMake(cookie, { note: 'Third' })).body.message).toBe(TOLD);
    expect(row(SOLO).cantMake).toBeUndefined();
    expect(bells('u-greta')).toHaveLength(1);
    setInterviewsClockOffset(13 * 60 * 60 * 1000, true);
    const later = await cantMake(await exchange(await issue(SOLO)), { note: 'Later' });
    expect(later.status).toBe(200);
    expect(row(SOLO).cantMake?.note).toBe('Later');
    expect(bells('u-greta')).toHaveLength(2);
  });

  it('refuses a round that has started (409), a note over 280 characters (400), a note that is not text (400), and a dead link (404)', async () => {
    const live = await cantMake(await exchange(await issue(LIVE)));
    expect(live.status).toBe(409);
    expect(row(LIVE).cantMake).toBeUndefined();
    const cookie = await exchange(await issue(SOLO));
    expect((await cantMake(cookie, { note: 'x'.repeat(CANT_MAKE_NOTE_MAX + 1) })).status).toBe(400);
    expect((await cantMake(cookie, { note: 42 })).status).toBe(400);
    expect((await cantMake(cookie, { note: 'x'.repeat(CANT_MAKE_NOTE_MAX) })).status).toBe(200);
    resetCantMake();
    await GRETA.post(`/interviews/${SOLO}/cant-make/clear`, { revision: row(SOLO).revision });
    expect((await request(app).delete(`/api/interviews/interviews/${SOLO}/invite`).set('x-user', 'u-greta')).status).toBe(200);
    expect((await cantMake(cookie)).status).toBe(404);
    expect((await request(app).post('/api/interview-invite/cant-make').send({})).status).toBe(404);
    expect(bells('u-greta')).toHaveLength(1);
  });

  it("a guest reaches only their own round: an interview id in the body is ignored", async () => {
    const other = 'iv-n5z9f2cq';
    const cookie = await exchange(await issue(other));
    expect((await cantMake(cookie, { interviewId: SOLO, note: 'Mine' })).status).toBe(200);
    expect(row(SOLO).cantMake).toBeUndefined();
    expect(row(other).cantMake?.note).toBe('Mine');
  });

  it('the note is stored as the words typed, markup and all, and comes back to the recruiter as text in the row', async () => {
    const cookie = await exchange(await issue(SOLO));
    await cantMake(cookie, { note: '<b>busy</b> & <script>x</script>' });
    const rowRead = (await GRETA.get('/interviews')).body.items.find((r: { id: string }) => r.id === SOLO);
    expect(rowRead.cantMake).toEqual({ at: expect.any(String), note: '<b>busy</b> & <script>x</script>' });
    const hugo = (await HUGO.get('/interviews')).body.items.find((r: { id: string }) => r.id === SOLO);
    expect(hugo.cantMake).toBeNull();
  });

  it('clearing is the recruiter\'s (AssignInterviews): the lead is not found; a stale revision is 409; rescheduling and cancelling clear it too', async () => {
    const cookie = await exchange(await issue(SOLO));
    await cantMake(cookie);
    const revision = row(SOLO).revision;
    expect((await HUGO.post(`/interviews/${SOLO}/cant-make/clear`, { revision })).status).toBe(404);
    expect((await GRETA.post(`/interviews/${SOLO}/cant-make/clear`, { revision: revision - 1 })).status).toBe(409);
    expect(row(SOLO).cantMake).toBeDefined();
    const at = new Date(Date.parse(row(SOLO).scheduledAt!) + 86_400_000).toISOString();
    const moved = await request(app).put(`/api/interviews/interviews/${SOLO}/time`).set('x-user', 'u-greta').send({ revision, scheduledAt: at });
    expect(moved.status).toBe(200);
    expect(row(SOLO).cantMake).toBeUndefined();
    // A new time is a new question: the candidate may answer it at once, and the recruiter is told again.
    expect((await cantMake(cookie, { note: 'Not that one either' })).status).toBe(200);
    expect(bells('u-greta')).toHaveLength(2);
    const cancelled = await GRETA.post(`/interviews/${SOLO}/cancel`, { revision: row(SOLO).revision, reason: 'rescheduling' });
    expect(cancelled.status).toBe(200);
    expect(row(SOLO).cantMake).toBeUndefined();
  });

  it('erasure removes the notice with the candidate\'s other words', async () => {
    await cantMake(await exchange(await issue(SOLO)), { note: 'Gone soon' });
    const eraser = cantMakeEraser();
    expect(eraser).toMatchObject({ kind: 'cant-make', class: 'media' });
    expect(await eraser.erase([SOLO])).toBe(1);
    expect(row(SOLO).cantMake).toBeUndefined();
    expect(await eraser.erase([SOLO])).toBe(0);
  });
});
