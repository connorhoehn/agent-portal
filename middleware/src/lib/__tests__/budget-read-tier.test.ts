// The budgets read tier (lib/budget-read-tier.ts) and the capability grant that
// opens it (lib/session.ts CAPABILITY_GRANTS, decided 2026-10-13): the orgiq
// grant entry `budgets-reader` opens the figures, is never a role, and is
// recognised only in orgiq.

jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '', policyStoreId: undefined, cognito: null }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn(async () => false) }));

import { canReadBudgets, withholdBudget, BUDGET_READ_ITEM_ID } from '../budget-read-tier.js';
import { holdsCapability, isCapabilityGrant, mintSession, rolesForTenant } from '../session.js';

const member = { sub: 'u-theo', tenant: 'orgiq', role: 'member' };

it('the named roles read; a member does not; the capability grant does, in orgiq only', async () => {
  expect(await canReadBudgets({ ...member, role: 'program-owner' })).toBe(true);
  expect(await canReadBudgets(member)).toBe(false);
  expect(await canReadBudgets({ ...member, grants: { orgiq: ['member', 'budgets-reader'] } })).toBe(true);
  // The entry means nothing outside orgiq, nor as a role in another tenant's list.
  expect(await canReadBudgets({ ...member, tenant: 'social', role: 'participant', grants: { orgiq: ['member', 'budgets-reader'] } })).toBe(false);
  expect(await canReadBudgets({ ...member, grants: { social: ['budgets-reader'] } })).toBe(false);
  expect(await canReadBudgets(null)).toBe(false);
});

it('a capability grant is not a role: never listed, never landed on, never a tenant on its own', () => {
  expect(isCapabilityGrant('orgiq', 'budgets-reader')).toBe(true);
  expect(isCapabilityGrant('assessment', 'budgets-reader')).toBe(false);
  expect(holdsCapability({ orgiq: ['budgets-reader'] }, 'orgiq', 'budgets-reader')).toBe(true);
  expect(rolesForTenant({ orgiq: ['budgets-reader', 'member'] }, 'orgiq')).toEqual(['member']);
  expect(mintSession({ id: 'u-x' }, { orgiq: ['budgets-reader'] })).toBeNull();
  expect(mintSession({ id: 'u-x' }, { orgiq: ['budgets-reader', 'member'] })).toMatchObject({ tenant: 'orgiq', role: 'member' });
});

it('withholdBudget drops exactly the dollar fields and names the request', () => {
  expect(withholdBudget({ id: 'p', name: 'P', agentSpendUsd: 2, allocatedUsd: 5, activeAgentRuns: 1 }))
    .toEqual({ id: 'p', name: 'P', activeAgentRuns: 1, budgetAccess: { visible: false, reason: expect.any(String), requestItemId: BUDGET_READ_ITEM_ID } });
});
