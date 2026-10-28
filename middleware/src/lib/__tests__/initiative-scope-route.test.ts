// requireInitiativeScope: the route-level "may this caller act here" check
// (DE-44). Steward first; `spend` adds the grant verdict an SME spends under.

const users = new Map<string, { personId: string | null; grants: Record<string, string[]> }>([
  ['u-owner', { personId: 'p-001', grants: { orgiq: ['sme'] } }],
  ['u-stranger', { personId: 'p-009', grants: { orgiq: ['sme'] } }],
  ['u-leader', { personId: null, grants: { orgiq: ['org-leader'] } }],
]);
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(async (id: string) => users.get(id) ?? null) }));
jest.mock('../../providers/projects.js', () => ({
  getProject: jest.fn(async (id: string) => (id === 'p-auth' ? { id, ownerId: 'p-001', contributors: [] } : null)),
}));
const verdict = { value: { kind: 'allow' } as { kind: string; reason?: string } };
jest.mock('../bot-runner.js', () => ({ grantScopedDispatchVerdict: jest.fn(async () => verdict.value) }));

import { requireInitiativeScope, userReachesBox } from '../initiative-scope.js';

function res() {
  const out: { status?: number; body?: Record<string, unknown> } = {};
  return { out, res: { status(n: number) { out.status = n; return { json(b: unknown) { out.body = b as Record<string, unknown>; } }; } } };
}
const sme = (sub: string) => ({ session: { sub, role: 'sme', tenant: 'orgiq' } as never });

beforeEach(() => { verdict.value = { kind: 'allow' }; });

describe('requireInitiativeScope', () => {
  it('passes a steward and refuses someone attached nowhere, naming the initiative', async () => {
    expect(await requireInitiativeScope(sme('u-owner'), res().res, 'p-auth')).toBe(true);
    const r = res();
    expect(await requireInitiativeScope(sme('u-stranger'), r.res, 'p-auth', { action: 'run bots' })).toBe(false);
    expect(r.out.status).toBe(403);
    expect(r.out.body).toMatchObject({ initiativeId: 'p-auth', error: expect.stringContaining('run bots') });
  });

  it('lets an org-wide role through without a membership lookup, and refuses no session', async () => {
    expect(await requireInitiativeScope({ session: { sub: 'u-x', role: 'org-leader' } as never }, res().res, 'p-auth')).toBe(true);
    const r = res();
    expect(await requireInitiativeScope({ session: null }, r.res, 'p-auth')).toBe(false);
    expect(r.out.status).toBe(403);
  });

  it('does not scope an unattributed resource', async () => {
    expect(await requireInitiativeScope(sme('u-stranger'), res().res, null)).toBe(true);
  });

  it('spend: a steward without the grant is 403, unknown grant authority is 503', async () => {
    verdict.value = { kind: 'deny', reason: 'no active sprint grant' };
    const denied = res();
    expect(await requireInitiativeScope(sme('u-owner'), denied.res, 'p-auth', { spend: true })).toBe(false);
    expect(denied.out).toMatchObject({ status: 403, body: { error: 'no active sprint grant' } });
    verdict.value = { kind: 'unavailable', reason: 'grant authority unavailable' };
    const unknown = res();
    expect(await requireInitiativeScope(sme('u-owner'), unknown.res, 'p-auth', { spend: true })).toBe(false);
    expect(unknown.out.status).toBe(503);
    // Without `spend` the grant is never asked.
    expect(await requireInitiativeScope(sme('u-owner'), res().res, 'p-auth')).toBe(true);
  });
});

describe('userReachesBox', () => {
  it('its owner, a steward of its initiative, or an org-wide role; nobody else', async () => {
    expect(await userReachesBox('u-stranger', { ownerId: 'u-stranger' })).toBe(true);
    expect(await userReachesBox('u-owner', { ownerId: 'u-x', projectId: 'p-auth' })).toBe(true);
    expect(await userReachesBox('u-stranger', { ownerId: 'u-x', projectId: 'p-auth' })).toBe(false);
    expect(await userReachesBox('u-leader', { ownerId: 'u-x' })).toBe(true);
    expect(await userReachesBox('u-stranger', { ownerId: 'u-x' })).toBe(false);
    expect(await userReachesBox('u-unknown', { ownerId: null })).toBe(false);
  });
});
