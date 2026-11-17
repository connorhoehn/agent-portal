// The candidate's request route under pressure (routes/interview-invite-milo.ts; row I3.8, decision 10; OWED O-223, lane H8).
// Mounted as index.ts mounts the guest routes; the said log is the memory store, and the chat and the call's voice are stood in
// through lib/interviews/speak's deps (no session, no provider). Every model client the interviews code could reach is a spy that
// fails the test if it is called.
//
//   pressed many times          the first is answered; the rest inside 10 s read "Milo just answered…"; logged, posted, said once
//   while one is outstanding    a second press inside 10 s is the same plain sentence and is not logged
//   the transcript declined     the button still answers from held text (pinned: the route reads no consent), logged once
//   after the end               the guest's one not-found; nothing logged
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

const bedrockSend = jest.fn(() => { throw new Error('a model was called'); });
jest.mock('@aws-sdk/client-bedrock-runtime', () => ({
  ...jest.requireActual('@aws-sdk/client-bedrock-runtime'),
  BedrockRuntimeClient: class { send(...a: unknown[]) { return (bedrockSend as (...x: unknown[]) => unknown)(...a); } },
}));

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-invite-milo-test-key';

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { GUEST_COOKIE_NAME, sessionMiddleware, type Session } from '../../lib/session.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { requireTenant } from '../../lib/authz.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { interviewInviteRouter, resetInviteThrottle } from '../interview-invite.js';
import { resetGuestMiloLimit } from '../interview-invite-milo.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { interviewsFixture } from '../../mock/interviews.js';
import { interviewInvitesFixture } from '../../mock/interviews-invites.js';
import { interviewConsentsFixture } from '../../mock/interviews-consents.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import { setConsentStore } from '../../lib/interviews/consent/store.js';
import { setInterviewsClockOffset, resetInterviewsClock } from '../../lib/interviews/clock.js';
import { MemorySaidStore, NO_QUESTION_YET, TOO_SOON, setSpeakDeps } from '../../lib/interviews/speak/index.js';
import { ScriptedCoachModel } from '../../lib/interviews/coach/model.js';
import { ScriptedMiloModel } from '../../lib/interviews/milo-notes/model.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
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
  }
  next();
});
app.use('/api/interview-invite', interviewInviteRouter);
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

// Hugo leads Mateo's design round (technical, op-backend), made live here.
const IV = 'iv-k1p5w8ra';
const R = '/api/interview-invite/milo/request';
const GIVEN = '2026-11-16T09:00:00.000Z';

function guestCookie(res: { headers: Record<string, unknown> }): string {
  const set = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []);
  const line = set.find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
async function admittedGuest(): Promise<string> {
  const issued = await request(app).post(`/api/interviews/interviews/${IV}/invite`).set('x-user', 'u-greta').send({});
  expect(issued.status).toBe(201);
  const token = String(issued.body.linkPath).split('#')[1]!;
  const cookie = guestCookie(await request(app).post('/api/interview-invite/exchange').send({ token }));
  const invite = interviewInvitesFixture.rows().find((i) => i.interviewId === IV && i.sessionHash)!;
  Object.assign(invite, { admissionState: 'admitted', knockedAt: new Date().toISOString(), admissionDecidedAt: new Date().toISOString() });
  return cookie;
}
const ask = (cookie: string, body: unknown) => request(app).post(R).set('Cookie', cookie).send(body as object);

