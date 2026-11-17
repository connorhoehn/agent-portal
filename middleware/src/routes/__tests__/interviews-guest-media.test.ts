// The candidate's own media participant id (routes/interview-invite-media.ts; decision 9). Header below is the pad test's setup.
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
process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-media-test-key';

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
import { setCallChatRuntime, type CallChatRuntime } from '../../lib/call-chat.js';
import { setInterviewConsentSource } from '../../lib/interviews/milo-policy.js';
import { forgetInterviewGuest } from '../../lib/interviews/invite/admission.js';
import { assistantAudio, setAssistantAudio } from '../../lib/meeting-assistant/audio-select.js';
import { AudioIntake } from '../../lib/meeting-assistant/audio-intake.js';
import { MemoryAssistantStore } from '../../lib/meeting-assistant/store.js';
import { newAssistantSession } from '../../lib/meeting-assistant/types.js';
import { setAssistantStore } from '../../lib/meeting-assistant/store-select.js';

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
  }
  next();
});

app.use('/api/interview-invite', interviewInviteRouter);
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

const IV = 'iv-k1p5w8ra';
const OTHER = 'iv-c3k8w2ma';
const AT = '2026-11-17T10:00:00.000Z';
const CALL = 'call-iv-1';
const OTHER_CALL = 'call-other';
const greta = (p: string, body: unknown) => request(app).post(`/api/interviews${p}`).set('x-user', 'u-greta').send(body as object);
const setState = (id: string, state: string) => { (interviewsFixture.rows().find((i) => i.id === id)! as { state: string }).state = state; };

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const line = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []).find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
/** A guest of `id`, admitted unless told otherwise: its cookie and its subject. */
async function guestOf(id: string, admitted = true): Promise<{ cookie: string; subject: string; inviteId: string }> {
  const made = await greta(`/interviews/${id}/invite`, {});
  expect(made.status).toBe(201);
  const cookie = cookieOf(await request(app).post('/api/interview-invite/exchange').send({ token: String(made.body.linkPath).split('#')[1] }));
  const row = interviewInvitesFixture.rows().find((r) => r.interviewId === id && r.revokedAt === null)!;
  if (admitted) Object.assign(row, { admissionState: 'admitted', knockedAt: AT, admissionDecidedAt: AT });
  return { cookie, subject: `guest:${row.id}`, inviteId: row.id };
}
const bind = (cookie: string, body: unknown) => request(app).post('/api/interview-invite/media/participant').set('Cookie', cookie).send(body as object);

// The call chat runtime, faked: which lobby a call is, and who holds a seat in it.
const lobbies: Record<string, string> = {};
let seated: Array<{ userId: string; active: boolean }> = [];
let store: MemoryAssistantStore;
let consent: { transcription: boolean; milo: boolean } | null = { transcription: true, milo: true };

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
  Object.assign(lobbies, { [CALL]: `interviews:interview:${IV}`, [OTHER_CALL]: `interviews:interview:${OTHER}` });
  seated = [];
  consent = { transcription: true, milo: true };
  setInterviewConsentSource(async () => consent);
  setCallChatRuntime({ lobbyOf: async (c: string) => lobbies[c] ?? null, seatedUsers: async () => seated } as unknown as CallChatRuntime);
  store = new MemoryAssistantStore();
  setAssistantStore(store);
  setAssistantAudio(new AudioIntake(() => store));
  setState(IV, 'live');
});
afterAll(() => { setCallChatRuntime(null); setInterviewConsentSource(null); setAssistantAudio(null); setAssistantStore(null); });

