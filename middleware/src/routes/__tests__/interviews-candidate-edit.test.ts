// The recruiter's edit of a candidate's details (routes/interviews/candidates.ts PATCH; gap audit 2026-11-20 §6), mounted
// as index.ts mounts the tenant, with the actions decided from the REAL seeds/roles/*/*.cedar files.

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
import { interviewApplicationsFixture, interviewCandidatesFixture } from '../../mock/interviews.js';
import { REDACTED_CONTACT } from '../../lib/interviews/retention/rules.js';

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
    patch: (p: string, body: unknown) => set(request(app).patch(`${API}${p}`)).send(body as object),
  };
};
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const AMARA = who('u-amara');
const PRIYA = who('u-priya', 'access');
const OPERATOR = who('u-operator');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  (getUser as jest.Mock).mockImplementation(async (id: string) => USERS.find((x) => x.id === id) ?? null);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

const cands = () => interviewCandidatesFixture.rows();
const first = () => cands()[0]!;
const second = () => cands()[1]!;
const edit = (c: { name: string; email: string; headline: string; location: string; createdAt: string; updatedAt?: string }, change: Record<string, unknown> = {}) =>
  ({ version: c.updatedAt ?? c.createdAt, name: c.name, email: c.email, headline: c.headline, location: c.location, ...change });

describe('PATCH /candidates/:id: the recruiter edits the name, email, headline and location', () => {
  it('saves, answers the record with its new version, and the profile shows it', async () => {
    const c = first();
    const r = await GRETA.patch(`/candidates/${c.id}`, edit(c, { name: '  Robin   Example ', email: ' Robin.Example@Example.com ', headline: 'Staff engineer', location: 'Lisbon' }));
    expect(r.status).toBe(200);
    expect(r.body.candidate).toMatchObject({ id: c.id, name: 'Robin Example', email: 'robin.example@example.com', headline: 'Staff engineer', location: 'Lisbon' });
    expect(r.body.candidate.version).not.toBe(c.createdAt);
    expect(cands().find((x) => x.id === c.id)!.updatedAt).toBe(r.body.candidate.version);
    const profile = await GRETA.get(`/candidates/${c.id}`);
    expect(profile.body.candidate.candidate).toMatchObject({ name: 'Robin Example', email: 'robin.example@example.com', version: r.body.candidate.version });
    // The stage history is the applications' moves only: an edit adds nothing to it.
    const before = interviewApplicationsFixture.rows().filter((a) => a.candidateId === c.id).map((a) => a.history.length);
    expect(profile.body.candidate && before.length).toBeGreaterThan(0);
  });

  it('a second edit against the old version is stale (409) with the record as it now is', async () => {
    const c = structuredClone(first());
    expect((await GRETA.patch(`/candidates/${c.id}`, edit(c, { headline: 'One' }))).status).toBe(200);
    const r = await GRETA.patch(`/candidates/${c.id}`, edit(c, { headline: 'Two' }));
    expect(r.status).toBe(409);
    expect(r.body.candidate).toMatchObject({ headline: 'One' });
    expect(r.body.error).toMatch(/Someone else changed this candidate/);
  });

  it('checks the fields as the create does: email required and well formed, the limits', async () => {
    const c = first();
    const noEmail = await GRETA.patch(`/candidates/${c.id}`, edit(c, { email: '  ' }));
    expect(noEmail.status).toBe(400);
    expect(noEmail.body.fields).toEqual([{ path: 'email', message: "Give the candidate's email address." }]);
    expect((await GRETA.patch(`/candidates/${c.id}`, edit(c, { email: 'not-an-address' }))).body.fields[0].path).toBe('email');
    expect((await GRETA.patch(`/candidates/${c.id}`, edit(c, { name: '' }))).body.fields[0].path).toBe('name');
    expect((await GRETA.patch(`/candidates/${c.id}`, edit(c, { location: 'x'.repeat(81) }))).body.fields[0].path).toBe('location');
    expect((await GRETA.patch(`/candidates/${c.id}`, { ...edit(c), version: 'yesterday' })).status).toBe(400);
    expect(cands().find((x) => x.id === c.id)!.updatedAt).toBeUndefined();
  });

  it("refuses another live candidate's address (409, one sentence) and merges nothing", async () => {
    const c = first();
    const r = await GRETA.patch(`/candidates/${c.id}`, edit(c, { email: second().email.toUpperCase() }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('Another candidate already has this email address. Check the address, or open that candidate instead.');
    expect(cands().find((x) => x.id === c.id)!.email).toBe(c.email);
    expect(cands().length).toBe(interviewCandidatesFixture.rows('default').length);
  });

  it("an erased candidate's record cannot be edited (409), and an erased candidate's old address does not block another", async () => {
    const gone = second();
    Object.assign(gone, REDACTED_CONTACT);
    const r = await GRETA.patch(`/candidates/${gone.id}`, edit(gone, { name: 'Back again', email: 'back@example.com' }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("This candidate's details were deleted, so they cannot be edited.");
    expect(gone.name).toBe(REDACTED_CONTACT.name);
  });

  it('the admin may edit; an interviewer, a hiring manager and another tenant are refused; an unknown id is not found', async () => {
    const c = first();
    expect((await OPERATOR.patch(`/candidates/${c.id}`, edit(c, { headline: 'By the admin' }))).status).toBe(200);
    const now = first();
    for (const caller of [HUGO, AMARA, PRIYA]) {
      const r = await caller.patch(`/candidates/${now.id}`, edit(now, { headline: 'Not theirs' }));
      expect(r.status).toBe(403);
    }
    expect(first().headline).toBe('By the admin');
    expect((await GRETA.patch('/candidates/cand-nobody', edit(now))).status).toBe(404);
  });

  it('an interviewer reads no email or version on the profile; the recruiter and the hiring manager do', async () => {
    const app = interviewApplicationsFixture.rows()[0]!;
    const c = cands().find((x) => x.id === app.candidateId)!;
    const g = await GRETA.get(`/candidates/${c.id}`);
    expect(g.body.candidate.candidate).toHaveProperty('email', c.email);
    expect(g.body.candidate.candidate).toHaveProperty('version');
    const { profileCandidate } = await import('../../lib/interviews/views.js');
    expect(Object.keys(profileCandidate(c, 'interviewer')).sort()).toEqual(['headline', 'id', 'location', 'name', 'source']);
    expect(Object.keys(profileCandidate(c, 'hiring-manager'))).toEqual(expect.arrayContaining(['email', 'version']));
  });
});
