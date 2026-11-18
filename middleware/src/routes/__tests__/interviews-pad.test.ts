// The pad log's routes (routes/interviews/pad.ts and routes/interview-invite-pad.ts; docs/interviews-tenant-plan.md
// decision 12, row I4.3; decisions 3, 4; contract U3), mounted as index.ts mounts them, with ConductInterview decided
// from the REAL seeds/roles/*/*.cedar files, the real guest cookie (exchange) and the memory pad log.
//
//   POST …/interviews/:id/pad/events   the lead and the panel of a live technical round; everyone else 404
//   GET  …/interviews/:id/pad/log      the record's readers (seats, recruiter, the opening's hiring manager), live or ended
//   POST /api/interview-invite/pad/events
//                                      the admitted guest of its own live technical round; no read for the guest
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
process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-pad-test-key';

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
import { interviewInvitesFixture } from '../../mock/interviews-invites.js';
import { interviewsFixture } from '../../mock/interviews.js';
import { interviewPadLogFixture } from '../../mock/interviews-pad-log.js';
import { MAX_EVENTS_PER_INTERVIEW, MAX_SNAPSHOTS_PER_INTERVIEW, setPadLogStore, type PadEventRecord } from '../../lib/interviews/pad/log/index.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-third', 'Ola Brandt', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-bo', 'Bo Lindgren', { interviews: ['hiring-manager'] }),
  u('u-operator', 'Platform Operator', { interviews: ['admin'] }),
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
    req.sessionSource = 'cookie'; // a signed-in staff session, as a verified cookie makes it
  }
  next();
});
app.use('/api/interview-invite', interviewInviteRouter);
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

// Hugo leads Mateo's system design round (technical); Wen joins its panel here. Wen leads Aiko's coding round; Wen
// leads Nadia's leadership round (behavioural) with Hugo on its panel. Amara is the hiring manager of Mateo's opening.
const IV = 'iv-k1p5w8ra';
const OTHER = 'iv-c3k8w2ma';
const BEHAVIOURAL = 'iv-n5z9f2cq';
const ENDED = 'iv-j6x2d9sb';
const AT = '2026-11-17T10:00:00.000Z';
const EDIT = { kind: 'edit', clientAt: AT, from: 10, inserted: 4, deleted: 0, length: 120 };
const PASTE = { kind: 'paste', clientAt: AT, from: 120, inserted: 240, lines: 9, via: 'paste', length: 360 };

const staff = (id: string) => ({
  post: (p: string, body: unknown) => request(app).post(`/api/interviews${p}`).set('x-user', id).send(body as object),
  get: (p: string) => request(app).get(`/api/interviews${p}`).set('x-user', id),
});
const GRETA = staff('u-greta');
const HUGO = staff('u-hugo');
const WEN = staff('u-wen');
const THIRD = staff('u-third');
const AMARA = staff('u-amara');
const BO = staff('u-bo');
const OPERATOR = staff('u-operator');
const PRIYA = staff('u-priya');

const setState = (id: string, state: string) => { (interviewsFixture.rows().find((i) => i.id === id)! as { state: string }).state = state; };
const log = (id = IV): PadEventRecord[] => interviewPadLogFixture.rows().filter((r) => r.interviewId === id);

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const line = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
/** A guest of `id`: the link issued by the recruiter, opened, and (unless told otherwise) admitted by the lead. */
async function guestOf(id: string, admitted = true): Promise<string> {
  const made = await GRETA.post(`/interviews/${id}/invite`, {});
  expect(made.status).toBe(201);
  const cookie = cookieOf(await request(app).post('/api/interview-invite/exchange').send({ token: String(made.body.linkPath).split('#')[1] }));
  if (admitted) {
    const row = interviewInvitesFixture.rows().find((r) => r.interviewId === id && r.revokedAt === null)!;
    Object.assign(row, { admissionState: 'admitted', knockedAt: AT, admissionDecidedAt: AT });
  }
  return cookie;
}
const guestPost = (cookie: string, body: unknown) => request(app).post('/api/interview-invite/pad/events').set('Cookie', cookie).send(body as object);

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
  setPadLogStore(null);
  interviewsFixture.rows().find((i) => i.id === IV)!.panelIds.push('u-wen');
});

