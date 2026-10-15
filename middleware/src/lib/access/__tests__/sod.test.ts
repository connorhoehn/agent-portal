// Separation-of-duties evaluation (lib/access/sod.ts, decision A7).
import type { AccessPolicyRow } from '../../../mock/access-policies.js';
import { sodConflicts, sodVerdict } from '../sod.js';
import { item } from './fixtures.js';

const policy = (id: string, left: [string, string], right: [string, string], severity: 'warn' | 'block'): AccessPolicyRow =>
  ({ id, title: id, left: { tenant: left[0], role: left[1] }, right: { tenant: right[0], role: right[1] }, severity, reason: `${id} reason`, updatedAt: 'x', updatedBy: null });
const POLICIES = [
  policy('sod-001', ['orgiq', 'sme'], ['orgiq', 'org-leader'], 'block'),
  policy('sod-003', ['assessment', 'assessor'], ['assessment', 'lead-assessor'], 'warn'),
];

describe('sodConflicts', () => {
  it('flags requesting one side while holding the other, in either direction', () => {
    expect(sodConflicts(item({ role: 'org-leader' }), { orgiq: ['sme'] }, POLICIES)).toEqual([{ policyId: 'sod-001', title: 'sod-001', reason: 'sod-001 reason', severity: 'block' }]);
    expect(sodConflicts(item({ role: 'sme' }), { orgiq: ['org-leader'] }, POLICIES).map((c) => c.policyId)).toEqual(['sod-001']);
  });
  it('is clear when the other side is not held, or held in another tenant', () => {
    expect(sodConflicts(item({ role: 'org-leader' }), {}, POLICIES)).toEqual([]);
    expect(sodConflicts(item({ role: 'org-leader' }), { assessment: ['sme'] }, POLICIES)).toEqual([]);
  });
  it('an initiative membership carries no SoD', () => {
    expect(sodConflicts(item({ kind: 'initiative-membership', role: null, projectId: 'p-auth-migration' }), { orgiq: ['sme', 'org-leader'] }, POLICIES)).toEqual([]);
  });
});

describe('sodVerdict', () => {
  it('takes the worst severity', () => {
    expect(sodVerdict([])).toBe('clear');
    expect(sodVerdict([{ policyId: 'a', title: 'a', reason: '', severity: 'warn' }])).toBe('warn');
    expect(sodVerdict([{ policyId: 'a', title: 'a', reason: '', severity: 'warn' }, { policyId: 'b', title: 'b', reason: '', severity: 'block' }])).toBe('block');
  });
});
