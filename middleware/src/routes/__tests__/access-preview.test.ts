// /api/access/requests/preview and /api/access/beneficiaries — the request
// page's summary reads (docs/access-tenant-api.md "Request page — preview and
// beneficiaries"). Same harness as access.test.ts: `requireTenant('access')` at
// the mount, Cedar decided from the REAL seeds/roles/access/*.cedar files, the
// registered fixtures as the store, the directory mocked per case. The preview
// runs the submit's own checks (`assessSubmission`) and writes nothing.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '', cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => {
  // The role → action matrix the open-mode authz derives from the Cedar seeds,
  // read from the access tenant's actual files (role-registry.ts itself cannot
  // load under jest: it resolves its directory with import.meta.url).
  const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
  const path = jest.requireActual<typeof import('node:path')>('node:path');
  const dir = path.join(__dirname, '..', '..', '..', 'seeds', 'roles', 'access');
  const roles = fs.readdirSync(dir).filter((f: string) => f.endsWith('.cedar')).map((f: string) => {
    const cedar = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\/[^\n]*/g, '');
    const caps = new Set<string>();
    for (const block of cedar.split(/\bpermit\b/).slice(1)) {
      for (const m of (block.split(';')[0] ?? '').matchAll(/OrgIQ::Action::"([^"]+)"/g)) caps.add(m[1]!);
    }
    return { id: f.replace(/\.cedar$/, ''), tenant: 'access', label: '', summary: '', capabilities: [...caps] };
  });
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
import { accessRouter } from '../access.js';
import { accessCatalogFixture } from '../../mock/access-catalog.js';
import { accessPoliciesFixture } from '../../mock/access-policies.js';
import { accessPeopleFixture } from '../../mock/access-people.js';
import { accessEventsFixture, accessRequestsFixture, accessStepsFixture } from '../../mock/access-requests.js';
import { accessNow } from '../../providers/access.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { initiatives } from '../../mock/initiatives.js';
import type { AccessRequestPreview, Person } from '../../lib/access/types.js';
import type { Session } from '../../lib/session.js';

const u = (id: string, personId: string | null, grants: Record<string, string[]>): UserInfo =>
  ({ id, displayName: id, email: null, personId, epoch: 0, grants });
const BASE: UserInfo[] = [
  u('u-rhea', 'p-rhea', { access: ['requester'] }),
  u('u-omar', 'p-omar', { access: ['approver'] }),
  u('u-priya', 'p-priya', { access: ['access-admin'] }),
  u('u-nora', 'p-004', { orgiq: ['sme'], social: ['participant'] }),
  u('u-hr', null, { orgiq: ['hr-admin'] }),
  u('u-vera', 'p-002', { orgiq: ['org-leader', 'member'] }),
  u('u-dara', null, { pipelines: ['pipeline-admin'] }),
  u('u-operator', null, { orgiq: ['admin'], access: ['admin'] }),
];
let users: UserInfo[];

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const id = String(req.headers['x-user'] ?? '');
  const me = users.find((x) => x.id === id);
  if (me) {
    const tenant = String(req.headers['x-tenant'] ?? 'access');
    const role = String(req.headers['x-role'] ?? me.grants[tenant]?.[0] ?? 'none');
    req.session = { sub: id, tenant, role, grants: me.grants, iat: 0, epoch: 0 } as Session;
  }
  next();
});
app.use('/api/access', requireTenant('access'), accessRouter);
app.use(errorHandler);

const get = (path: string, as: string, headers: Record<string, string> = {}) => request(app).get(path).set({ 'x-user': as, ...headers });
const post = (path: string, as: string, body: unknown) => request(app).post(path).set('x-user', as).send(body as object);

beforeEach(() => {
  for (const f of [accessCatalogFixture, accessPoliciesFixture, accessPeopleFixture, accessRequestsFixture, accessStepsFixture, accessEventsFixture, identityGrantWritesFixture, initiatives]) f.reset();
  users = structuredClone(BASE);
  jest.mocked(listUsers).mockImplementation(async () => structuredClone(users));
});

const preview = (as: string, body: unknown) => post('/api/access/requests/preview', as, body);
const pv = (res: { body: unknown }) => res.body as AccessRequestPreview;
const HOUR = 3_600_000;

