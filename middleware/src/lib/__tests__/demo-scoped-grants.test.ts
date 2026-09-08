// The cookie-less demo identity must BECOME the role it picks. Wearing "SME"
// while still holding every tenant's grants is how a demo SME saw the
// assessment pages.

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null, sessionSecretArn: undefined }, mock: { aurora: true } },
}));
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: class { send() { return Promise.resolve({ SecretString: 'x' }); } },
  GetSecretValueCommand: class {},
}));

import { demoScopedGrants, permissiveGrants, DEMO_SUB } from '../session.js';

describe('demoScopedGrants', () => {
  it('narrows the demo identity to exactly the chosen role in the chosen tenant', () => {
    expect(demoScopedGrants(DEMO_SUB, 'orgiq', 'sme', permissiveGrants())).toEqual({ orgiq: ['sme'] });
    expect(demoScopedGrants(DEMO_SUB, 'assessment', 'assessor', permissiveGrants())).toEqual({ assessment: ['assessor'] });
  });
  it('admin restores the permissive set — the cross-tenant persona', () => {
    expect(demoScopedGrants(DEMO_SUB, 'orgiq', 'admin', { orgiq: ['sme'] })).toEqual(permissiveGrants());
  });
  it('never touches a real user', () => {
    const mine = { orgiq: ['sme'], assessment: ['assessor'] };
    expect(demoScopedGrants('u-nora', 'orgiq', 'sme', mine)).toBe(mine);
  });
});

// The narrowed cookie is what the demo persona HOLDS; it is not what it may
// still BECOME. The picker POSTs /tenant then /role — the first call narrowing
// the cookie to the fallback role must not make the second one a 403.
import { switchableGrants } from '../session.js';

describe('switchableGrants', () => {
  it('the demo persona may switch to any role in any tenant, however narrow its cookie', () => {
    expect(switchableGrants(DEMO_SUB, { assessment: ['assessor'] })).toEqual(permissiveGrants());
    expect(switchableGrants(DEMO_SUB, { orgiq: ['sme'] }).assessment).toContain('program-lead');
  });
  it('a real user may switch only within the grants the store gave them', () => {
    const mine = { orgiq: ['sme'] };
    expect(switchableGrants('u-nora', mine)).toBe(mine);
  });
});
