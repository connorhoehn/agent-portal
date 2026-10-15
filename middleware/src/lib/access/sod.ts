// Separation-of-duties evaluation (decision A7). A policy is two (tenant, role)
// pairs that must not be held together; requesting one side while holding the
// other is a conflict at that policy's severity. Pure: the caller hands in the
// subject's CURRENT grants and the current policy rows.

import type { AccessCatalogRow } from '../../mock/access-catalog.js';
import type { AccessPolicyRow } from '../../mock/access-policies.js';
import type { SodConflict, SodVerdict } from './types.js';

const same = (a: { tenant: string; role: string }, tenant: string, role: string) => a.tenant === tenant && a.role === role;
const holds = (grants: Record<string, string[]>, side: { tenant: string; role: string }) => (grants[side.tenant] ?? []).includes(side.role);

/** Conflicts between requesting `item` and the grants the subject holds now. Initiative memberships carry no SoD. */
export function sodConflicts(item: Pick<AccessCatalogRow, 'kind' | 'tenant' | 'role'>, grants: Record<string, string[]>, policies: readonly AccessPolicyRow[]): SodConflict[] {
  if (item.kind !== 'tenant-role' || !item.role) return [];
  const out: SodConflict[] = [];
  for (const p of policies) {
    const other = same(p.left, item.tenant, item.role) ? p.right : same(p.right, item.tenant, item.role) ? p.left : null;
    if (other && holds(grants, other)) out.push({ policyId: p.id, title: p.title, reason: p.reason, severity: p.severity });
  }
  return out;
}

/** The worst severity among the conflicts. */
export function sodVerdict(conflicts: readonly SodConflict[]): SodVerdict {
  if (conflicts.some((c) => c.severity === 'block')) return 'block';
  return conflicts.length > 0 ? 'warn' : 'clear';
}
