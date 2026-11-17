// Hardening lane H2, row I2.5: the recruiter's bell on the edges interviews-declined.test.ts leaves open, through the candidate's
// own consents route, on the same mounting.
//   O-081  a save that loses a race (409) rings no bell
//   O-082  answering again under a new notice with the same answers rings no bell; a real change under it still does
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

const IV = 'iv-k1p5w8ra'; // Hugo leads it; Wen has no seat on it; it is on Amara's opening (op-backend, Greta recruits).
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

import { consentStore } from '../../lib/interviews/consent/store.js';

const OFF = { recording: false, transcription: true, milo: true };
const settle = () => new Promise((r) => setTimeout(r, 20)); // the bell is sent after the answer (void consentsSaved)

describe('O-081: a save that loses the race', () => {
  it('answers 409 with the answers as they now stand, and rings no bell', async () => {
    const cookie = await guest();
    expect((await answer(cookie, OFF)).status).toBe(200);
    await settle();
    expect(sent).toHaveLength(1);
    sent = [];
    const store = consentStore();
    const real = store.saveConsent.bind(store);
    // Another window saves first: this write finds the row moved on.
    const spy = jest.spyOn(store, 'saveConsent').mockImplementationOnce(async (write, revision) => {
      await real({ ...write, recording: true, transcription: false, milo: false }, revision);
      return real(write, revision);
    });
    const res = await answer(cookie, { recording: false, transcription: false, milo: false });
    expect(spy).toHaveBeenCalled();
    expect(res.status).toBe(409);
    expect(res.body.answers).toMatchObject({ recording: true, transcription: false });
    await settle();
    // The winning write went straight to the store, so it rang nothing; the losing one must not either.
    expect(sent).toHaveLength(0);
  });

  it('two saves at once: whichever loses rings nothing, so at most one bell per change', async () => {
    const cookie = await guest();
    const [a, b] = await Promise.all([answer(cookie, OFF), answer(cookie, { recording: true, transcription: false, milo: false })]);
    await settle();
    const ok = [a, b].filter((r) => r.status === 200).length;
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(sent.length).toBeLessThanOrEqual(ok);
    expect(sent.every((s) => s.userId === 'u-greta')).toBe(true);
  });
});

describe('O-082: a notice change with the same answers', () => {
  it('the same answers given again under a new notice ring nothing; a part turned off under it rings once', async () => {
    const cookie = await guest();
    expect((await answer(cookie, OFF)).status).toBe(200);
    await settle();
    expect(sent).toHaveLength(1);
    sent = [];
    // The stored answers were given to an older text (the notice has moved on since): the candidate must answer again.
    const row = interviewConsentsFixture.rows().find((r) => r.interviewId === IV)!;
    row.noticeVersion = '2020-01-01.1';
    const again = await answer(cookie, OFF);
    expect(again.status).toBe(200);
    expect(again.body.notice.version).toBe(V);
    await settle();
    expect(sent).toHaveLength(0);
    // The recruiter's read: what is off is the same as before, and now answered under the current notice.
    expect(itemFor((await effects('u-greta')).body)).toMatchObject({ answered: true, off: ['recording'] });
    const changed = await answer(cookie, { ...OFF, milo: false });
    expect(changed.status).toBe(200);
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input.title).toMatch(/runs with no recording, no Milo$/);
  });
});
