// With NO policy store configured, local dev must still honour the seed
// policies — it must not hand every role every action.
//
// THE BUG THIS PINS. `evaluate()` used to `return 'ALLOW'` outright whenever
// `config.auth.policyStoreId` was unset. Measured against the running service,
// that meant:
//
//   GET /api/session/capabilities  as role=member  ->  24 of 24 actions true
//                                                      (EditPolicy, ManageUsers,
//                                                       EditSchema included)
//   GET /api/identity/users        as role=member  ->  200
//
// Nothing was insecure — production returns DENY on a missing store, and that
// branch is still here. But it made every permission-dependent journey
// impossible to exercise locally: the portal rendered every control for every
// role, so the masquerade menu switched roles without changing anything, and a
// capability gate could not be demoed or tested at all.
//
// TWO CONCERNS, DELIBERATELY SPLIT:
//   authz-matrix.test.ts  pins WHAT the seeds grant (parsing the real .cedar
//                         files, so a seed edit that widens `member` fails).
//   this file             pins THAT open mode consults the registry at all,
//                         and that production still denies.
//
// role-registry is mocked here for a mechanical reason, not to dodge the real
// data: it reads `import.meta.url` at module scope, which ts-jest's CommonJS
// transform cannot handle — every existing test that touches it mocks it out
// (see routes/__tests__/identity.test.ts, and the note at the top of
// authz-matrix.test.ts). Importing it for real here would fail to load and
// every action would resolve to the deny fallback, which would make these
// assertions pass for the wrong reason.
//
// So the fixture below is deliberately NOT the real matrix — it is obviously
// synthetic, so nobody mistakes this file for the source of truth about who
// can do what. Verified separately against the running service: role=member
// went from 24/24 actions to 4/24, and GET /api/identity/users from 200 to 403.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: {}, mock: { aurora: true } },
}));

// audit.ts pulls in transport we do not want in a unit test; the decision path
// is what is under test, not the logging of it.
jest.mock('../audit.js', () => ({ logAuthz: jest.fn(), eventFromSession: jest.fn(() => ({})) }));

jest.mock('../role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'member', tenant: 'orgiq', label: 'Member', summary: '', capabilities: ['Search', 'ViewOrgChart'] },
    { id: 'sme', tenant: 'orgiq', label: 'SME', summary: '', capabilities: ['Search', 'DispatchAgentRun'] },
    { id: 'hr-admin', tenant: 'orgiq', label: 'HR Admin', summary: '', capabilities: ['Search', 'EditPolicy', 'ManageUsers'] },
  ],
}));

import { isAllowed, clearAuthzCache } from '../authz.js';

const OLD_ENV = process.env['NODE_ENV'];

beforeEach(() => {
  clearAuthzCache();
  process.env['NODE_ENV'] = 'development';
});
afterEach(() => {
  process.env['NODE_ENV'] = OLD_ENV;
  clearAuthzCache();
});

const principal = (role: string) => ({ sub: 'demo-user', role, tenant: 'orgiq' });

describe('open mode (no policy store) follows the seed policies', () => {
  it('denies a member the actions the portal gates edit controls on', async () => {
    // The exact gate ProjectDetailPage uses. Before the fix this was true for
    // everyone, so "+ Add story / bug", the done-checkboxes and "New epic"
    // rendered for a rank-and-file member.
    expect(await isAllowed(principal('member'), 'DispatchAgentRun')).toBe(false);
  });

  it('denies a member the identity-admin actions outright', async () => {
    expect(await isAllowed(principal('member'), 'ManageUsers')).toBe(false);
    expect(await isAllowed(principal('member'), 'EditPolicy')).toBe(false);
  });

  it('still grants a member what the seeds do grant', async () => {
    // The point is a real matrix, not a blanket deny — an over-correction that
    // locked everyone out would be just as useless for exercising a journey.
    expect(await isAllowed(principal('member'), 'Search')).toBe(true);
    expect(await isAllowed(principal('member'), 'ViewOrgChart')).toBe(true);
  });

  it('grants an sme the dispatch action a member is denied', async () => {
    // Two roles must actually DIFFER — that is what makes the masquerade menu
    // meaningful and what makes a permission journey demonstrable.
    expect(await isAllowed(principal('sme'), 'DispatchAgentRun')).toBe(true);
    expect(await isAllowed(principal('member'), 'DispatchAgentRun')).toBe(false);
  });

  it('grants hr-admin the policy actions a member is denied', async () => {
    expect(await isAllowed(principal('hr-admin'), 'EditPolicy')).toBe(true);
  });

  it('denies an unknown role everything, rather than defaulting it open', async () => {
    expect(await isAllowed(principal('not-a-real-role'), 'Search')).toBe(false);
  });
});

describe('production is unchanged', () => {
  it('denies everything when the policy store is missing in production', async () => {
    process.env['NODE_ENV'] = 'production';
    clearAuthzCache();
    // A missing POLICY_STORE_ID in production is a misconfiguration, and the
    // safe reading of a misconfiguration is "no one may do anything".
    expect(await isAllowed(principal('hr-admin'), 'EditPolicy')).toBe(false);
    expect(await isAllowed(principal('member'), 'Search')).toBe(false);
  });
});
