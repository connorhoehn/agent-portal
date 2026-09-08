// Open-mode authorization (no POLICY_STORE_ID) decides from the Cedar SEEDS via
// role-registry's role -> capability matrix. This pins the one rule that
// matrix cannot express as a plain set lookup: admin.cedar is an UNCONSTRAINED
// permit, recorded as ['*'], and `*` must mean every action.
//
// Before this, `has(action)` never matched `*`, so in open mode admin was
// denied on every plain requireAction gate while passing the read gates that
// special-case the role by name. The assessment tenant exposed it: all of its
// gates are plain, so an admin saw "HTTP 403" on Submissions.

jest.mock('../role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'admin', tenant: null, label: 'Admin', summary: '', capabilities: ['*'] },
    { id: 'assessor', tenant: 'assessment', label: 'Assessor', summary: '',
      capabilities: ['ViewAssessment', 'ScoreAssessment', 'RunAssessmentAgent'] },
  ],
}));

jest.mock('../../config.js', () => ({
  config: { auth: { policyStoreId: undefined, cognito: null }, mock: { aurora: true } },
}));

jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send() { return Promise.resolve({}); } },
  IsAuthorizedCommand: class {},
}));

import { isAllowed } from '../authz.js';

describe('open-mode authz — the admin wildcard', () => {
  const admin = { sub: 'u-operator', role: 'admin', tenant: 'assessment' };
  const assessor = { sub: 'u-asha', role: 'assessor', tenant: 'assessment' };

  it('admin is allowed a plain-gated action its file never names', async () => {
    expect(await isAllowed(admin, 'ViewAssessment')).toBe(true);
    expect(await isAllowed(admin, 'ManageAssessmentConfig')).toBe(true);
  });

  it('the wildcard is admin-only — a named list still means only what it names', async () => {
    expect(await isAllowed(assessor, 'ScoreAssessment')).toBe(true);
    expect(await isAllowed(assessor, 'ApproveException')).toBe(false);
  });

  it('an unknown role is denied, not defaulted', async () => {
    expect(await isAllowed({ sub: 'x', role: 'ghost', tenant: 'assessment' }, 'ViewAssessment')).toBe(false);
  });
});
