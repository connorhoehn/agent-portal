// Access requests, their approval steps and the audit trail
// (docs/access-tenant-design.md §3; wire shapes docs/access-tenant-api.md).
//
// Live: `access_requests`, `access_request_steps`, `access_events`
// (schema/access_schema.sql, additive, NOT applied to Aurora — lane E). These
// three registered fixtures mirror the seed row for row (parity entities
// `access requests`, `access request steps`, `access events`); the submit /
// decide / withdraw routes push and mutate them and `POST /api/__mock/reset`
// restores the seed.
//
// Rows only, in the table's own columns. Who MAY decide a step is never a row
// (decision A4): lib/access/chain.ts resolves it live from the directory on
// every read. No count is exported — every number a page shows is counted
// from these rows by the route at request time.

import { clock, defineFixture } from './core/index.js';
import type { AccessDuration, RequestStatus, SodVerdict, StepKind, StepStatus, AccessEventKind } from '../lib/access/types.js';

export interface AccessRequestRow {
  id: string;
  requesterId: string;
  beneficiaryId: string;
  itemId: string;
  justification: string;
  duration: AccessDuration;
  status: RequestStatus;
  sodVerdict: SodVerdict;
  sodOverriddenBy: string | null;
  sodOverrideReason: string | null;
  submittedAt: string;
  decidedAt: string | null;
  provisionedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** When the 24-hour expiry warning went to the requester and beneficiary
   * (lib/access-expiry.ts) — the once-only marker, so a second sweep or a
   * second replica never sends it twice. */
  expiryWarnedAt: string | null;
}

export interface AccessStepRow {
  requestId: string;
  step: number;
  kind: StepKind;
  status: StepStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  comment: string | null;
}

export interface AccessEventRow {
  id: string;
  requestId: string;
  at: string;
  actorId: string | null;
  kind: AccessEventKind;
  beforeStatus: string | null;
  afterStatus: string | null;
  reason: string | null;
}

const req = (
  id: string, requesterId: string, itemId: string, justification: string, duration: AccessDuration, status: RequestStatus,
  submittedAt: string, decidedAt: string | null = null, provisionedAt: string | null = null,
): AccessRequestRow => ({
  id, requesterId, beneficiaryId: requesterId, itemId, justification, duration, status,
  sodVerdict: 'clear', sodOverriddenBy: null, sodOverrideReason: null,
  submittedAt, decidedAt, provisionedAt, expiresAt: null, revokedAt: null, expiryWarnedAt: null,
});

export const accessRequestsFixture = defineFixture<AccessRequestRow>({
  key: 'access.requests',
  scenarios: {
    default: () => [
      req('req-0001', 'u-rhea', 'role:orgiq:sme',
        'I am picking up the SSO cutover stories and need to dispatch agent work against the sprint envelope.', '30d', 'submitted',
        clock.hoursAgo(3)),
      req('req-0002', 'u-rhea', 'initiative:p-auth-migration',
        'Pairing with Vera on the SAML shim retirement for the next two sprints.', '30d', 'pending',
        clock.daysAgo(2)),
      req('req-0003', 'u-omar', 'role:pipelines:operator',
        'Covering the on-call approvals rotation for the ingest pipelines this week.', '7d', 'approved',
        clock.daysAgo(4), clock.daysAgo(3)),
      req('req-0004', 'u-nora', 'role:orgiq:sme',
        'Standing SME on Observability and Auth Migration; owns the dispatched maintenance work.', 'standing', 'active',
        clock.daysAgo(40), clock.daysAgo(39), clock.daysAgo(39)),
      req('req-0005', 'u-rhea', 'role:orgiq:org-leader',
        'Would like to see the leaderboards while preparing the quarterly security review.', '7d', 'rejected',
        clock.daysAgo(6), clock.daysAgo(5)),
      req('req-0006', 'u-rhea', 'role:social:moderator',
        'Planned to curate the security-announcements channel during the rollout.', '30d', 'withdrawn',
        clock.daysAgo(10)),
    ],
    empty: () => [],
  },
});

