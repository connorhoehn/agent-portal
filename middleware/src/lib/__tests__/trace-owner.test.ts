// X-Ray traces are scoped like invocation_traces (second regression walk, 10
// November: GET /api/observability/traces listed the same three ownerless
// samples to a plain member and the org leader).
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', accountId: '' } }));

import { traceInScope, xrayScopeFilter } from '../trace-owner.js';
import { mockCloudWatch } from '../../providers/cloudwatch.js';

describe('traceInScope', () => {
  const mine = { userId: 'u-a', tenant: 'orgiq' };
  it('the cross-tenant admin (null scope) reads every trace, ownerless included', () => {
    expect([mine, {}, { userId: 'u-b', tenant: 'assessment' }].every((t) => traceInScope(null, t))).toBe(true);
  });
  it('a member reads only their own trace in their own tenant', () => {
    const scope = { tenant: 'orgiq', userId: 'u-a' };
    expect(traceInScope(scope, mine)).toBe(true);
    expect(traceInScope(scope, { userId: 'u-b', tenant: 'orgiq' })).toBe(false);
    expect(traceInScope(scope, { userId: 'u-a', tenant: 'assessment' })).toBe(false);
  });
  it('a fleet-wide role reads every user in its tenant, never an ownerless or tenantless trace', () => {
    const scope = { tenant: 'orgiq', userId: null };
    expect(traceInScope(scope, { userId: 'u-b', tenant: 'orgiq' })).toBe(true);
    expect(traceInScope(scope, {})).toBe(false);
    expect(traceInScope(scope, { userId: 'u-b' })).toBe(false);
    expect(traceInScope(scope, { userId: 'u-b', tenant: 'social' })).toBe(false);
  });
});

describe('xrayScopeFilter', () => {
  it('asks X-Ray for the caller\'s annotations only', () => {
    expect(xrayScopeFilter(null)).toBeUndefined();
    expect(xrayScopeFilter({ tenant: 'orgiq', userId: 'u-vera' })).toBe('annotation.user_id = "u-vera" AND annotation.tenant = "orgiq"');
    expect(xrayScopeFilter({ tenant: 'orgiq', userId: null })).toBe('annotation.tenant = "orgiq"');
  });
  it('reads nothing for a value the filter language cannot quote', () => {
    expect(xrayScopeFilter({ tenant: 'orgiq', userId: 'u" OR annotation.tenant = "x' })).toBeNull();
    expect(xrayScopeFilter({ tenant: 'or giq', userId: null })).toBeNull();
  });
});

describe('the mock provider owns its samples', () => {
  it('a member lists their own, the org leader every user\'s in Work, the admin all three', async () => {
    const ids = async (scope: Parameters<typeof mockCloudWatch.listTraces>[1]) => (await mockCloudWatch.listTraces(10, scope)).map((t) => t.traceId);
    expect(await ids({ tenant: 'orgiq', userId: 'u-theo' })).toEqual(['trace-001']);
    expect(await ids({ tenant: 'orgiq', userId: 'u-mia' })).toEqual([]);
    expect(await ids({ tenant: 'orgiq', userId: null })).toEqual(['trace-001', 'trace-002', 'trace-003']);
    expect(await ids({ tenant: 'assessment', userId: null })).toEqual([]);
    expect(await ids(null)).toEqual(['trace-001', 'trace-002', 'trace-003']);
  });
});
