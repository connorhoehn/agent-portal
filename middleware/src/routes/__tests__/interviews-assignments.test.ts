// The assignment writes (routes/interviews/assignments.ts; docs/interviews-tenant-plan.md row I1.4, decisions 2, 16
// and 20), mounted as index.ts mounts the tenant, with AssignInterviews and ConductInterview decided from the REAL
// seeds/roles/*/*.cedar files (read off disk below).
//
//   recruiter       assigns a round and changes who sits on it; cannot answer anyone's seat (403)
//   interviewer     answers the seat they hold, and only that; a round they have no seat on is not found (404)
//   hiring-manager  reads assigned and declined rounds of their openings, with who declined and why; writes nothing (403)
//   anyone else     the tenant's usual refusal at the mount
//
// And the bell: the newly seated hear of a round, the recruiters of a decline, and no bell says anything about
// the candidate.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
  // The role → action matrix the open-mode authz derives from the Cedar seeds, read from every
  // tenant's actual files (role-registry.ts itself cannot load under jest: import.meta.url).
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

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { admitTenantNotification, setNotificationSink, type NotificationInputLike } from '../../lib/social-notify.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
  u('u-third', 'Ola Brandt', { interviews: ['interviewer'] }),
  u('u-amara', 'Amara Okafor', { interviews: ['hiring-manager'] }),
  u('u-priya', 'Priya Venkataraman', { access: ['access-admin'] }),
  u('u-operator', 'Platform Operator', { orgiq: ['admin'], interviews: ['admin'] }),
];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers['x-user'] ?? '');
  const me = USERS.find((x) => x.id === id);
  if (me) {
    const tenant = String(req.headers['x-tenant'] ?? 'interviews');
    const role = String(req.headers['x-role'] ?? me.grants[tenant]?.[0] ?? 'none');
    req.session = { sub: id, tenant, role, grants: me.grants, iat: 0, epoch: 0 } as Session;
  }
  next();
});
app.use('/api/interviews', requireTenant('interviews'), interviewsFlagGate, interviewsRouter);
app.use(errorHandler);

const API = '/api/interviews';
const who = (id: string, tenant = 'interviews', role?: string) => {
  const set = (r: ReturnType<ReturnType<typeof request>['get']>) => { r.set('x-user', id).set('x-tenant', tenant); return role ? r.set('x-role', role) : r; };
  return {
    get: (p: string) => set(request(app).get(`${API}${p}`)),
    post: (p: string, body: unknown) => set(request(app).post(`${API}${p}`)).send(body as object),
    put: (p: string, body: unknown) => set(request(app).put(`${API}${p}`)).send(body as object),
  };
};
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const WEN = who('u-wen');
const AMARA = who('u-amara');


const sent: Array<{ userId: string; item: NotificationInputLike }> = [];
const flush = () => new Promise((r) => setTimeout(r, 30));

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  sent.length = 0;
  setNotificationSink({ notifyUser: async (userId, item) => { sent.push({ userId, item }); } });
});
afterAll(() => setNotificationSink(null));

const LUCIA = { applicationId: 'app-lucia', roundId: 'rd-coding', leadId: 'u-hugo', panelIds: ['u-wen'] };
const assign = async (body: object = LUCIA) => GRETA.post('/interviews', body);
const rowOf = async (as: ReturnType<typeof who>, id: string) => (await as.get(`/interviews/${id}`)).body.interview;
/** Every word a bell shows or carries, for the "nothing about the candidate" checks. */
const bellText = () => JSON.stringify(sent.map((s) => s.item));

