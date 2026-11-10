// X-Ray traces are scoped like invocation_traces (second regression walk, 10
// November: GET /api/observability/traces listed the same three ownerless
// samples to a plain member and the org leader).
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', accountId: '' } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TRACE_OWNER_ANNOTATIONS, traceInScope, xrayScopeFilter } from '../trace-owner.js';
import { mockCloudWatch, ownerAnnotations } from '../../providers/cloudwatch.js';

describe('the owner annotation names', () => {
  it('are the agents\' (agents/_shared/trace_owner.py), so the filter matches what they tag', () => {
    const py = readFileSync(join(__dirname, '..', '..', '..', '..', 'agents', '_shared', 'trace_owner.py'), 'utf8');
    const named = (name: string) => py.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'))?.[1];
    expect(named('USER_ANNOTATION')).toBe(TRACE_OWNER_ANNOTATIONS.user);
    expect(named('TENANT_ANNOTATION')).toBe(TRACE_OWNER_ANNOTATIONS.tenant);
  });

  it('the filter uses exactly those keys', () => {
    expect(xrayScopeFilter({ tenant: 'orgiq', userId: 'u-1' })).toBe(
      `annotation.${TRACE_OWNER_ANNOTATIONS.user} = "u-1" AND annotation.${TRACE_OWNER_ANNOTATIONS.tenant} = "orgiq"`,
    );
  });

  it('a trace\'s owner is read from the segment or, for an OTel child span, its subsegments', () => {
    expect(ownerAnnotations({ annotations: { user_id: 'u-1', tenant: 'orgiq' } })).toEqual({ userId: 'u-1', tenant: 'orgiq' });
    expect(ownerAnnotations({ annotations: {}, subsegments: [{ subsegments: [{ annotations: { user_id: 'u-2', tenant: 'assessment' } }] }] }))
      .toEqual({ userId: 'u-2', tenant: 'assessment' });
    expect(ownerAnnotations({ annotations: { user_id: 7 } })).toEqual({ userId: null, tenant: null });
  });
});

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
