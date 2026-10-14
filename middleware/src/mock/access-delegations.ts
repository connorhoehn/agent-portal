// Delegations of an approver's decisions (2026-10-14; docs/access-tenant-api.md
// § "Escalation timers and delegation").
//
// Live: `access_delegations` (schema/access_schema.sql, additive, NOT applied
// to Aurora — lane E). This registered fixture mirrors the seed row for row
// (parity entity `access delegations`); `POST /api/access/delegations` and its
// end route push and mutate it, and `POST /api/__mock/reset` restores the seed.
//
// The seed holds one delegation that has run its course: Omar handed his
// decisions to Priya for three days of travel two weeks ago. Whether a
// delegation is in force is never stored — the route compares the window with
// the mock clock (lib/access/delegation.ts).

import { clock, defineFixture } from './core/index.js';

export interface AccessDelegationRow {
  id: string;
  delegatorId: string;
  delegateId: string;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdAt: string;
  /** Ended early by the delegator or an access admin (access_delegations.ended_at), else null. */
  endedAt: string | null;
  endedBy: string | null;
}

export const accessDelegationsFixture = defineFixture<AccessDelegationRow>({
  key: 'access.delegations',
  scenarios: {
    default: () => [
      { id: 'dlg-0001', delegatorId: 'u-omar', delegateId: 'u-priya', startsAt: clock.daysAgo(14), endsAt: clock.daysAgo(11),
        reason: 'Travelling to the identity governance summit; Priya covers my approvals.', createdAt: clock.daysAgo(15), endedAt: null, endedBy: null },
    ],
    empty: () => [],
  },
});