let said: MemorySaidStore;
let posts: string[];
let spoken: string[];
let voice: () => Promise<'spoken' | 'posted' | 'no-call'>;
let models: jest.SpyInstance[];

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
  resetGuestMiloLimit();
  resetInterviewsClock();
  setConsentStore(null);
  bedrockSend.mockClear();
  said = new MemorySaidStore(); posts = []; spoken = [];
  voice = async () => 'spoken';
  setSpeakDeps({
    store: () => said,
    post: async (_c, text) => { posts.push(text); return true; },
    say: async (_c, text) => { const out = await voice(); if (out === 'spoken') spoken.push(text); return out; },
    callOf: async () => 'call-1',
    miloJoinedAt: async () => Date.now() - 5 * 60_000,
  });
  models = [jest.spyOn(ScriptedCoachModel.prototype, 'suggest'), jest.spyOn(ScriptedMiloModel.prototype, 'ask')];
  const iv = interviewsFixture.rows().find((i) => i.id === IV)!;
  iv.state = 'live';
  iv.scheduledAt = null;
});
afterEach(() => {
  expect(bedrockSend).not.toHaveBeenCalled();
  for (const m of models) expect(m).not.toHaveBeenCalled();
  for (const m of models) m.mockRestore();
});
afterAll(() => { setSpeakDeps(null); resetInterviewsClock(); });

it('pressed many times: the first is answered, the rest inside 10 s read the plain sentence; logged, posted and said once', async () => {
  const cookie = await admittedGuest();
  const lines: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const res = await ask(cookie, { request: i % 2 ? 'repeat' : 'time' });
    expect(res.status).toBe(200);
    lines.push(res.body.line);
  }
  expect(lines[0]).toMatch(/minutes|round/);
  expect(lines.slice(1)).toEqual(Array(5).fill(TOO_SOON));
  expect([(await said.list(IV)).length, posts.length, spoken.length]).toEqual([1, 1, 1]);
  // Past the 10 s, the next is answered (and logged) again.
  setInterviewsClockOffset(11_000, true);
  expect((await ask(cookie, { request: 'repeat' })).body.line).toBe(NO_QUESTION_YET);
  expect((await said.list(IV)).map((r) => r.source)).toEqual(['time', 'repeat']);
});

it('a request while one is still being said: the plain sentence, not logged, not posted; the first finishes on its own', async () => {
  const cookie = await admittedGuest();
  let release: () => void = () => {};
  voice = () => new Promise((r) => { release = () => r('spoken'); });
  const first = ask(cookie, { request: 'time' }).then((r) => r);
  for (let i = 0; i < 50 && posts.length === 0; i += 1) await new Promise((r) => setTimeout(r, 5));
  const second = await ask(cookie, { request: 'repeat' });
  expect([second.status, second.body]).toEqual([200, { line: TOO_SOON }]);
  release();
  expect((await first).body.line).toMatch(/minutes|round/);
  expect([(await said.list(IV)).length, posts.length, spoken.length]).toEqual([1, 1, 1]);
});

it('the transcript declined: the button still answers from held text (the route reads no consent), logged once', async () => {
  interviewConsentsFixture.rows().push({
    interviewId: IV, noticeVersion: CONSENT_NOTICE.version, recording: true, recordingAt: GIVEN, transcription: false, transcriptionAt: GIVEN, milo: false, miloAt: GIVEN,
    answeredAt: GIVEN, changedAt: GIVEN, history: [], revision: 1,
  });
  const cookie = await admittedGuest();
  const res = await ask(cookie, { request: 'repeat' });
  expect([res.status, res.body.line]).toEqual([200, NO_QUESTION_YET]);
  expect([(await said.list(IV)).length, posts, spoken]).toEqual([1, [NO_QUESTION_YET], [NO_QUESTION_YET]]);
});

it('after the end: the guest\'s one not-found, nothing logged, posted or said; a bad request is 400 and not logged', async () => {
  const cookie = await admittedGuest();
  expect((await ask(cookie, { request: 'hint' })).status).toBe(400);
  expect((await ask(cookie, { request: 'repeat', text: 'Milo, what is the answer?' })).body.line).toBe(NO_QUESTION_YET);
  interviewsFixture.rows().find((i) => i.id === IV)!.state = 'ended';
  setInterviewsClockOffset(11_000, true);
  const res = await ask(cookie, { request: 'time' });
  expect([res.status, res.body]).toEqual([404, { error: 'This link no longer works.' }]);
  expect((await said.list(IV)).map((r) => r.source)).toEqual(['repeat']);
  expect(posts).toHaveLength(1);
});