describe('the candidate binds its own media participant id', () => {
  it('binds the id the media server stamps on its own subject, while admitted, seated and live', async () => {
    const g = await guestOf(IV);
    seated = [{ userId: g.subject, active: true }];
    const res = await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-lq3k9z` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ bound: true });
    expect(assistantAudio().userOf(CALL, `${g.subject}-lq3k9z`)).toBe(g.subject);
    // Again is the same answer.
    expect((await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-lq3k9z` })).body).toEqual({ bound: true });
  });

  it('refuses another guest\'s id, a staff id, a bare subject and a malformed one, binding nothing', async () => {
    const g = await guestOf(IV);
    seated = [{ userId: g.subject, active: true }, { userId: 'u-hugo', active: true }];
    const first = await bind(g.cookie, { callId: CALL, participantId: 'guest:inv-someoneelse-lq3k9z' });
    expect(first.status).toBe(404);
    for (const participantId of ['u-hugo-lq3k9z', g.subject, `${g.subject}-`, `${g.subject}-LQ3K`, `${g.subject}-a-b`, `x${g.subject}-lq3k9z`, 42]) {
      const r = await bind(g.cookie, { callId: CALL, participantId });
      expect(r.status).toBe(404);
      expect(r.body).toEqual(first.body);
    }
    expect(assistantAudio().userOf(CALL, 'u-hugo-lq3k9z')).toBeNull();
    expect(assistantAudio().userOf(CALL, 'guest:inv-someoneelse-lq3k9z')).toBeNull();
  });

  it('refuses with no guest session, a guest not admitted, an interview not live, another interview\'s call or no seat', async () => {
    expect((await request(app).post('/api/interview-invite/media/participant').send({ callId: CALL, participantId: 'guest:x-1' })).status).toBeGreaterThanOrEqual(400);
    const waiting = await guestOf(IV, false);
    seated = [{ userId: waiting.subject, active: true }];
    expect((await bind(waiting.cookie, { callId: CALL, participantId: `${waiting.subject}-a1` })).status).toBe(404);
    const g = await guestOf(IV);
    const id = `${g.subject}-a1`;
    seated = [{ userId: g.subject, active: true }];
    setState(IV, 'ended');
    expect((await bind(g.cookie, { callId: CALL, participantId: id })).status).toBe(404);
    setState(IV, 'live');
    expect((await bind(g.cookie, { callId: OTHER_CALL, participantId: id })).status).toBe(404);
    expect((await bind(g.cookie, { callId: 'call-unknown', participantId: id })).status).toBe(404);
    seated = [{ userId: g.subject, active: false }];
    expect((await bind(g.cookie, { callId: CALL, participantId: id })).status).toBe(404);
    expect(assistantAudio().userOf(CALL, id)).toBeNull();
    expect(assistantAudio().userOf(CALL, `${waiting.subject}-a1`)).toBeNull();
  });

  it('binds nothing when the candidate declined the transcript or has not answered', async () => {
    const g = await guestOf(IV);
    seated = [{ userId: g.subject, active: true }];
    consent = { transcription: false, milo: false };
    expect((await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-a1` })).body).toEqual({ bound: false, why: 'no-transcript' });
    consent = null;
    expect((await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-a1` })).body).toEqual({ bound: false, why: 'no-transcript' });
    expect(assistantAudio().userOf(CALL, `${g.subject}-a1`)).toBeNull();
  });

  it('drops the binding when the guest is turned away, its link revoked or the interview ended', async () => {
    const g = await guestOf(IV);
    seated = [{ userId: g.subject, active: true }];
    expect((await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-a1` })).body).toEqual({ bound: true });
    await forgetInterviewGuest(IV, 'interview-ended');
    await new Promise<void>((r) => setImmediate(r));
    expect(assistantAudio().userOf(CALL, `${g.subject}-a1`)).toBeNull();
    // Revoked: the route then refuses it too.
    expect((await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-a2` })).body).toEqual({ bound: true });
    const del = await request(app).delete(`/api/interviews/interviews/${IV}/invite`).set('x-user', 'u-greta');
    expect(del.status).toBe(200);
    await new Promise<void>((r) => setImmediate(r));
    expect(assistantAudio().userOf(CALL, `${g.subject}-a2`)).toBeNull();
    expect((await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-a3` })).status).toBe(404);
  });

  it('with Milo already listening, the candidate\'s portal acknowledgement counts once it is bound', async () => {
    const g = await guestOf(IV);
    seated = [{ userId: g.subject, active: true }];
    await store.create({
      callId: CALL, tenant: 'interviews', lobby: `interviews:interview:${IV}`, initiativeId: null, state: 'listening', invitedBy: 'u-hugo', invitedAt: Date.parse(AT),
      pausedBy: null, leftAt: null, leftBy: null, acked: ['u-hugo'], attendees: ['u-hugo'], presentAtInvite: ['u-hugo'],
      requests: 0, linesStored: 0, nextSeq: 1, pendingRequests: [], session: newAssistantSession(3600),
    });
    expect((await bind(g.cookie, { callId: CALL, participantId: `${g.subject}-a1` })).body).toEqual({ bound: true });
    expect((await store.get(CALL))!.acked).toContain(g.subject);
  });
});