describe('assigning a round', () => {
  it('the recruiter assigns: a new round, assigned with no time, under a new id that says nothing about the candidate', async () => {
    const res = await assign();
    expect(res.status).toBe(201);
    const iv = res.body.interview;
    expect(iv).toMatchObject({ state: 'assigned', scheduledAt: null, round: { id: 'rd-coding', name: 'Coding' }, lead: { id: 'u-hugo' }, panel: [{ id: 'u-wen' }], revision: 1 });
    expect(iv.id).toMatch(/^iv-[a-z0-9]{12}$/);
    expect(iv.seats).toEqual([
      { person: { id: 'u-hugo', name: 'Hugo Marchetti' }, seat: 'lead', accepted: false },
      { person: { id: 'u-wen', name: 'Wen Zhao' }, seat: 'panel', accepted: false },
    ]);
    // The lead and the panel member see it, each in their own seat, waiting for them.
    expect(await rowOf(HUGO, iv.id)).toMatchObject({ seat: 'lead', bucket: 'to-accept', myAnswer: 'to-answer' });
    expect(await rowOf(WEN, iv.id)).toMatchObject({ seat: 'panel', bucket: 'to-accept', myAnswer: 'to-answer' });
  });

  it('rings the lead and the panel, with the opening and the round and nothing about the candidate', async () => {
    await assign();
    await flush();
    expect(sent.map((s) => s.userId).sort()).toEqual(['u-hugo', 'u-wen']);
    expect(sent[0]!.item).toMatchObject({
      title: 'You have a new round: Coding for Senior Backend Engineer',
      payload: { tenant: 'interviews', category: 'Candidates', audience: 'interviewer' },
      action: { href: '/interviews/my-interviews' },
    });
    expect(bellText()).not.toMatch(/Luc[ií]a|Navarro|lucia|app-lucia|cand-/);
  });

  it('refuses a bad assignment with one sentence per field', async () => {
    const res = await assign({ ...LUCIA, roundId: 'rd-leadership', panelIds: ['u-hugo', 'u-amara'] });
    expect(res.status).toBe(400);
    expect(res.body.fields.map((f: { path: string }) => f.path)).toEqual(['roundId', 'panelIds.0', 'panelIds.1']);
    expect(res.body.error).toBe('The round was not assigned: 3 things need fixing.');
    expect((await assign({ ...LUCIA, applicationId: 'app-kwame' })).body.fields[0].path).toBe('roundId');
  });

  it('the hiring manager and the interviewer cannot assign; another tenant\'s role never reaches the route', async () => {
    expect((await AMARA.post('/interviews', LUCIA)).status).toBe(403);
    expect((await HUGO.post('/interviews', LUCIA)).status).toBe(403);
    expect((await who('u-priya', 'access').post('/interviews', LUCIA)).status).toBe(403);
    expect((await AMARA.get('/interviewers')).status).toBe(403);
    expect((await GRETA.get('/interviewers')).body.items.map((p: { id: string }) => p.id)).toEqual(['u-hugo', 'u-third', 'u-wen']);
    await flush();
    expect(sent).toEqual([]);
  });
});

