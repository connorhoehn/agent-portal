// A candidate's deletion request and deletion log (routes/interviews/retention.ts; docs/interviews-tenant-plan.md row I6.3),
// mounted as index.ts mounts the tenant.
//
//   recruiter       asks for a deletion (confirmed), reads the log
//   hiring-manager  reads the log of their own opening's candidates; asking is refused (403)
//   interviewer     asking refused (403); the log is not found
//   admin           not found on both
//   another tenant  the tenant's refusal at the mount
// The recording service is not configured here (the mock world), so the log says there was nothing to call.

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
import type { Session } from '../../lib/session.js';
import { resumeRows, setResumeStores } from '../../lib/interviews/resume/service.js';
import { MemoryResumeBytes } from '../../lib/interviews/resume/bytes-store.js';
import { interviewCandidatesFixture } from '../../mock/interviews.js';
import { interviewConsentsFixture } from '../../mock/interviews-consents.js';
import { registerEraser } from '../../lib/interviews/retention/registry.js';
import { recordingEraser } from '../../lib/interviews/retention/erasers.js';

const u = (id: string, displayName: string, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName, email: null, personId: null, epoch: 0, grants });
const USERS: UserInfo[] = [
  u('u-greta', 'Greta Lindqvist', { interviews: ['recruiter'] }),
  u('u-hugo', 'Hugo Marchetti', { interviews: ['interviewer'] }),
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
const who = (id: string, tenant = 'interviews') => ({
  ask: (cand: string, body: unknown = { confirm: true }) => request(app).post(`${API}/candidates/${cand}/deletion`).set('x-user', id).set('x-tenant', tenant).send(body as object),
  log: (cand: string) => request(app).get(`${API}/candidates/${cand}/deletions`).set('x-user', id).set('x-tenant', tenant),
});
const GRETA = who('u-greta');
const HUGO = who('u-hugo');
const AMARA = who('u-amara');
const ADMIN = who('u-operator');
const OUTSIDER = who('u-priya', 'access');

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
  setResumeStores({ rows: null, bytes: new MemoryResumeBytes() });
  registerEraser(recordingEraser({ env: {} }));
});
afterAll(() => setResumeStores({ rows: null, bytes: null }));

describe('asking for a deletion', () => {
  it('the recruiter asks, with confirmation, and gets the log row; a second ask changes nothing', async () => {
    expect((await GRETA.ask('cand-mateo', {})).status).toBe(400);
    expect((await GRETA.ask('cand-mateo', { confirm: 'yes' })).status).toBe(400);
    expect(interviewCandidatesFixture.rows().find((c) => c.id === 'cand-mateo')!.email).toBe('mateo.alvarez@mail.example');
    const res = await GRETA.ask('cand-mateo');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.created).toBe(true);
    expect(res.body.deletion).toMatchObject({
      reason: 'request', requestedBy: { id: 'u-greta', name: 'Greta Lindqvist' }, interviews: 2,
      removed: [{ kind: 'resume', count: 1 }, { kind: 'contact-details', count: 1 }],
      left: [{ kind: 'recording', why: 'no-service', retry: false }],
    });
    expect(res.body.deletion.doneAt).not.toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/iv-mateo|Álvarez|mail\.example/);
    expect(await resumeRows().get('cand-mateo')).toBeNull();
    expect(interviewConsentsFixture.rows().some((c) => c.interviewId === 'iv-mateo-coding')).toBe(true);
    const again = await GRETA.ask('cand-mateo');
    expect(again.body).toEqual({ deletion: res.body.deletion, created: false });
  });

  it('the profile shows what the redaction left', async () => {
    await GRETA.ask('cand-mateo');
    const res = await request(app).get(`${API}/candidates/cand-mateo`).set('x-user', 'u-greta');
    expect(res.status).toBe(200);
    expect(res.body.candidate.candidate).toMatchObject({ name: 'Name removed', location: '', headline: '' });
  });

  it('everyone but the recruiter is refused, and a recruiter asking about a candidate that is not there gets not-found', async () => {
    expect((await HUGO.ask('cand-mateo')).status).toBe(403);
    expect((await AMARA.ask('cand-mateo')).status).toBe(403);
    expect((await ADMIN.ask('cand-mateo')).status).toBe(404);
    expect((await GRETA.ask('cand-nobody')).status).toBe(404);
    expect((await OUTSIDER.ask('cand-mateo')).status).toBe(403);
    expect(interviewCandidatesFixture.rows().find((c) => c.id === 'cand-mateo')!.name).toBe('Mateo Álvarez');
  });
});

describe('reading the deletion log', () => {
  it('the recruiter and the opening\'s hiring manager read it, newest first; nobody else finds it', async () => {
    expect((await GRETA.log('cand-mateo')).body).toEqual({ items: [] });
    await GRETA.ask('cand-mateo');
    const greta = await GRETA.log('cand-mateo');
    expect(greta.status).toBe(200);
    expect(greta.body.items).toHaveLength(1);
    expect((await AMARA.log('cand-mateo')).body).toEqual(greta.body);
    expect((await HUGO.log('cand-mateo')).status).toBe(404);
    expect((await ADMIN.log('cand-mateo')).status).toBe(404);
    expect((await GRETA.log('cand-nobody')).status).toBe(404);
    expect((await OUTSIDER.log('cand-mateo')).status).toBe(403);
  });

  it('a hiring manager of another opening finds nothing', async () => {
    expect((await AMARA.log('cand-aiko')).status).toBe(404);
  });

  it('with INTERVIEWS_ENABLED off both are not found', async () => {
    process.env['INTERVIEWS_ENABLED'] = '0';
    expect((await GRETA.ask('cand-mateo')).status).toBe(404);
    expect((await GRETA.log('cand-mateo')).status).toBe(404);
  });
});
