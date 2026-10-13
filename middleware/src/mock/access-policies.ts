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
  ({ id, title, left: { tenant: left[0], role: left[1] }, right: { tenant: right[0], role: right[1] }, severity, reason, updatedAt: clock.daysAgo(ageDays), updatedBy: null });

export const accessPoliciesFixture = defineFixture<AccessPolicyRow>({
  key: 'access.policies',
  scenarios: {
    default: () => [
      policy('sod-001', 'Spend and allocate', ['orgiq', 'sme'], ['orgiq', 'org-leader'], 'block',
        'An SME spends a sprint envelope; an org leader grants it. One person holding both approves their own spending.', 60),
      policy('sod-002', 'Write and approve a pipeline', ['pipelines', 'author'], ['pipelines', 'operator'], 'block',
        'An author writes a definition; an operator approves its steps. Holding both approves your own definition.', 60),
      policy('sod-003', 'Score and except', ['assessment', 'assessor'], ['assessment', 'lead-assessor'], 'warn',
        'A lead assessor approves N/A exceptions on scores an assessor entered; review who scored before approving.', 60),
      policy('sod-004', 'Moderate and run pipelines', ['social', 'moderator'], ['pipelines', 'operator'], 'warn',
        'Recordings a moderator retains can carry run approvals an operator decided; keep the two visible.', 60),
    ],
    empty: () => [],
  },
});