describe('POST /requests/preview', () => {
  it('a requester sees the chain, the beneficiary, the expiry and a clear SoD verdict; nothing is written', async () => {
    const before = [accessRequestsFixture.rows().length, accessStepsFixture.rows().length, accessEventsFixture.rows().length];
    const res = await preview('u-rhea', { itemId: 'role:assessment:assessor', duration: '24h' });
    expect(res.status).toBe(200);
    const p = pv(res);
    expect(p).toMatchObject({ item: { id: 'role:assessment:assessor' }, beneficiary: { id: 'u-rhea' }, duration: '24h', sod: { verdict: 'clear', conflicts: [] }, refusal: null });
    expect(p.steps.map((s) => [s.step, s.kind, s.eligible.map((x) => x.id)])).toEqual([[1, 'manager', ['u-omar']], [2, 'steward', ['u-priya']]]);
    expect(p.steps[1]!.escalated).toMatch(/^Escalated to the access admins/);
    // The mock clock moves with wall time: the expiry is 24 h after a moment inside the call.
    const after = Date.parse(accessNow());
    expect(Date.parse(p.expiresIfProvisionedNow!) - after).toBeLessThanOrEqual(24 * HOUR);
    expect(Date.parse(p.expiresIfProvisionedNow!) - after).toBeGreaterThan(24 * HOUR - 60_000);
    expect([accessRequestsFixture.rows().length, accessStepsFixture.rows().length, accessEventsFixture.rows().length]).toEqual(before);
  });
  it('the duration defaults to the item\'s; standing has no expiry; a sensitive item adds the access-admin step', async () => {
    const d = pv(await preview('u-rhea', { itemId: 'role:assessment:lead-assessor' }));
    expect(d.duration).toBe(d.item.defaultDuration);
    expect(d.steps.map((s) => s.kind)).toEqual(['manager', 'steward', 'access-admin']);
    expect(pv(await preview('u-rhea', { itemId: 'role:assessment:assessor', duration: 'standing' })).expiresIfProvisionedNow).toBeNull();
  });
  it('a duplicate open request is a 409 refusal naming it; an already-held item is one too', async () => {
    expect(pv(await preview('u-rhea', { itemId: 'role:orgiq:sme' })).refusal).toEqual({ status: 409, error: expect.stringContaining('req-0001'), requestId: 'req-0001' });
    expect(pv(await preview('u-priya', { itemId: 'role:orgiq:sme', beneficiaryId: 'u-nora' })).refusal).toMatchObject({ status: 409, error: expect.stringMatching(/already holds/) });
  });
  it('an SoD block rides in sod and refusal, against the BENEFICIARY\'s grants', async () => {
    const res = await preview('u-priya', { itemId: 'role:orgiq:org-leader', beneficiaryId: 'u-nora' });
    expect(res.status).toBe(200);
    expect(pv(res).sod).toMatchObject({ verdict: 'block', conflicts: [{ policyId: 'sod-001', severity: 'block' }] });
    expect(pv(res).refusal).toMatchObject({ status: 409, error: expect.stringMatching(/^Separation of duties blocks/) });
    // Priya holds no orgiq grant herself: the catalog view (the actor's) has no conflict.
    expect(pv(res).item.sodConflicts).toEqual([]);
  });
  it('on behalf: a requester is refused 403; an approver previews for a report; not for a stranger', async () => {
    expect((await preview('u-rhea', { itemId: 'role:assessment:assessor', beneficiaryId: 'u-omar' })).status).toBe(403);
    expect((await preview('u-omar', { itemId: 'role:assessment:assessor', beneficiaryId: 'u-priya' })).status).toBe(403);
    const res = await preview('u-omar', { itemId: 'role:assessment:assessor', beneficiaryId: 'u-rhea' });
    expect(res.status).toBe(200);
    // Omar files it, so the manager step escalates past him, as the submit would.
    expect(pv(res)).toMatchObject({ beneficiary: { id: 'u-rhea' }, steps: [{ kind: 'manager', eligible: [{ id: 'u-priya' }] }, { kind: 'steward' }] });
  });
  it('400s: an unknown key, no item, an unknown item, a bad duration, an unknown beneficiary', async () => {
    expect((await preview('u-rhea', { itemId: 'role:assessment:assessor', justification: 'x' })).status).toBe(400);
    expect((await preview('u-rhea', {})).status).toBe(400);
    expect((await preview('u-rhea', { itemId: 'role:orgiq:admin' })).status).toBe(400);
    expect((await preview('u-rhea', { itemId: 'role:assessment:assessor', duration: 'forever' })).status).toBe(400);
    expect((await preview('u-priya', { itemId: 'role:assessment:assessor', beneficiaryId: 'u-nobody' })).status).toBe(400);
    expect((await preview('u-priya', { itemId: 'role:assessment:assessor', beneficiaryId: 7 })).status).toBe(400);
  });
  it('needs RequestAccess and the access tenant', async () => {
    expect((await preview('u-nobody', { itemId: 'role:assessment:assessor' })).status).toBe(403);
    expect((await request(app).post('/api/access/requests/preview').set({ 'x-user': 'u-nora', 'x-tenant': 'orgiq' }).send({ itemId: 'role:assessment:assessor' })).status).toBe(403);
  });
});

describe('GET /beneficiaries', () => {
  const people = async (as: string) => ((await get('/api/access/beneficiaries', as)).body as { items: Person[] }).items.map((p) => p.id);
  it('a requester files only for herself', async () => {
    expect(await people('u-rhea')).toEqual(['u-rhea']);
  });
  it('an approver adds his direct reports (people.manager_id)', async () => {
    expect(await people('u-omar')).toEqual(['u-omar', 'u-rhea']);
  });
  it('an access admin may file for anyone holding a grant, self first', async () => {
    const all = await people('u-priya');
    expect(all[0]).toBe('u-priya');
    expect(new Set(all)).toEqual(new Set(BASE.map((x) => x.id)));
    expect(all.slice(1)).toEqual([...all.slice(1)].sort());
  });
});
