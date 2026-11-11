// POST /api/graph/projects — starting an initiative by hand (docs/create-initiative-design.md).
//
// Mounted the way index.ts mounts it (the real requireTenant) over the REAL Cedar
// seeds in open mode and the real mock provider, so the suite pins who may create,
// what is written, and that the result is readable through the same GET the page uses.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' }, cognito: {}, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => jest.requireActual('../../test-support/seed-roles').seedRoleRegistry() }));
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import express from 'express';
import request from '../../test-support/http.js';
import { projectsRouter } from '../projects.js';
import { requireTenant } from '../../lib/authz.js';
import { type Session } from '../../lib/session.js';
import { initiatives } from '../../mock/initiatives.js';
import { getProject } from '../../providers/projects.js';
import { personOnInitiative } from '../../lib/initiative-scope.js';

// Directory rows (providers/identity.ts FALLBACK_USERS): u-release is p-005, u-mia is p-030.
function app(session: Partial<Session>) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.session = { sub: 'u-test', role: 'member', tenant: 'orgiq', grants: {}, iat: 0, ...session } as Session;
    next();
  });
  a.use('/api/graph/projects', requireTenant('orgiq'), projectsRouter);
  return a;
}
const as = (role: string, sub: string, tenant = 'orgiq') => app({ sub, role: role as Session['role'], tenant: tenant as Session['tenant'] });
const leader = () => as('org-leader', 'u-release');
const owner = () => as('program-owner', 'u-mia');

beforeEach(() => { initiatives.reset(); });

describe('who may create', () => {
  it.each(['member', 'sme', 'hr-admin'])('%s is refused', async (role) => {
    const before = initiatives.rows().length;
    const res = await request(as(role, 'u-theo')).post('/api/graph/projects').send({ name: 'Refused Initiative' });
    expect(res.status).toBe(403);
    expect(initiatives.rows().length).toBe(before);
  });

  it.each([['org-leader', 'u-release'], ['program-owner', 'u-mia']])('%s succeeds', async (role, sub) => {
    const res = await request(as(role, sub)).post('/api/graph/projects').send({ name: `By ${role}` });
    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^p-by-/);
  });

  it('a caller parked in the assessment tenant is refused, whatever the role', async () => {
    const res = await request(as('org-leader', 'u-release', 'assessment')).post('/api/graph/projects').send({ name: 'Elsewhere' });
    expect([401, 403]).toContain(res.status);
    expect(initiatives.rows().some((p) => p.name === 'Elsewhere')).toBe(false);
  });
});

describe('what is made', () => {
  it('defaults the owner to the caller, makes them a contributor, starts in planning, and reads back through GET', async () => {
    const res = await request(leader()).post('/api/graph/projects').send({ name: '  Fresh Start  ', summary: 'Why it exists', repo: 'acme/fresh-start' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'p-fresh-start', name: 'Fresh Start', status: 'planning', summary: 'Why it exists', ownerId: 'p-005', repoFullName: 'acme/fresh-start' });
    expect(res.body.contributors.map((c: { personId: string; role: string }) => [c.personId, c.role])).toEqual([['p-005', 'owner']]);

    const read = await request(leader()).get('/api/graph/projects/p-fresh-start');
    expect(read.status).toBe(200);
    expect(read.body.name).toBe('Fresh Start');
    expect(await personOnInitiative('p-005', 'p-fresh-start')).toBe(true);
    const list = await request(leader()).get('/api/graph/projects');
    expect(list.body.map((p: { id: string }) => p.id)).toContain('p-fresh-start');
  });

  it('names another person from the directory as owner and a sponsor, and refuses an unknown owner', async () => {
    const ok = await request(leader()).post('/api/graph/projects').send({ name: 'Handed Over', owner_person_id: 'p-002', sponsor_person_id: 'p-030' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ ownerId: 'p-002', sponsorId: 'p-030' });
    const bad = await request(leader()).post('/api/graph/projects').send({ name: 'Nobody Owns', owner_person_id: 'p-does-not-exist' });
    expect(bad.status).toBe(400);
    expect((await getProject('p-nobody-owns'))).toBeNull();
  });

  it('ignores unknown fields, including an id the caller tries to choose', async () => {
    const res = await request(owner()).post('/api/graph/projects').send({ name: 'Own Id', id: 'p-observability', status: 'completed', budget: 9 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: 'p-own-id', status: 'planning' });
  });

  it('numbers a colliding id and refuses a name that differs only in case, naming the existing initiative', async () => {
    const a = await request(leader()).post('/api/graph/projects').send({ name: 'Twin Name' });
    expect(a.body.id).toBe('p-twin-name');
    const dup = await request(leader()).post('/api/graph/projects').send({ name: 'twin NAME' });
    expect(dup.status).toBe(409);
    expect(dup.body).toMatchObject({ code: 'NAME_TAKEN', existingId: 'p-twin-name' });
    const seeded = await request(leader()).post('/api/graph/projects').send({ name: 'auth migration' });
    expect(seeded.status).toBe(409);
    expect(seeded.body.existingId).toBe('p-auth-migration');
    // Different names that slug alike collide on the id, not the name: the id takes a number.
    const b = await request(leader()).post('/api/graph/projects').send({ name: 'Twin  Name!' });
    expect(b.status).toBe(201);
    expect(b.body.id).toBe('p-twin-name-2');
  });
});

describe('validation', () => {
  it.each([
    [{}, 'no name'],
    [{ name: '   ' }, 'blank name'],
    [{ name: 'x'.repeat(81) }, 'name over 80'],
    [{ name: 'Ok', summary: 'x'.repeat(601) }, 'summary over 600'],
    [{ name: 'Ok', repo: 'not a repo' }, 'repo without a slash'],
    [{ name: 'Ok', repo: 'a/b/c' }, 'repo with two slashes'],
    [{ name: 'Ok', repo: `a/${'b'.repeat(140)}` }, 'repo over 140'],
    [{ name: 'Ok', repo: 'ow ner/name' }, 'repo with a space'],
  ] as Array<[Record<string, unknown>, string]>)('%j is refused (%s)', async (body) => {
    const before = initiatives.rows().length;
    const res = await request(leader()).post('/api/graph/projects').send(body);
    expect(res.status).toBe(400);
    expect(initiatives.rows().length).toBe(before);
  });

  it('accepts a name of exactly 80 characters and a summary of exactly 600', async () => {
    const res = await request(leader()).post('/api/graph/projects').send({ name: 'n'.repeat(80), summary: 's'.repeat(600) });
    expect(res.status).toBe(201);
    expect(res.body.id.length).toBeLessThanOrEqual(42);
  });
});
