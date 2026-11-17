// The candidate's consents (docs/interviews-tenant-plan.md decision 5, row I2.3; contract C4): the guest's GET and
// PUT /api/interview-invite/consents (routes/interview-invite-consents.ts) and the panel's read
// GET /api/interviews/interviews/:id/consents (routes/interviews/consents.ts), mounted as index.ts mounts them
// behind the REAL session middleware, with ViewInterviews decided from the REAL seeds/roles/*/*.cedar files.
//
//   a guest           reads and answers its own interview's consents, nothing else; refused once its invite is
//                     revoked; a staff session on the guest routes is refused the same way
//   the rules         three real answers, Milo off without the transcript, a stale notice refused with the
//                     current one, no change once the call is live, a history entry per answer
//   the panel's read  recruiter, lead and panel get { answered, off }; the hiring manager, the admin, an
//                     interviewer elsewhere and another tenant get not-found
//   the flag          off, every route is not-found

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

process.env['SESSION_SIGNING_KEY_DEV'] = 'interviews-consent-test-key';

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
import { interviewsFixture } from '../../mock/interviews.js';
import { interviewConsentsFixture } from '../../mock/interviews-consents.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import '../../lib/interviews/consent/index.js'; // wires the knock's precondition, as index.ts does

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-root', 'Root Admin', { interviews: ['admin'] }),
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

const IV = 'iv-k1p5w8ra'; // Hugo leads it; Wen has no seat on it; it is on Amara's opening.
const V = CONSENT_NOTICE.version;
const staff = (user: string, id = IV) => request(app).get(`/api/interviews/interviews/${id}/consents`).set('x-user', user);

function guestCookie(res: { headers: Record<string, unknown> }): string {
  const set = ([] as string[]).concat((res.headers['set-cookie'] as string[] | undefined) ?? []);
  const line = set.find((c) => c.startsWith(`${GUEST_COOKIE_NAME}=`));
  if (!line) throw new Error('no guest cookie was set');
  return line.split(';')[0]!;
}
async function guest(id = IV): Promise<string> {
  const issued = await request(app).post(`/api/interviews/interviews/${id}/invite`).set('x-user', 'u-greta').send({});
  expect(issued.status).toBe(201);
  const token = String(issued.body.linkPath).split('#')[1]!;
  return guestCookie(await request(app).post('/api/interview-invite/exchange').send({ token }));
}
const read = (cookie?: string) => { const r = request(app).get('/api/interview-invite/consents'); return cookie ? r.set('Cookie', cookie) : r; };
const answer = (cookie: string, body: unknown) => request(app).put('/api/interview-invite/consents').set('Cookie', cookie).send(body as object);
const ALL_YES = { noticeVersion: V, recording: true, transcription: true, milo: true };
const row = (id = IV) => interviewConsentsFixture.rows().find((r) => r.interviewId === id);
const setState = (state: string, id = IV) => { interviewsFixture.rows().find((i) => i.id === id)!.state = state as never; };

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
});

