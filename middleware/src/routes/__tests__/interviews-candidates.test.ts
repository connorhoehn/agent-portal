// Add a candidate (routes/interviews/candidates.ts; UI round 2, lane DESK-B, contract U13), mounted as index.ts mounts the
// tenant, with ManageCandidates decided from the real Cedar seeds: only the recruiter (and the admin) writes; the order of
// checks is the openings' (authority 403, the opening 404, the input 400, the duplicate 409, then the write 201).

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
jest.mock('../../providers/identity.js', () => ({ ...jest.requireActual('../../providers/identity.js'), listUsers: jest.fn() }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { requireTenant } from '../../lib/authz.js';
import { listUsers, type UserInfo } from '../../providers/identity.js';
import { interviewsFlagGate, interviewsRouter } from '../interviews.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { DuplicateCandidateError, MemoryInterviewsStore } from '../../lib/interviews/store.js';
import type { Session } from '../../lib/session.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
  u('u-wen', 'Wen Zhao', { interviews: ['interviewer'] }),
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

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});


const BODY = { name: 'Nadia Petrova', email: 'Nadia.Petrova@mail.example', headline: 'Staff engineer, payments', location: 'Prague', source: 'Referral', openingId: 'op-backend' };

describe('add a candidate', () => {
  it('creates the candidate and an application at the first stage with one history entry, and the list shows them', async () => {
    const res = await GRETA.post('/candidates', BODY);
    expect(res.status).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.candidate).toMatchObject({ name: 'Nadia Petrova', email: 'nadia.petrova@mail.example', headline: 'Staff engineer, payments', location: 'Prague', source: 'Referral', resumeFileId: null });
    expect(res.body.application).toMatchObject({ candidateId: res.body.candidate.id, openingId: 'op-backend', stage: 'applied' });
    expect(res.body.application.history).toEqual([{ stage: 'applied', at: res.body.application.appliedAt, by: 'u-greta', reason: null }]);
    const list = (await GRETA.get('/candidates')).body.items as Array<{ candidate: { id: string }; opening: { id: string }; stage: string }>;
    expect(list.find((r) => r.candidate.id === res.body.candidate.id)).toMatchObject({ opening: { id: 'op-backend' }, stage: 'applied' });
    expect((await GRETA.get(`/candidates/${res.body.candidate.id}`)).status).toBe(200);
  });

  it('answers one sentence per bad field with a 400, and writes nothing', async () => {
    const before = (await GRETA.get('/candidates')).body.items.length;
    const res = await GRETA.post('/candidates', { ...BODY, name: '  ', email: 'not-an-email', location: 'x'.repeat(81) });
    expect(res.status).toBe(400);
    expect(res.body.fields.map((f: { path: string }) => f.path)).toEqual(['name', 'email', 'location']);
    expect(res.body.fields.every((f: { message: string }) => /^[A-Z].*\.$/.test(f.message))).toBe(true);
    expect((await GRETA.post('/candidates', { ...BODY, openingId: '' })).body.fields).toEqual([{ path: 'openingId', message: 'Choose the opening the candidate is applying to.' }]);
    expect((await GRETA.get('/candidates')).body.items.length).toBe(before);
  });

  it('refuses the same email on the same opening with a 409, whatever its case, and allows it on another opening', async () => {
    expect((await GRETA.post('/candidates', BODY)).status).toBe(201);
    const again = await GRETA.post('/candidates', { ...BODY, email: 'NADIA.PETROVA@mail.example' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('This person is already a candidate for this opening.');
    expect((await GRETA.post('/candidates', { ...BODY, openingId: 'op-ios' })).status).toBe(201);
  });

  it('answers the same 409 when the store\'s unique rule stops a second add that passed the check at the same moment (hardening H5)', async () => {
    const spy = jest.spyOn(MemoryInterviewsStore.prototype, 'createCandidate').mockRejectedValueOnce(new DuplicateCandidateError());
    try {
      const raced = await GRETA.post('/candidates', BODY);
      expect(raced.status).toBe(409);
      expect(raced.body.error).toBe('This person is already a candidate for this opening.');
    } finally { spy.mockRestore(); }
  });

  it('answers 404 for an opening that is not there', async () => {
    const res = await GRETA.post('/candidates', { ...BODY, openingId: 'op-nowhere' });
    expect(res.status).toBe(404);
  });

  it('refuses everyone but the recruiter and the admin, with the same 403, before the opening or the input', async () => {
    for (const who of [HUGO, AMARA]) {
      expect((await who.post('/candidates', BODY)).status).toBe(403);
      expect((await who.post('/candidates', {})).status).toBe(403);
    }
    expect((await WEN.post('/candidates', { ...BODY, openingId: 'op-nowhere' })).status).toBe(403);
    expect((await who('u-operator', 'interviews', 'admin').post('/candidates', BODY)).status).toBe(201);
  });
});
