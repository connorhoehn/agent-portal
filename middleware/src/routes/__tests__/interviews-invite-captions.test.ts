// The candidate's own live captions (routes/interview-invite.ts GET /captions; lib/interviews/invite/captions.ts; gap audit
// 2026-11-20 §11), mounted as index.ts mounts the guest routes, the transcript stood in through setCaptionsSource.
//
//   setting off        the one not-found, even for an admitted guest of a live round who accepted the transcript
//   not admitted       the one not-found; not live (accepted, let in, round not started) the same; after the end the same
//   transcript declined  the one not-found; the room still says captions are offered
//   another interview's guest  reads its own interview's lines only (the source is asked for that interview alone)
//   dead link / no cookie / staff  the one not-found
//   a line             exactly seq, speaker (you | interviewer | milo) and text; at most CAPTIONS_MAX_LINES; `after` passed through
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


process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-invite-captions-test-key';

import express from 'express';
import cookieParser from 'cookie-parser';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { GUEST_COOKIE_NAME, sessionMiddleware, type Session } from '../../lib/session.js';
import { listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { interviewInviteRouter, resetInviteThrottle } from '../interview-invite.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import { CAPTIONS_MAX_LINES, setCaptionsSource } from '../../lib/interviews/invite/captions.js';
import type { LiveLine, LiveTranscriptSource } from '../../lib/interviews/milo-notes/transcript.js';
import { ASSISTANT_USER_ID } from '../../lib/meeting-assistant/chat-types.js';

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
    req.sessionSource = 'cookie';
  }
  next();
});
app.use('/api/interview-invite', interviewInviteRouter);
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

const IV = 'iv-k1p5w8ra'; // Mateo's design round, Hugo leads, ready
const OTHER = 'iv-c3k8w2ma';
const REFUSAL = { error: 'This link no longer works.' };

function guestCookie(res: { headers: Record<string, unknown> }): string {
  const set = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []);
  const line = set.find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
async function guestOf(id: string): Promise<string> {
  const made = await request(app).post(`/api/interviews/interviews/${id}/invite`).set('x-user', 'u-greta').send({});
  expect(made.status).toBe(201);
  const token = String(made.body.linkPath).split('#')[1]!;
  return guestCookie(await request(app).post('/api/interview-invite/exchange').send({ token }));
}
const answer = (cookie: string, transcription: boolean) => request(app).put('/api/interview-invite/consents').set('Cookie', cookie)
  .send({ noticeVersion: CONSENT_NOTICE.version, recording: true, transcription, milo: transcription });
const knock = (cookie: string) => request(app).post('/api/interview-invite/knock').set('Cookie', cookie).send();
const admit = (id = IV) => request(app).post(`/api/interviews/interviews/${id}/admit`).set('x-user', 'u-hugo').send({ admit: true });
async function roomWrite(what: 'start' | 'end', id = IV) {
  const revision = (await request(app).get(`/api/interviews/interviews/${id}/room`).set('x-user', 'u-hugo')).body.room.revision;
  return request(app).post(`/api/interviews/interviews/${id}/${what}`).set('x-user', 'u-hugo').send({ revision });
}
const captions = (cookie: string | null, after?: number) => {
  const r = request(app).get(`/api/interview-invite/captions${after === undefined ? '' : `?after=${after}`}`);
  return cookie ? r.set('Cookie', cookie) : r;
};

const line = (seq: number, userId: string, text: string): LiveLine => ({ seq, atMs: 1_700_000_000_000 + seq, userId, text });
let asked: Array<{ id: string; after: number }> = [];
let held: LiveLine[] = [];
const source: LiveTranscriptSource = async (interview, after) => {
  asked.push({ id: interview.id, after });
  const lines = held.filter((l) => l.seq > after);
  return { callId: 'call-1', startedAtMs: 0, lastSeq: lines.reduce((m, l) => Math.max(m, l.seq), after), lines };
};

/** A guest who accepted (or declined) the transcript, knocked, was let in, and whose round Hugo then started. */
async function liveGuest(transcription = true): Promise<string> {
  const cookie = await guestOf(IV);
  expect((await answer(cookie, transcription)).status).toBe(200);
  expect((await knock(cookie)).status).toBe(200);
  expect((await admit()).status).toBe(200);
  expect((await roomWrite('start')).status).toBe(200);
  return cookie;
}

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  process.env['INTERVIEWS_CANDIDATE_CAPTIONS'] = 'on';
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
  asked = []; held = [];
  setCaptionsSource(source);
});
afterAll(() => { setCaptionsSource(null); delete process.env['INTERVIEWS_CANDIDATE_CAPTIONS']; });