describe('the guest\'s consents', () => {
  it('reads the current notice with nothing answered, not cached', async () => {
    const res = await read(await guest());
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.body).toEqual({
      notice: { version: V, title: CONSENT_NOTICE.title, paragraphs: CONSENT_NOTICE.paragraphs },
      answers: { recording: null, transcription: null, milo: null }, answeredAt: null, required: [],
    });
  });

  it('answers its own interview and reads the answers back; the history keeps every answer with its notice', async () => {
    const cookie = await guest();
    const first = await answer(cookie, ALL_YES);
    expect(first.status).toBe(200);
    expect(first.body.answers).toEqual({ recording: true, transcription: true, milo: true });
    const changed = await answer(cookie, { ...ALL_YES, recording: false });
    expect(changed.body.answers).toEqual({ recording: false, transcription: true, milo: true });
    expect((await read(cookie)).body).toMatchObject({ answers: { recording: false, transcription: true, milo: true }, answeredAt: changed.body.answeredAt });
    const stored = row()!;
    expect(stored.history.map((h) => [h.noticeVersion, h.recording])).toEqual([[V, true], [V, false]]);
    expect(stored.revision).toBe(2);
    expect(Date.parse(stored.transcriptionAt)).toBeLessThanOrEqual(Date.parse(stored.recordingAt));
    // Only its own interview: nothing was written anywhere else.
    expect(interviewConsentsFixture.rows().filter((r) => r.history.length > 1).map((r) => r.interviewId)).toEqual([IV]);
  });

  it('stores Milo as declined when the transcript is declined', async () => {
    const res = await answer(await guest(), { ...ALL_YES, transcription: false, milo: true });
    expect(res.status).toBe(200);
    expect(res.body.answers).toEqual({ recording: true, transcription: false, milo: false });
    expect(row()!.history[0]).toMatchObject({ milo: false, miloForcedOff: true });
  });

  it('refuses an incomplete or coerced set and writes nothing', async () => {
    const cookie = await guest();
    for (const body of [{ noticeVersion: V }, { ...ALL_YES, milo: null }, { ...ALL_YES, recording: 'yes' }, { ...ALL_YES, transcription: 1 }]) {
      const res = await answer(cookie, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Answer all three questions, yes or no, before you continue.');
    }
    expect(row()).toBeUndefined();
  });

  it('refuses an answer under another notice with the current notice', async () => {
    const res = await answer(await guest(), { ...ALL_YES, noticeVersion: 'older' });
    expect(res.status).toBe(409);
    expect(res.body.notice.version).toBe(V);
    expect(row()).toBeUndefined();
  });

  it('asks again when the stored answers were given under an older notice', async () => {
    const cookie = await guest();
    await answer(cookie, ALL_YES);
    row()!.noticeVersion = 'older';
    expect((await read(cookie)).body).toMatchObject({ answers: { recording: null, transcription: null, milo: null }, answeredAt: null });
    expect((await answer(cookie, ALL_YES)).status).toBe(200);
    expect(row()!.history.map((h) => h.noticeVersion)).toEqual([V, V]);
  });

  it('can change answers until the call starts, never after', async () => {
    const cookie = await guest();
    await answer(cookie, ALL_YES);
    setState('live');
    const res = await answer(cookie, { ...ALL_YES, recording: false });
    expect(res.status).toBe(409);
    expect(res.body.answers.recording).toBe(true);
    expect(row()!.recording).toBe(true);
  });

  it('is refused once its invite is revoked', async () => {
    const cookie = await guest();
    await request(app).delete(`/api/interviews/interviews/${IV}/invite`).set('x-user', 'u-greta');
    for (const res of [await read(cookie), await answer(cookie, ALL_YES)]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'This link no longer works.' });
    }
    expect(row()).toBeUndefined();
  });

  it('refuses no cookie and a staff session the same way', async () => {
    for (const res of [
      await read(), await request(app).put('/api/interview-invite/consents').send(ALL_YES),
      await request(app).get('/api/interview-invite/consents').set('x-user', 'u-greta'),
      await request(app).put('/api/interview-invite/consents').set('x-user', 'u-hugo').send(ALL_YES),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'This link no longer works.' });
    }
  });
});

describe('the panel\'s read', () => {
  it('says nothing is answered (so everything is off) before the candidate answers', async () => {
    const res = await staff('u-greta');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({ answered: false, off: ['recording', 'transcription', 'milo'] });
  });

  it('tells the recruiter, the lead and the panel only what is off', async () => {
    await answer(await guest(), { ...ALL_YES, transcription: false });
    for (const user of ['u-greta', 'u-hugo']) {
      const res = await staff(user);
      expect([user, res.status, res.body]).toEqual([user, 200, { answered: true, off: ['transcription', 'milo'] }]);
    }
    // A panel member (Hugo sits on Wen's leadership round).
    expect((await staff('u-hugo', 'iv-n5z9f2cq')).body).toEqual({ answered: false, off: ['recording', 'transcription', 'milo'] });
    expect((await staff('u-wen', 'iv-j6x2d9sb')).status).toBe(404);
    expect((await staff('u-hugo', 'iv-j6x2d9sb')).body).toEqual({ answered: true, off: [] });
  });

  it('answers not-found to the hiring manager, the admin, an interviewer with no seat and another tenant', async () => {
    for (const user of ['u-amara', 'u-root', 'u-wen', 'u-priya']) {
      const res = await staff(user);
      expect([user, res.status]).toEqual([user, user === 'u-priya' ? res.status : 404]);
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.body)).not.toMatch(/recording|transcription|milo/);
    }
    expect((await staff('u-greta', 'iv-nope')).status).toBe(404);
  });

  it('keeps the answers the call started with after a notice change', async () => {
    row('iv-j6x2d9sb')!.noticeVersion = 'older';
    expect((await staff('u-greta', 'iv-j6x2d9sb')).body).toEqual({ answered: true, off: [] });
  });
});