describe('the panel\'s post', () => {
  it('the lead and a panel member post while the round is live; the server says who and when', async () => {
    setState(IV, 'live');
    const lead = await HUGO.post(`/interviews/${IV}/pad/events`, { events: [EDIT, { kind: 'language', clientAt: AT, language: 'go' }] });
    expect(lead.status).toBe(200);
    expect(lead.body).toEqual({ accepted: 2 });
    expect(lead.headers['cache-control']).toBe('no-store');
    expect((await WEN.post(`/interviews/${IV}/pad/events`, { events: [{ ...EDIT, who: 'guest:someone', side: 'candidate', at: '2020-01-01T00:00:00.000Z' }] })).body).toEqual({ accepted: 1 });
    expect(log().map((r) => [r.seq, r.whoId, r.side, r.kind])).toEqual([[1, 'u-hugo', 'panel', 'edit'], [2, 'u-hugo', 'panel', 'language'], [3, 'u-wen', 'panel', 'edit']]);
    expect(log()[2]!.at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('is the same not-found for a round not live, a behavioural round, a seat elsewhere, the recruiter, the hiring manager, the admin and a guest', async () => {
    const body = { events: [EDIT] };
    const notFound = async (res: Promise<{ status: number; body: unknown }>) => { const r = await res; expect(r.status).toBe(404); return r.body; };
    const first = await notFound(HUGO.post(`/interviews/${IV}/pad/events`, body)); // ready, not live
    setState(IV, 'live');
    setState(BEHAVIOURAL, 'live');
    setState(OTHER, 'live');
    expect(await notFound(WEN.post(`/interviews/${BEHAVIOURAL}/pad/events`, body))).toEqual(first);
    expect(await notFound(HUGO.post(`/interviews/${OTHER}/pad/events`, body))).toEqual(first);
    expect(await notFound(THIRD.post(`/interviews/${IV}/pad/events`, body))).toEqual(first);
    expect(await notFound(GRETA.post(`/interviews/${IV}/pad/events`, body))).toEqual(first);
    expect(await notFound(AMARA.post(`/interviews/${IV}/pad/events`, body))).toEqual(first);
    expect(await notFound(OPERATOR.post(`/interviews/${IV}/pad/events`, body))).toEqual(first);
    expect(await notFound(HUGO.post('/interviews/iv-nothing/pad/events', body))).toEqual(first);
    setState(IV, 'ended');
    expect(await notFound(HUGO.post(`/interviews/${IV}/pad/events`, body))).toEqual(first);
    // The guest's cookie on the staff route is no session there.
    setState(IV, 'live');
    const guest = await guestOf(IV);
    expect((await request(app).post(`/api/interviews/interviews/${IV}/pad/events`).set('Cookie', guest).send(body)).status).toBeGreaterThanOrEqual(400);
    expect((await PRIYA.post(`/interviews/${IV}/pad/events`, body)).status).toBe(403);
    expect(log()).toEqual([]);
  });

  it('refuses a malformed post whole (400, nothing stored), and drops unknown fields', async () => {
    setState(IV, 'live');
    for (const body of [{}, { events: [] }, { events: Array(51).fill(EDIT) }, { events: [EDIT, { ...EDIT, text: 'secret = 1' }] }, { events: [{ ...EDIT, from: -1 }] }]) {
      const res = await HUGO.post(`/interviews/${IV}/pad/events`, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('The pad log could not read these events. Nothing was stored.');
    }
    expect(log()).toEqual([]);
    expect((await HUGO.post(`/interviews/${IV}/pad/events`, { events: [{ ...EDIT, characters: 'typed text', extra: { deep: 1 } }] })).body).toEqual({ accepted: 1 });
    expect(JSON.stringify(log())).not.toContain('typed text');
    expect(Object.keys(log()[0]!)).not.toContain('extra');
  });

  it('past the caps the post is still accepted, the extra dropped and counted as not accepted', async () => {
    setState(IV, 'live');
    const base = { interviewId: IV, at: AT, clientAt: AT, whoId: 'u-hugo', side: 'panel' as const, from: 0, inserted: 1, deleted: 0, length: 1, lines: null, via: null, language: null, questionId: null };
    for (let i = 1; i <= MAX_SNAPSHOTS_PER_INTERVIEW; i++) interviewPadLogFixture.rows().push({ ...base, seq: i, kind: 'snapshot', text: 'x' });
    const snap = { kind: 'snapshot', clientAt: AT, text: 'y = 2\n' };
    expect((await HUGO.post(`/interviews/${IV}/pad/events`, { events: [snap, EDIT] })).body).toEqual({ accepted: 1 });
    for (let i = log().length + 1; i <= MAX_EVENTS_PER_INTERVIEW; i++) interviewPadLogFixture.rows().push({ ...base, seq: i, kind: 'edit', text: null });
    const full = await HUGO.post(`/interviews/${IV}/pad/events`, { events: [EDIT] });
    expect(full.status).toBe(200);
    expect(full.body).toEqual({ accepted: 0 });
    expect(log()).toHaveLength(MAX_EVENTS_PER_INTERVIEW);
  });
});

describe('the candidate\'s post', () => {
  it('a paste by the candidate shows as an event on the panel\'s read (the row\'s judge line)', async () => {
    const guest = await guestOf(IV);
    setState(IV, 'live');
    const posted = await guestPost(guest, { events: [EDIT, PASTE] });
    expect(posted.status).toBe(200);
    expect(posted.body).toEqual({ accepted: 2 });
    expect(posted.headers['cache-control']).toBe('no-store');
    await HUGO.post(`/interviews/${IV}/pad/events`, { events: [{ kind: 'snapshot', clientAt: AT, text: 'def f():\n    return 1\n', language: 'python' }] });
    const read = await HUGO.get(`/interviews/${IV}/pad/log`);
    expect(read.status).toBe(200);
    const inviteId = interviewInvitesFixture.rows().find((r) => r.interviewId === IV && r.revokedAt === null)!.id;
    expect(read.body.events[1]).toEqual({
      kind: 'paste', clientAt: AT, from: 120, inserted: 240, lines: 9, via: 'paste', length: 360, seq: 2, at: expect.any(String),
      who: { id: `guest:${inviteId}`, name: 'Candidate', side: 'candidate' },
    });
    expect(read.body.events[2]).toMatchObject({ kind: 'snapshot', text: 'def f():\n    return 1\n', who: { id: 'u-hugo', name: 'Hugo Marchetti', side: 'panel' } });
    expect(read.body.events[0]).not.toHaveProperty('text');
    expect(read.body.lastSeq).toBe(3);
    expect(read.body.more).toBe(false);
  });

  it('is the one guest not-found when not admitted, not live, behavioural, or with no cookie', async () => {
    const waiting = await guestOf(IV, false);
    setState(IV, 'live');
    const refused = await guestPost(waiting, { events: [EDIT] });
    expect(refused.status).toBe(404);
    expect(refused.body).toEqual({ error: 'This link no longer works.' });
    const admitted = await guestOf(IV);
    setState(IV, 'ready');
    expect((await guestPost(admitted, { events: [EDIT] })).status).toBe(404);
    setState(IV, 'live');
    const turnedAway = interviewInvitesFixture.rows().find((r) => r.interviewId === IV && r.revokedAt === null)!;
    turnedAway.admissionState = 'turned-away';
    expect((await guestPost(admitted, { events: [EDIT] })).status).toBe(404);
    const behavioural = await guestOf(BEHAVIOURAL);
    setState(BEHAVIOURAL, 'live');
    expect((await guestPost(behavioural, { events: [EDIT] })).status).toBe(404);
    expect((await request(app).post('/api/interview-invite/pad/events').send({ events: [EDIT] })).status).toBe(404);
    expect((await request(app).post('/api/interview-invite/pad/events').set('x-user', 'u-hugo').send({ events: [EDIT] })).status).toBe(404);
    expect(log()).toEqual([]);
    expect(log(BEHAVIOURAL)).toEqual([]);
  });

  it('a guest of another interview writes only to its own, and not at all while that one is not live', async () => {
    setState(IV, 'live');
    const other = await guestOf(OTHER);
    expect((await guestPost(other, { events: [PASTE] })).status).toBe(404);
    setState(OTHER, 'live');
    expect((await guestPost(other, { events: [PASTE] })).body).toEqual({ accepted: 1 });
    expect(log()).toEqual([]);
    expect(log(OTHER).map((r) => r.side)).toEqual(['candidate']);
  });

  it('refuses a malformed post whole', async () => {
    const guest = await guestOf(IV);
    setState(IV, 'live');
    const res = await guestPost(guest, { events: [{ ...PASTE, text: 'pasted words' }] });
    expect(res.status).toBe(400);
    expect(log()).toEqual([]);
  });

  it('the guest has no read of the log', async () => {
    const guest = await guestOf(IV);
    setState(IV, 'live');
    await guestPost(guest, { events: [PASTE] });
    expect((await request(app).get('/api/interview-invite/pad/log').set('Cookie', guest)).status).toBe(404);
    expect((await request(app).get('/api/interview-invite/pad/events').set('Cookie', guest)).status).toBe(404);
    expect((await request(app).get(`/api/interviews/interviews/${IV}/pad/log`).set('Cookie', guest)).status).toBeGreaterThanOrEqual(400);
  });
});

describe('the panel\'s read', () => {
  it('is the record\'s readers, live or ended: seats, the recruiter, the opening\'s hiring manager', async () => {
    const seeded = log(ENDED).length;
    expect(seeded).toBeGreaterThan(0);
    for (const who of [HUGO, GRETA, AMARA]) {
      const res = await who.get(`/interviews/${ENDED}/pad/log`);
      expect(res.status).toBe(200);
      expect(res.body.events).toHaveLength(seeded);
      expect(res.body).not.toHaveProperty('interview');
    }
    const paste = (await HUGO.get(`/interviews/${ENDED}/pad/log`)).body.events.find((e: { kind: string }) => e.kind === 'paste');
    expect(paste.who).toEqual({ id: 'guest:iv-j6x2d9sb', name: 'Candidate', side: 'candidate' });
    setState(IV, 'live');
    for (const who of [HUGO, WEN, GRETA, AMARA]) expect((await who.get(`/interviews/${IV}/pad/log`)).status).toBe(200);
  });

  it('reads after a seq', async () => {
    const res = await HUGO.get(`/interviews/${ENDED}/pad/log?after=7`);
    expect(res.body.events.map((e: { seq: number }) => e.seq)).toEqual([8, 9, 10, 11, 12]);
    expect(res.body.lastSeq).toBe(12);
    const none = await HUGO.get(`/interviews/${ENDED}/pad/log?after=12`);
    expect(none.body).toEqual({ events: [], lastSeq: 12, more: false });
    expect((await HUGO.get(`/interviews/${ENDED}/pad/log?after=nonsense`)).body.events).toHaveLength(12);
  });

  it('is the same not-found for anyone else, a round not started, and a behavioural round', async () => {
    const first = await THIRD.get(`/interviews/${ENDED}/pad/log`);
    expect(first.status).toBe(404);
    expect((await BO.get(`/interviews/${ENDED}/pad/log`)).body).toEqual(first.body);
    expect((await OPERATOR.get(`/interviews/${ENDED}/pad/log`)).body).toEqual(first.body);
    expect((await HUGO.get(`/interviews/${IV}/pad/log`)).body).toEqual(first.body); // ready
    setState(BEHAVIOURAL, 'ended');
    expect((await WEN.get(`/interviews/${BEHAVIOURAL}/pad/log`)).body).toEqual(first.body);
    expect((await WEN.get('/interviews/iv-nothing/pad/log')).status).toBe(404);
    expect((await PRIYA.get(`/interviews/${ENDED}/pad/log`)).status).toBe(403);
  });
});