const step = (requestId: string, n: number, kind: StepKind, status: StepStatus, decidedBy: string | null = null, decidedAt: string | null = null, comment: string | null = null): AccessStepRow =>
  ({ requestId, step: n, kind, status, decidedBy, decidedAt, comment });

export const accessStepsFixture = defineFixture<AccessStepRow>({
  key: 'access.request-steps',
  scenarios: {
    default: () => [
      step('req-0001', 1, 'manager', 'current'),
      step('req-0001', 2, 'steward', 'waiting'),
      step('req-0002', 1, 'manager', 'approved', 'u-omar', clock.daysAgo(1), 'Agreed with Vera; two sprints.'),
      step('req-0002', 2, 'steward', 'current'),
      step('req-0003', 1, 'manager', 'approved', 'u-priya', clock.daysAgo(4), 'Covers the rotation.'),
      step('req-0003', 2, 'steward', 'approved', 'u-priya', clock.daysAgo(3), 'Seven days, then it lapses.'),
      step('req-0004', 1, 'steward', 'approved', 'u-priya', clock.daysAgo(39), 'Owns the maintenance bots.'),
      step('req-0005', 1, 'manager', 'rejected', 'u-omar', clock.daysAgo(5), 'The review does not need leaderboard access; I will share the export.'),
      step('req-0005', 2, 'steward', 'skipped'),
      step('req-0005', 3, 'access-admin', 'skipped'),
      step('req-0006', 1, 'manager', 'skipped'),
      step('req-0006', 2, 'steward', 'skipped'),
    ],
    empty: () => [],
  },
});

const evt = (id: string, requestId: string, at: string, actorId: string | null, kind: AccessEventKind, beforeStatus: string | null, afterStatus: string | null, reason: string | null = null): AccessEventRow =>
  ({ id, requestId, at, actorId, kind, beforeStatus, afterStatus, reason });

export const accessEventsFixture = defineFixture<AccessEventRow>({
  key: 'access.events',
  scenarios: {
    default: () => [
      evt('evt-0001', 'req-0001', clock.hoursAgo(3), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0002', 'req-0002', clock.daysAgo(2), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0003', 'req-0002', clock.daysAgo(1), 'u-omar', 'step-approved', 'submitted', 'pending', 'Agreed with Vera; two sprints.'),
      evt('evt-0004', 'req-0003', clock.daysAgo(4), 'u-omar', 'submitted', 'draft', 'submitted'),
      evt('evt-0005', 'req-0003', clock.daysAgo(4), 'u-priya', 'step-approved', 'submitted', 'pending', 'Covers the rotation.'),
      evt('evt-0006', 'req-0003', clock.daysAgo(3), 'u-priya', 'step-approved', 'pending', 'approved', 'Seven days, then it lapses.'),
      evt('evt-0007', 'req-0003', clock.daysAgo(3), 'u-priya', 'approved', 'pending', 'approved'),
      evt('evt-0008', 'req-0004', clock.daysAgo(40), 'u-nora', 'submitted', 'draft', 'submitted'),
      evt('evt-0009', 'req-0004', clock.daysAgo(39), 'u-priya', 'step-approved', 'submitted', 'approved', 'Owns the maintenance bots.'),
      evt('evt-0010', 'req-0004', clock.daysAgo(39), 'u-priya', 'approved', 'submitted', 'approved'),
      evt('evt-0011', 'req-0004', clock.daysAgo(39), null, 'provisioned', 'approved', 'active'),
      evt('evt-0012', 'req-0005', clock.daysAgo(6), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0013', 'req-0005', clock.daysAgo(5), 'u-omar', 'step-rejected', 'submitted', 'rejected', 'The review does not need leaderboard access; I will share the export.'),
      evt('evt-0014', 'req-0006', clock.daysAgo(10), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0015', 'req-0006', clock.daysAgo(9), 'u-rhea', 'withdrawn', 'submitted', 'withdrawn', 'The channel moved to the platform team.'),
    ],
    empty: () => [],
  },
});
