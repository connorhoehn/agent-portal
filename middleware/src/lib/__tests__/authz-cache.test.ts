jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: 'test-store' } },
}));

const send = jest.fn();
jest.mock('@aws-sdk/client-verifiedpermissions', () => ({
  VerifiedPermissionsClient: class { send(input: unknown) { return send(input); } },
  IsAuthorizedCommand: class { constructor(public input: unknown) {} },
}));

import { clearAuthzCache, isAllowed } from '../authz.js';

beforeEach(() => { clearAuthzCache(); send.mockReset(); });

it('does not share a principal-specific decision between users with the same role', async () => {
  send.mockResolvedValueOnce({ decision: 'ALLOW' }).mockResolvedValueOnce({ decision: 'DENY' });
  const alice = { sub: 'alice', role: 'member', tenant: 'orgiq' };
  const bob = { ...alice, sub: 'bob' };
  expect(await isAllowed(alice, 'ViewAgents')).toBe(true);
  expect(await isAllowed(bob, 'ViewAgents')).toBe(false);
  expect(await isAllowed(alice, 'ViewAgents')).toBe(true);
  expect(await isAllowed(bob, 'ViewAgents')).toBe(false);
  expect(send).toHaveBeenCalledTimes(2);
});