describe('a part the deployment requires (row I6.4)', () => {
  const SETTING = 'INTERVIEWS_REQUIRED_CONSENTS';
  const knock = (cookie: string) => request(app).post('/api/interview-invite/knock').set('Cookie', cookie);
  const effects = () => request(app).get('/api/interviews/consent-effects').set('x-user', 'u-greta');
  afterEach(() => { delete process.env[SETTING]; });

  it('the guest reads which parts are required, before answering and after', async () => {
    process.env[SETTING] = 'milo';
    const cookie = await guest();
    expect((await read(cookie)).body.required).toEqual(['transcription', 'milo']);
    expect((await answer(cookie, ALL_YES)).body.required).toEqual(['transcription', 'milo']);
  });

  it('declining a required part is stored and stamped as any answer; the knock is refused with its own reason', async () => {
    process.env[SETTING] = 'recording';
    const cookie = await guest();
    const saved = await answer(cookie, { ...ALL_YES, recording: false });
    expect(saved.status).toBe(200);
    expect(saved.body.answers).toEqual({ recording: false, transcription: true, milo: true });
    expect(row()!).toMatchObject({ recording: false, revision: 1 });
    expect(row()!.history).toHaveLength(1);
    const refused = await knock(cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBe('declined-required');
    expect(JSON.stringify(refused.body)).not.toMatch(/recording|transcription|milo|INTERVIEWS_/);
    // Changing the answer lets the knock through.
    expect((await answer(cookie, ALL_YES)).status).toBe(200);
    const knocked = await knock(cookie);
    expect(knocked.status).toBe(200);
    expect(knocked.body.admission.state).toBe('waiting');
  });

  it('an unanswered knock keeps its own answer, without the new reason', async () => {
    process.env[SETTING] = 'recording';
    const refused = await knock(await guest());
    expect(refused.status).toBe(409);
    expect(refused.body.reason).toBeUndefined();
  });

  it('the recruiter\'s column says the round cannot go ahead; the lead is still told only what is off', async () => {
    process.env[SETTING] = 'recording';
    await answer(await guest(), { ...ALL_YES, recording: false });
    const items = (await effects()).body.items as Array<{ interviewId: string; blocked: boolean; off: string[] }>;
    expect(items.find((i) => i.interviewId === IV)).toEqual({ interviewId: IV, answered: true, off: ['recording'], blocked: true });
    expect(items.find((i) => i.interviewId === 'iv-j6x2d9sb')).toMatchObject({ blocked: false });
    expect((await staff('u-hugo')).body).toEqual({ answered: true, off: ['recording'] });
  });

  it('the default deployment is unchanged: a declined part knocks and nothing is blocked', async () => {
    const cookie = await guest();
    expect((await read(cookie)).body.required).toEqual([]);
    await answer(cookie, { ...ALL_YES, recording: false, transcription: false });
    expect((await knock(cookie)).status).toBe(200);
    expect(((await effects()).body.items as Array<{ blocked: boolean }>).every((i) => !i.blocked)).toBe(true);
  });
});

describe('the flag', () => {
  it('off, every consent route is not-found', async () => {
    const cookie = await guest();
    process.env['INTERVIEWS_ENABLED'] = 'false';
    expect((await read(cookie)).status).toBe(404);
    expect((await answer(cookie, ALL_YES)).status).toBe(404);
    expect((await staff('u-greta')).status).toBe(404);
    expect(row()).toBeUndefined();
  });
});