describe('answering a seat', () => {
  it('the lead accepts: assigned → accepted, and the round moves to their "to prepare"; no bell', async () => {
    const res = await HUGO.post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.interview).toMatchObject({ state: 'accepted', myAnswer: 'accepted', bucket: 'to-prepare', revision: 2 });
    await flush();
    expect(sent).toEqual([]);
  });

  it('a panel member declines with a reason: they leave the panel, the state stays, the recruiter is rung', async () => {
    const id = (await assign()).body.interview.id;
    await flush(); sent.length = 0;
    const res = await WEN.post(`/interviews/${id}/answer`, { revision: 1, answer: 'decline', reason: 'I interviewed this person at my last company.' });
    expect(res.status).toBe(200);
    expect(res.body.interview).toBeNull(); // no longer theirs to read
    expect((await WEN.get(`/interviews/${id}`)).status).toBe(404);
    const now = await rowOf(GRETA, id);
    expect(now).toMatchObject({ state: 'assigned', panel: [], declines: [{ person: { id: 'u-wen', name: 'Wen Zhao' }, seat: 'panel', reason: 'I interviewed this person at my last company.' }] });
    await flush();
    expect(sent.map((s) => s.userId)).toEqual(['u-greta']);
    expect(sent[0]!.item).toMatchObject({
      title: 'Wen Zhao declined a panel seat on Coding for Senior Backend Engineer',
      payload: { audience: 'recruiter' }, action: { href: `/interviews/rounds/${id}` },
    });
    expect(bellText()).not.toMatch(/Luc[ií]a|Navarro|lucia|last company/);
  });

  it('the lead declines: the round is declined with the reason; the hiring manager reads it, another interviewer does not', async () => {
    const id = (await assign()).body.interview.id;
    const res = await HUGO.post(`/interviews/${id}/answer`, { revision: 1, answer: 'decline', reason: 'On leave that whole week.' });
    expect(res.body.interview).toMatchObject({ state: 'declined', bucket: 'closed', declines: [] });
    expect((await rowOf(AMARA, id)).declines).toEqual([expect.objectContaining({ seat: 'lead', reason: 'On leave that whole week.' })]);
    expect(await rowOf(WEN, id)).toMatchObject({ state: 'declined', declines: [] });
  });

  it('a decline needs a reason; nobody answers twice; nothing once the call has started', async () => {
    const short = await HUGO.post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'decline', reason: 'busy' });
    expect(short.status).toBe(400);
    expect(short.body.fields[0].path).toBe('reason');
    expect((await HUGO.post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' })).status).toBe(200);
    const twice = await HUGO.post('/interviews/iv-kwame-coding/answer', { revision: 2, answer: 'accept' });
    expect(twice.status).toBe(409);
    expect(twice.body.error).toBe('You have already accepted this round.');
    const ended = await WEN.post('/interviews/iv-jonah-leadership/answer', { revision: 1, answer: 'accept' });
    expect(ended.status).toBe(409);
  });

  it('a stale revision answers 409 with the row as it now is', async () => {
    const id = (await assign()).body.interview.id;
    await HUGO.post(`/interviews/${id}/answer`, { revision: 1, answer: 'accept' });
    const res = await WEN.post(`/interviews/${id}/answer`, { revision: 1, answer: 'accept' });
    expect(res.status).toBe(409);
    expect(res.body.interview).toMatchObject({ id, state: 'accepted', revision: 2 });
    expect((await WEN.post(`/interviews/${id}/answer`, { answer: 'accept' })).status).toBe(400);
  });

  it('only the person in the seat answers it: the recruiter and the hiring manager are refused, a stranger finds nothing', async () => {
    expect((await GRETA.post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' })).status).toBe(403);
    expect((await AMARA.post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' })).status).toBe(403);
    expect((await WEN.post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' })).status).toBe(404);
    expect((await who('u-third').post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' })).status).toBe(404);
    expect((await who('u-priya', 'access').post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' })).status).toBe(403);
    // The cross-tenant admin sees every round but holds no seat on this one.
    const admin = await who('u-operator', 'interviews', 'admin').post('/interviews/iv-kwame-coding/answer', { revision: 1, answer: 'accept' });
    expect(admin.status).toBe(403);
    expect((await rowOf(GRETA, 'iv-kwame-coding')).state).toBe('assigned');
  });
});

describe('reassigning', () => {
  it('after a lead declines, the recruiter names a new lead: back to assigned, the decline kept, the new lead rung', async () => {
    const id = (await assign()).body.interview.id;
    await HUGO.post(`/interviews/${id}/answer`, { revision: 1, answer: 'decline', reason: 'On leave that whole week.' });
    await flush(); sent.length = 0;
    expect((await GRETA.put(`/interviews/${id}/panel`, { revision: 2, leadId: 'u-hugo', panelIds: ['u-wen'] })).body.fields[0].path).toBe('leadId');
    const res = await GRETA.put(`/interviews/${id}/panel`, { revision: 2, leadId: 'u-third', panelIds: ['u-wen'] });
    expect(res.status).toBe(200);
    expect(res.body.interview).toMatchObject({ state: 'assigned', lead: { id: 'u-third' }, revision: 3, declines: [{ person: { id: 'u-hugo' }, reason: 'On leave that whole week.' }] });
    await flush();
    expect(sent.map((s) => s.userId)).toEqual(['u-third']);
    expect(sent[0]!.item.title).toBe('You are now on: Coding for Senior Backend Engineer');
    // Hugo no longer has a seat, so the round is gone from his desk.
    expect((await HUGO.get(`/interviews/${id}`)).status).toBe(404);
  });

  it('after a panel member declines, the recruiter fills the seat; the accepted lead keeps the round accepted', async () => {
    const id = (await assign()).body.interview.id;
    await HUGO.post(`/interviews/${id}/answer`, { revision: 1, answer: 'accept' });
    await WEN.post(`/interviews/${id}/answer`, { revision: 2, answer: 'decline', reason: 'Clashes with my on-call week.' });
    const res = await GRETA.put(`/interviews/${id}/panel`, { revision: 3, leadId: 'u-hugo', panelIds: ['u-third'] });
    expect(res.body.interview).toMatchObject({ state: 'accepted', seats: [{ seat: 'lead', accepted: true }, { person: { id: 'u-third' }, seat: 'panel', accepted: false }] });
  });

  it('a stale revision is 409 with the row; the interviewer and the hiring manager cannot reassign; a live round cannot change', async () => {
    const stale = await GRETA.put('/interviews/iv-kwame-coding/panel', { revision: 7, leadId: 'u-wen', panelIds: [] });
    expect(stale.status).toBe(409);
    expect(stale.body.interview).toMatchObject({ id: 'iv-kwame-coding', revision: 1 });
    expect((await HUGO.put('/interviews/iv-kwame-coding/panel', { revision: 1, leadId: 'u-wen', panelIds: [] })).status).toBe(403);
    expect((await AMARA.put('/interviews/iv-kwame-coding/panel', { revision: 1, leadId: 'u-wen', panelIds: [] })).status).toBe(403);
    expect((await GRETA.put('/interviews/iv-jonah-leadership/panel', { revision: 1, leadId: 'u-hugo', panelIds: [] })).body.fields[0].path).toBe('state');
    expect((await GRETA.put('/interviews/iv-nowhere/panel', { revision: 1, leadId: 'u-hugo', panelIds: [] })).status).toBe(404);
  });
});

describe('the bell is shown only while the role is held', () => {
  it('an interviews bell reaches its audience\'s holders, and nobody who lost the role', async () => {
    const bell = { payload: { tenant: 'interviews', audience: 'interviewer' } };
    expect(await admitTenantNotification('u-hugo', bell)).toBe(true);
    expect(await admitTenantNotification('u-greta', bell)).toBe(false);
    expect(await admitTenantNotification('u-priya', bell)).toBe(false);
    (getUser as jest.Mock).mockImplementation(async (id: string) => (id === 'u-hugo' ? u('u-hugo', 'Hugo Marchetti', { orgiq: ['member'] }) : null));
    expect(await admitTenantNotification('u-hugo', bell)).toBe(false);
    expect(await admitTenantNotification('u-greta', { payload: { tenant: 'interviews', audience: 'recruiter' } })).toBe(false);
  });
});
