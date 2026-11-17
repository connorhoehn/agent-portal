// PUT /interviews/:id/questions (routes/interviews/prepare.ts; row I1.7, contract C6), mounted as index.ts mounts the tenant.
// The lead chooses; a panel member is refused (403); an interviewer with no seat does not find the round (404);
// the recruiter is refused (403); another tenant's session is refused at the mount.

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
beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const WEN = who('u-wen');
const OLA = who('u-third');
const readRow = async (as: ReturnType<typeof who>, id: string) => (await as.get(`/interviews/${id}`)).body.interview;

describe('PUT /interviews/:id/questions', () => {
  it('the lead chooses in order; the record shows the plan and the state follows the time and the plan', async () => {
    const before = await readRow(HUGO, 'iv-k1p5w8ra');
    expect(before).toMatchObject({ canPrepare: true, state: 'ready', missing: null });
    expect(before.bank.length).toBe(4);
    const r = await HUGO.put('/interviews/iv-k1p5w8ra/questions', { revision: before.revision, questionIds: ['q-be-retry', 'q-be-ratelimit'] });
    expect(r.status).toBe(200);
    expect(r.body.interview).toMatchObject({ state: 'ready', missing: null });
    expect(r.body.interview.questionsChosen.map((q: { id: string }) => q.id)).toEqual(['q-be-retry', 'q-be-ratelimit']);
    const cleared = await HUGO.put('/interviews/iv-k1p5w8ra/questions', { revision: r.body.interview.revision, questionIds: [] });
    expect(cleared.body.interview).toMatchObject({ state: 'accepted' });
  });

  it('a round with no time stays accepted after the plan is chosen, and the record says what it waits for', async () => {
    const id = 'iv-k1p5w8ra';
    const row = await readRow(HUGO, id);
    const at = await GRETA.put(`/interviews/${id}/time`, { revision: row.revision, scheduledAt: null });
    expect(at.status).toBe(200);
    const r = await HUGO.put(`/interviews/${id}/questions`, { revision: at.body.interview.revision, questionIds: ['q-be-retry'] });
    expect(r.body.interview).toMatchObject({ state: 'accepted', missing: 'Waiting for a time from the recruiter.' });
  });

  it('a recruiter clearing the time later does not leave a ready round that is not ready', async () => {
    const row = await readRow(HUGO, 'iv-k1p5w8ra');
    expect(row.state).toBe('ready');
    await GRETA.put('/interviews/iv-k1p5w8ra/time', { revision: row.revision, scheduledAt: null });
    expect((await readRow(HUGO, 'iv-k1p5w8ra')).state).toBe('accepted');
  });

  it('refuses a panel member (403), the recruiter (403) and an interviewer with no seat (404)', async () => {
    const body = { revision: 1, questionIds: ['q-be-retry'] };
    expect((await WEN.put('/interviews/iv-n5z9f2cq/questions', { ...body, questionIds: ['q-em-struggling'] })).status).toBe(200);
    const panel = await HUGO.put('/interviews/iv-n5z9f2cq/questions', { ...body, revision: 2, questionIds: ['q-em-slip'] });
    expect(panel.status).toBe(403);
    expect((await GRETA.put('/interviews/iv-k1p5w8ra/questions', body)).status).toBe(403);
    expect((await OLA.put('/interviews/iv-k1p5w8ra/questions', body)).status).toBe(404);
  });

  it('answers 400 in words for a question from the wrong kind of round, a repeat and a round not yet accepted; 409 when stale', async () => {
    const row = await readRow(HUGO, 'iv-k1p5w8ra');
    const wrong = await HUGO.put('/interviews/iv-k1p5w8ra/questions', { revision: row.revision, questionIds: ['q-be-incident'] });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/not saved/);
    expect(wrong.body.fields[0].message).toMatch(/technical/);
    expect((await HUGO.put('/interviews/iv-k1p5w8ra/questions', { revision: row.revision, questionIds: ['q-be-retry', 'q-be-retry'] })).status).toBe(400);
    expect((await HUGO.put('/interviews/iv-h4m7c3vu/questions', { revision: 1, questionIds: ['q-be-retry'] })).status).toBe(400);
    const stale = await HUGO.put('/interviews/iv-k1p5w8ra/questions', { revision: row.revision + 5, questionIds: ['q-be-retry'] });
    expect(stale.status).toBe(409);
    expect(stale.body.interview.id).toBe('iv-k1p5w8ra');
  });

  it('another tenant\'s session is refused at the mount', async () => {
    const other = who('u-priya', 'access', 'access-admin');
    expect([403, 404]).toContain((await other.put('/interviews/iv-k1p5w8ra/questions', { revision: 1, questionIds: [] })).status);
  });

  it('the plan names nothing of the opening\'s money', async () => {
    expect(JSON.stringify(await readRow(HUGO, 'iv-k1p5w8ra'))).not.toMatch(/budget|spent|capUsd/i);
  });
});