describe('the candidate\'s captions', () => {
  it('answers an admitted guest of a live round who accepted the transcript: seq, speaker class and text, nothing else', async () => {
    const cookie = await liveGuest();
    const guestId = (await request(app).get('/api/interview-invite/room').set('Cookie', cookie)).body.room.self.userId as string;
    held = [line(1, 'u-hugo', 'Welcome, Mateo.'), line(2, guestId, 'Thanks <b>Hugo</b>.'), line(3, ASSISTANT_USER_ID, 'Ten minutes left.')];
    const res = await captions(cookie);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ captions: { running: true, lastSeq: 3, lines: [
      { seq: 1, speaker: 'interviewer', text: 'Welcome, Mateo.' },
      { seq: 2, speaker: 'you', text: 'Thanks <b>Hugo</b>.' },
      { seq: 3, speaker: 'milo', text: 'Ten minutes left.' },
    ] } });
    for (const l of res.body.captions.lines) expect(Object.keys(l).sort()).toEqual(['seq', 'speaker', 'text']);
    expect(JSON.stringify(res.body)).not.toMatch(/u-hugo|guest:|Marchetti|agent:|1700000000/);
    // Only its own interview's lines are asked for.
    expect(asked.every((a) => a.id === IV)).toBe(true);
  });

  it('after: only what is newer; the bound: at most the newest CAPTIONS_MAX_LINES', async () => {
    const cookie = await liveGuest();
    held = Array.from({ length: CAPTIONS_MAX_LINES + 20 }, (_, i) => line(i + 1, 'u-hugo', `line ${i + 1}`));
    const all = await captions(cookie);
    expect(all.body.captions.lines).toHaveLength(CAPTIONS_MAX_LINES);
    expect(all.body.captions.lines[0].seq).toBe(21);
    expect(all.body.captions.lastSeq).toBe(CAPTIONS_MAX_LINES + 20);
    const newer = await captions(cookie, CAPTIONS_MAX_LINES + 18);
    expect(newer.body.captions.lines.map((l: { seq: number }) => l.seq)).toEqual([CAPTIONS_MAX_LINES + 19, CAPTIONS_MAX_LINES + 20]);
    expect(asked.at(-1)!.after).toBe(CAPTIONS_MAX_LINES + 18);
    for (const bad of ['-4', 'abc']) {
      await request(app).get(`/api/interview-invite/captions?after=${bad}`).set('Cookie', cookie);
      expect(asked.at(-1)!.after).toBe(0);
    }
  });

  it('no transcript running yet: running false and no lines', async () => {
    const cookie = await liveGuest();
    setCaptionsSource(async () => null);
    expect((await captions(cookie, 4)).body).toEqual({ captions: { running: false, lines: [], lastSeq: 4 } });
  });

  it('the setting off: the one not-found, and the room says captions are not offered', async () => {
    const cookie = await liveGuest();
    held = [line(1, 'u-hugo', 'Hello.')];
    process.env['INTERVIEWS_CANDIDATE_CAPTIONS'] = 'off';
    expect([(await captions(cookie)).status, (await captions(cookie)).body]).toEqual([404, REFUSAL]);
    expect((await request(app).get('/api/interview-invite/room').set('Cookie', cookie)).body.room.captions).toBe(false);
    delete process.env['INTERVIEWS_CANDIDATE_CAPTIONS'];
    expect((await captions(cookie)).status).toBe(404);
    expect(asked).toEqual([]);
  });

  it('the transcript declined: the one not-found, though the room offers captions', async () => {
    const cookie = await liveGuest(false);
    held = [line(1, 'u-hugo', 'Hello.')];
    expect([(await captions(cookie)).status, (await captions(cookie)).body]).toEqual([404, REFUSAL]);
    expect((await request(app).get('/api/interview-invite/room').set('Cookie', cookie)).body.room.captions).toBe(true);
    expect(asked).toEqual([]);
  });

  it('not admitted, not live, ended: the one not-found', async () => {
    held = [line(1, 'u-hugo', 'Hello.')];
    const cookie = await guestOf(IV);
    await answer(cookie, true);
    expect((await captions(cookie)).status).toBe(404); // not knocked
    await knock(cookie);
    expect((await captions(cookie)).status).toBe(404); // waiting
    await admit();
    expect((await captions(cookie)).status).toBe(404); // let in, the round not started
    await roomWrite('start');
    expect((await captions(cookie)).status).toBe(200);
    await roomWrite('end');
    expect([(await captions(cookie)).status, (await captions(cookie)).body]).toEqual([404, REFUSAL]);
  });

  it('another interview\'s guest, a dead link, no cookie and a staff session: the one not-found', async () => {
    const own = await liveGuest();
    held = [line(1, 'u-hugo', 'Hello.')];
    expect((await captions(own)).status).toBe(200);
    const other = await guestOf(OTHER);
    await answer(other, true);
    expect([(await captions(other)).status, (await captions(other)).body]).toEqual([404, REFUSAL]);
    expect((await captions(null)).status).toBe(404);
    expect((await request(app).get('/api/interview-invite/captions').set('x-user', 'u-hugo')).status).toBe(404);
    // The recruiter revokes the link: the live guest's own cookie is a dead link now.
    expect((await request(app).delete(`/api/interviews/interviews/${IV}/invite`).set('x-user', 'u-greta')).status).toBeLessThan(300);
    expect([(await captions(own)).status, (await captions(own)).body]).toEqual([404, REFUSAL]);
    expect(asked.every((a) => a.id === IV)).toBe(true);
  });
});
