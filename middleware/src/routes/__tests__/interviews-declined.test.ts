// A declined consent (docs/interviews-tenant-plan.md decision 5, row I2.5): what the recruiter is told, and nothing shown against
// the candidate. The recruiter's read GET /api/interviews/consent-effects (routes/interviews/consent-effects.ts), the recruiter's
// bell (lib/interviews/consent-bell.ts), and a walk over the JSON of every staff view for any consent field, mounted as index.ts
// mounts them behind the REAL session middleware, with ViewInterviews decided from the REAL seeds/roles/*/*.cedar files.
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


import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { consentBellChange, consentsSaved, offLabel } from '../../lib/interviews/consent-bell.js';

const IV = 'iv-mateo-design'; // Hugo leads it; Wen has no seat on it; it is on Amara's opening (op-backend, Greta recruits).
const V = CONSENT_NOTICE.version;
const effects = (user: string) => request(app).get('/api/interviews/consent-effects').set('x-user', user);
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
const answer = (cookie: string, a: { recording: boolean; transcription: boolean; milo: boolean }) =>
  request(app).put('/api/interview-invite/consents').set('Cookie', cookie).send({ noticeVersion: V, ...a });
const itemFor = (body: { items: Array<{ interviewId: string }> }, id = IV) => body.items.find((i) => i.interviewId === id);

let sent: Array<{ userId: string; input: NotificationInputLike }>;
beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  resetInviteThrottle();
  sent = [];
  setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } });
});
afterEach(() => setNotificationSink(null));

describe('GET /consent-effects: the recruiter\'s read', () => {
  it('lists every round with whether it is answered and what is off; nothing more', async () => {
    const res = await effects('u-greta');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(itemFor(res.body)).toEqual({ interviewId: IV, answered: false, off: ['recording', 'transcription', 'milo'] });
    for (const item of res.body.items) expect(Object.keys(item).sort()).toEqual(['answered', 'interviewId', 'off']);
    const cookie = await guest();
    expect((await answer(cookie, { recording: false, transcription: true, milo: true })).status).toBe(200);
    expect(itemFor((await effects('u-greta')).body)).toEqual({ interviewId: IV, answered: true, off: ['recording'] });
    expect((await answer(cookie, { recording: true, transcription: false, milo: true })).status).toBe(200);
    expect(itemFor((await effects('u-greta')).body)).toEqual({ interviewId: IV, answered: true, off: ['transcription', 'milo'] });
    expect(itemFor((await effects('u-root')).body)).toEqual({ interviewId: IV, answered: true, off: ['transcription', 'milo'] });
  });

  it('is not-found for the lead, another interviewer and the hiring manager; another tenant never reaches it', async () => {
    for (const who of ['u-hugo', 'u-wen', 'u-amara']) expect([who, (await effects(who)).status]).toEqual([who, 404]);
    expect((await effects('u-priya')).status).toBe(403); // the tenant gate, before the router
  });

  it('is not-found while the tenant is off', async () => {
    process.env['INTERVIEWS_ENABLED'] = 'false';
    expect((await effects('u-greta')).status).toBe(404);
  });
});

