// PROVING THE GRANTS INVARIANT CAN FAIL.
//
// `every grant names a role its tenant actually has` is green against the
// seeded cast, and green proves nothing on its own — so this file feeds the
// invariant a cast that is wrong in each of the two ways it claims to catch,
// and requires the failure to name the role, the tenant, and what the tenant's
// roles really are.
//
// The identity provider is mocked here (and only here) because that is the
// half of the pair being perturbed. The ROLES are not mocked: they are read
// off `middleware/seeds/roles/**` by ../cedar-roles.ts on every run, so a role
// deleted from disk changes what this test sees — which is the point.

jest.mock('../../../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../../../config.js', () => ({
  config: {
    mock: { aurora: true, cloudwatch: true, guardrails: false, agentcore: true },
    region: 'us-east-1',
    aurora: {},
  },
}));

const listUsers = jest.fn();
jest.mock('../../../../providers/identity.js', () => ({
  listUsers,
  listTenants: jest.fn(async () => [
    { id: 'orgiq', displayName: 'OrgIQ', status: 'ACTIVE' },
    { id: 'assessment', displayName: 'Assessment', status: 'ACTIVE' },
  ]),
}));

import { SURFACE_INVARIANTS } from '../invariants.js';
import { crossTenantRoles, rolesByTenant } from '../cedar-roles.js';

const invariant = SURFACE_INVARIANTS.find((i) => i.name === 'every grant names a role its tenant actually has')!;
const ctx = { app: async () => { throw new Error('this invariant needs no express app'); } } as never;

/** A cast that holds exactly the roles seeds/roles/** defines, and nothing else. */
function completeCast(): Array<{ id: string; grants: Record<string, string[]> }> {
  const out: Array<{ id: string; grants: Record<string, string[]> }> = [];
  for (const [tenant, roles] of rolesByTenant()) {
    for (const role of roles) out.push({ id: `u-${tenant}-${role}`, grants: { [tenant]: [role] } });
  }
  return out;
}

// NOTE: the "unknown tenant" fixture is an invented name ('field-ops'), never a
// tenant this repo used to have. A retired tenant's removal is enforced by a
// validator that sweeps middleware/src for its name and fails on any hit, so a
// test reaching for it as a convenient example puts back the very string the
// removal exists to keep out. (Naming that validator here would do it too — its
// filename carries the word.)
describe('the grants invariant', () => {
  it('holds over a cast that holds every seeded role and no other', async () => {
    listUsers.mockResolvedValue(completeCast());
    expect(await invariant.check(ctx)).toEqual([]);
  });

  it('names the role, the tenant, and the tenant\'s real roles when a grant invents one', async () => {
    // A grant is a (user, tenant, role) triple and the role half is validated
    // against nothing: `user_tenant_roles.role` is plain TEXT. The switch is
    // accepted because the grant is present, and every Cedar decision for the
    // role then denies — a login that half-works.
    listUsers.mockResolvedValue([...completeCast(), { id: 'u-ghost', grants: { orgiq: ['auditor'] } }]);
    const violations = await invariant.check(ctx);
    const text = violations.join('\n');
    expect(text).toContain('u-ghost');
    expect(text).toContain("granted 'auditor' in 'orgiq'");
    expect(text).toContain('seeds/roles/orgiq/auditor.cedar');
    // And it says what the tenant DOES have, so the fix is one read away.
    expect(text).toContain('sme');
  });

  it('catches a grant in a tenant that has no roles at all', async () => {
    listUsers.mockResolvedValue([...completeCast(), { id: 'u-ghost', grants: { 'field-ops': ['dispatcher'] } }]);
    expect((await invariant.check(ctx)).join('\n'))
      .toContain("granted 'dispatcher' in tenant 'field-ops', but seeds/roles/ defines no roles for that tenant at all");
  });

  it('catches a seeded role no user holds, which no audit could ever exercise', async () => {
    const cast = completeCast().filter((u) => !u.grants['orgiq']?.includes('sme'));
    listUsers.mockResolvedValue(cast);
    expect((await invariant.check(ctx)).join('\n'))
      .toContain('seeds/roles/orgiq/sme.cedar defines a role no seeded user holds');
  });

  it('does not flag the cross-tenant role, which is valid in every tenant', async () => {
    // `admin.cedar` sits directly under seeds/roles/ rather than in a tenant
    // directory, and is the only role granted Masquerade.
    expect(crossTenantRoles()).toContain('admin');
    listUsers.mockResolvedValue([
      ...completeCast(),
      { id: 'u-operator', grants: { orgiq: ['admin'], assessment: ['admin'] } },
    ]);
    expect(await invariant.check(ctx)).toEqual([]);
  });
});
