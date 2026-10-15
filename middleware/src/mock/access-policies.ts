// Separation-of-duties policies (docs/access-tenant-design.md §3, decision A7).
//
// Live: `access_policies` (schema/access_schema.sql, additive, NOT applied to
// Aurora). This registered fixture mirrors the seed row for row (parity entity
// `access policies`); `PUT /api/access/policies/:id` mutates it and
// `POST /api/__mock/reset` restores it.

import { clock, defineFixture } from './core/index.js';
import type { AccessSeverity } from '../lib/access/types.js';

export interface AccessPolicyRow {
  id: string;
  title: string;
  left: { tenant: string; role: string };
  right: { tenant: string; role: string };
  severity: AccessSeverity;
  reason: string;
  updatedAt: string;
  updatedBy: string | null;
}

const policy = (id: string, title: string, left: [string, string], right: [string, string], severity: AccessSeverity, reason: string, ageDays: number): AccessPolicyRow =>
  ({ id, title, left: { tenant: left[0], role: left[1] }, right: { tenant: right[0], role: right[1] }, severity, reason, updatedAt: clock.daysAgo(ageDays), updatedBy: 'u-priya' });

export const accessPoliciesFixture = defineFixture<AccessPolicyRow>({
  key: 'access.policies',
  scenarios: {
    default: () => [
      // Priya tightened sod-001 yesterday (its audit event, and the request it now catches, are in access-requests.ts).
      policy('sod-001', 'Spend and allocate', ['orgiq', 'sme'], ['orgiq', 'org-leader'], 'block',
        'An SME spends a sprint envelope; an org leader grants it. One person holding both approves their own spending.', 1),
      policy('sod-002', 'Write and approve a pipeline', ['pipelines', 'author'], ['pipelines', 'operator'], 'block',
        'An author writes a definition; an operator approves its steps. Holding both approves your own definition.', 92),
      policy('sod-003', 'Score and approve exceptions', ['assessment', 'assessor'], ['assessment', 'lead-assessor'], 'warn',
        'A lead assessor approves not-applicable exceptions on scores that assessors entered. Holding both means approving exceptions to your own scores.', 47),
      policy('sod-004', 'Retain recordings and approve runs', ['social', 'moderator'], ['pipelines', 'operator'], 'warn',
        'Moderators decide which call recordings are kept; operators approve pipeline runs that can read them. One person holding both keeps the evidence and approves its use.', 21),
    ],
    empty: () => [],
  },
});