describe('the recruiter\'s bell', () => {
  const ON = { recording: true, transcription: true, milo: true };
  it('rings when the answers are first complete with a part off, and again only when what is off changes', () => {
    expect(consentBellChange(null, ON)).toBeNull();
    expect(consentBellChange(null, { ...ON, recording: false })).toEqual(['recording']);
    expect(consentBellChange({ ...ON, recording: false }, { ...ON, recording: false })).toBeNull();
    expect(consentBellChange({ ...ON, recording: false }, { ...ON, milo: false })).toEqual(['milo']);
    expect(consentBellChange({ ...ON, milo: false }, ON)).toEqual([]);
    expect(consentBellChange(ON, ON)).toBeNull();
    // Milo sent as yes with the transcript declined reads the same as Milo declined: no change, no bell.
    expect(consentBellChange({ ...ON, transcription: false, milo: false }, { ...ON, transcription: false, milo: true })).toBeNull();
  });

  it('says what is off in plain words', () => {
    expect(offLabel(['recording'])).toBe('no recording');
    expect(offLabel(['transcription', 'milo'])).toBe('no transcript, no Milo');
    expect(offLabel([])).toBe('');
  });

  it('goes to the opening\'s recruiter with the opening, the round and what is off; never the candidate', async () => {
    expect(await consentsSaved(IV, null, { recording: false, transcription: false, milo: false })).toEqual(['u-greta']);
    expect(sent).toHaveLength(1);
    const { userId, input } = sent[0]!;
    expect(userId).toBe('u-greta');
    expect(input.title).toMatch(/runs with no recording, no transcript, no Milo$/);
    expect(input.title).toContain('Senior Backend Engineer');
    expect(input.action).toEqual({ label: 'Open Upcoming', href: '/interviews/upcoming' });
    expect(input.payload).toMatchObject({ tenant: 'interviews', kind: 'interview-consent-off', audience: 'recruiter' });
    const text = JSON.stringify(input);
    for (const word of ['Mateo', 'cand-', 'iv-mateo', 'chose', 'declined']) expect([word, text.includes(word)]).toEqual([word, false]);
    sent = [];
    expect(await consentsSaved(IV, { recording: false, transcription: false, milo: false }, { recording: false, transcription: false, milo: false })).toEqual([]);
    expect(await consentsSaved(IV, { recording: false, transcription: false, milo: false }, { recording: true, transcription: true, milo: true })).toEqual(['u-greta']);
    expect(sent[0]!.input.title).toMatch(/everything on again$/);
  });

  it('rings nobody for an unknown interview and never throws', async () => {
    expect(await consentsSaved('iv-nope', null, { recording: false, transcription: true, milo: true })).toEqual([]);
    setNotificationSink(null);
    expect(await consentsSaved(IV, null, { recording: false, transcription: true, milo: true })).toEqual([]);
  });
});

describe('nothing shown against the candidate', () => {
  const CONSENT_KEY = /consent|^(recording|transcription|transcript|milo|answered|off|noticeVersion)$/i;
  function keysOf(value: unknown, path = '$', out: string[] = []): string[] {
    if (Array.isArray(value)) value.forEach((v, i) => keysOf(v, `${path}[${i}]`, out));
    else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) { if (CONSENT_KEY.test(k)) out.push(`${path}.${k}`); keysOf(v, `${path}.${k}`, out); }
    }
    return out;
  }

  it('the candidate\'s record, the interview record with its scorecards, and every list carry no consent field for any role', async () => {
    const cookie = await guest();
    expect((await answer(cookie, { recording: false, transcription: false, milo: false })).status).toBe(200);
    for (const who of ['u-greta', 'u-hugo', 'u-wen', 'u-amara', 'u-root']) {
      const get = (path: string) => request(app).get(`/api/interviews${path}`).set('x-user', who);
      const lists = await Promise.all(['/candidates', '/interviews', '/openings'].map(get));
      const views = lists.map((r) => r.body);
      for (const c of (lists[0]!.body.items ?? []) as Array<{ id: string }>) views.push((await get(`/candidates/${c.id}`)).body);
      for (const i of (lists[1]!.body.items ?? []) as Array<{ id: string }>) views.push((await get(`/interviews/${i.id}`)).body);
      for (const o of (lists[2]!.body.items ?? []) as Array<{ id: string }>) views.push((await get(`/openings/${o.id}`)).body);
      expect(views.length).toBeGreaterThan(3); // the walk reads real views, not empty answers
      expect([who, keysOf(views)]).toEqual([who, []]);
    }
  });

  it('the hiring manager is refused both consent reads', async () => {
    expect((await request(app).get(`/api/interviews/interviews/${IV}/consents`).set('x-user', 'u-amara')).status).toBe(404);
    expect((await effects('u-amara')).status).toBe(404);
  });

  it('no log line in this lane\'s code prints an answer', () => {
    const root = join(__dirname, '..', '..');
    for (const file of ['lib/interviews/consent/effects.ts', 'lib/interviews/recording-rules.ts', 'lib/interviews/consent-bell.ts', 'routes/interviews/consent-effects.ts']) {
      expect([file, /console\.|logger\./.test(readFileSync(join(root, file), 'utf8'))]).toEqual([file, false]);
    }
    const tail = readFileSync(join(root, 'routes/realtime-lobby-access.ts'), 'utf8').split('An interview\'s recording')[1]!;
    expect(/console\.|logger\./.test(tail)).toBe(false);
  });
});
