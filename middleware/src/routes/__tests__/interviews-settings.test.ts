// The tenant's read-only Settings (routes/interviews/settings.ts; gap audit 2026-11-20, minor), mounted as index.ts mounts
// the tenant, with ManageCandidates decided from the real Cedar seeds: the recruiter and the admin read it; everyone else
// in the tenant reads the not-found.

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

const get = (id: string, tenant = 'interviews', role?: string) => {
  const r = request(app).get('/api/interviews/settings').set('x-user', id).set('x-tenant', tenant);
  return role ? r.set('x-role', role) : r;
};

beforeEach(() => {
  (listUsers as jest.Mock).mockResolvedValue(USERS);
  delete process.env['INTERVIEWS_ENABLED'];
  fixtureRegistry.resetAll('default');
});

describe('the read-only settings', () => {
  it('gives the recruiter every setting in force, grouped, read only', async () => {
    const res = await get('u-greta');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const items = res.body.items as Array<{ name: string; group: string; about: string; value: unknown; default: unknown }>;
    const byName = new Map(items.map((i) => [i.name, i]));
    expect(byName.get('INTERVIEWS_MEDIA_RETENTION_DAYS')).toMatchObject({ group: 'retention', value: expect.any(Number) });
    expect(byName.get('INTERVIEWS_RECORD_RETENTION_YEARS')).toMatchObject({ group: 'retention' });
    expect(byName.get('INTERVIEWS_DELETION_WITHIN_DAYS')).toMatchObject({ group: 'retention' });
    expect(byName.get('INTERVIEWS_REQUIRED_CONSENTS')).toMatchObject({ group: 'consent', value: expect.any(Array) });
    expect(byName.get('INTERVIEWS_RUN_BACKEND')).toMatchObject({ group: 'runner' });
    expect(byName.get('INTERVIEWS_SOON_MINUTES')).toMatchObject({ group: 'other' });
    expect(items.every((i) => /^[A-Z]/.test(i.about))).toBe(true);
  });

  it('reads the values the code uses: a period set in the environment shows as set', async () => {
    process.env['INTERVIEWS_MEDIA_RETENTION_DAYS'] = '45';
    try {
      const items = (await get('u-greta')).body.items as Array<{ name: string; value: unknown }>;
      expect(items.find((i) => i.name === 'INTERVIEWS_MEDIA_RETENTION_DAYS')!.value).toBe(45);
    } finally { delete process.env['INTERVIEWS_MEDIA_RETENTION_DAYS']; }
  });

  it('sends only whether a Code Interpreter is set, never its identifier', async () => {
    process.env['INTERVIEWS_CODE_INTERPRETER_ID'] = 'example-interpreter-0001';
    try {
      const res = await get('u-greta');
      expect(res.text).not.toContain('example-interpreter-0001');
      expect((res.body.items as Array<{ name: string; value: unknown }>).find((i) => i.name === 'INTERVIEWS_CODE_INTERPRETER_ID')!.value).toBe('set');
    } finally { delete process.env['INTERVIEWS_CODE_INTERPRETER_ID']; }
    expect(((await get('u-greta')).body.items as Array<{ name: string; value: unknown }>).find((i) => i.name === 'INTERVIEWS_CODE_INTERPRETER_ID')!.value).toBe('');
  });

  it('the admin reads it too', async () => {
    expect((await get('u-operator', 'interviews', 'admin')).status).toBe(200);
  });

  it('an interviewer and a hiring manager read the tenant\'s not-found', async () => {
    for (const id of ['u-hugo', 'u-wen', 'u-amara']) {
      const res = await get(id);
      expect(res.status).toBe(404);
      expect(res.body).not.toHaveProperty('items');
    }
  });

  it('another tenant\'s role and no session are refused at the mount', async () => {
    expect([401, 403, 404]).toContain((await get('u-priya', 'access')).status);
    expect([401, 403, 404]).toContain((await request(app).get('/api/interviews/settings')).status);
  });

  it('there is no way to write a setting', async () => {
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/api/interviews/settings').set('x-user', 'u-greta').set('x-tenant', 'interviews')).status).toBe(404);
    }
  });
});
