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
import type { AccessDuration, EnvelopeForecast, EscalationLevel, RequestKind, RequestStatus, SodVerdict, StepKind, StepStatus, AccessEventKind } from '../lib/access/types.js';

export interface AccessRequestRow {
  id: string;
  /** `grant` (asked for) or `revocation` (created pre-approved by an access review, lane A2). */
  kind: RequestKind;
  /** The review campaign a revocation came from (access_reviews.id), else null. */
  reviewId: string | null;
  requesterId: string;
  beneficiaryId: string;
  itemId: string;
  justification: string;
  duration: AccessDuration;
  /** `sprint-envelope` requests only (access_requests.requested_usd): the dollars asked for. Null on every other kind. */
  requestedUsd: number | null;
  /** `sprint-envelope` requests only (access_requests.forecast, JSONB): the dispatch forecast filed with it. */
  forecast: EnvelopeForecast | null;
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
  /** When it became the step awaiting a decision (access_request_steps.current_since), else null. */
  currentSince: string | null;
  /** Timer escalations so far, 0..2 (lib/access-escalation.ts), and when the last one happened. */
  escalationLevel: EscalationLevel;
  escalatedAt: string | null;
  /** The approver a delegate decided this step for (access_request_steps.delegated_from), else null. */
  delegatedFrom: string | null;
}

export interface AccessEventRow {
  id: string;
  /** The request the event belongs to; null for an event about a policy (lane A2). */
  requestId: string | null;
  /** The SoD policy a `policy-updated` event changed, else null. */
  policyId: string | null;
  /** The delegation a `delegated` / `delegation-ended` event is about, else null. */
  delegationId: string | null;
  at: string;
  actorId: string | null;
  kind: AccessEventKind;
  beforeStatus: string | null;
  afterStatus: string | null;
  reason: string | null;
}

const req = (
  id: string, requesterId: string, itemId: string, justification: string, duration: AccessDuration, status: RequestStatus,
  submittedAt: string, decidedAt: string | null = null, provisionedAt: string | null = null, expiresAt: string | null = null,
  sodVerdict: SodVerdict = 'clear',
): AccessRequestRow => ({
  id, kind: 'grant', reviewId: null, requesterId, beneficiaryId: requesterId, itemId, justification, duration, status,
  requestedUsd: null, forecast: null,
  sodVerdict, sodOverriddenBy: null, sodOverrideReason: null,
  submittedAt, decidedAt, provisionedAt, expiresAt, revokedAt: null, expiryWarnedAt: null,
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
      // Omar's seven days as an operator, granted and run out: provisioned 11 days ago, lapsed 4 days ago.
      req('req-0003', 'u-omar', 'role:pipelines:operator',
        'Covering the on-call approvals rotation for the ingest pipelines for a week.', '7d', 'expired',
        clock.daysAgo(12), clock.daysAgo(11), clock.daysAgo(11), clock.daysAgo(4)),
      req('req-0004', 'u-nora', 'role:orgiq:sme',
        'I run the Auth Migration cutover rehearsals and dispatch their agent work against the sprint envelope.\n\nStanding access: the rehearsals recur every sprint, so a 30-day grant would lapse in the middle of a cutover.', 'standing', 'active',
        clock.daysAgo(40), clock.daysAgo(39), clock.daysAgo(39)),
      req('req-0005', 'u-rhea', 'role:orgiq:org-leader',
        'Would like to see the leaderboards while preparing the quarterly security review.', '7d', 'rejected',
        clock.daysAgo(6), clock.daysAgo(5)),
      // Asked 13 days ago, inside Omar's travel delegation (mock/access-delegations.ts): Priya decided his step for him.
      req('req-0006', 'u-rhea', 'role:social:moderator',
        'Planned to curate the security-announcements channel during the rollout.', '30d', 'withdrawn',
        clock.daysAgo(13)),
      // Eli holds SME; sod-001 (tightened yesterday) now blocks her holding Org leader too. Priya's step, and her call.
      req('req-0007', 'u-eli', 'role:orgiq:org-leader',
        'The Observability dispatches wait on the release manager for each sprint envelope. As org leader I could grant them their envelope myself.', '7d', 'pending',
        clock.hoursAgo(30), null, null, null, 'warn'),
    ],
    empty: () => [],
  },
});

const step = (requestId: string, n: number, kind: StepKind, status: StepStatus, currentSince: string | null,
  decidedBy: string | null = null, decidedAt: string | null = null, comment: string | null = null): AccessStepRow =>
  ({ requestId, step: n, kind, status, decidedBy, decidedAt, comment, currentSince, escalationLevel: 0, escalatedAt: null, delegatedFrom: null });

export const accessStepsFixture = defineFixture<AccessStepRow>({
  key: 'access.request-steps',
  scenarios: {
    default: () => [
      step('req-0001', 1, 'manager', 'current', clock.hoursAgo(3)),
      step('req-0001', 2, 'steward', 'waiting', null),
      step('req-0002', 1, 'manager', 'approved', clock.daysAgo(2), 'u-omar', clock.daysAgo(1), 'Agreed with Vera; two sprints.'),
      step('req-0002', 2, 'steward', 'current', clock.daysAgo(1)),
      step('req-0003', 1, 'manager', 'approved', clock.daysAgo(12), 'u-priya', clock.daysAgo(12), 'Covers the rotation.'),
      step('req-0003', 2, 'steward', 'approved', clock.daysAgo(12), 'u-priya', clock.daysAgo(11), 'Seven days, then it lapses.'),
      step('req-0004', 1, 'steward', 'approved', clock.daysAgo(40), 'u-priya', clock.daysAgo(39), 'Owns the maintenance bots.'),
      step('req-0005', 1, 'manager', 'rejected', clock.daysAgo(6), 'u-omar', clock.daysAgo(5), 'The review does not need leaderboard access; I will share the export.'),
      step('req-0005', 2, 'steward', 'skipped', null),
      step('req-0005', 3, 'access-admin', 'skipped', null),
      { ...step('req-0006', 1, 'manager', 'approved', clock.daysAgo(13), 'u-priya', clock.daysAgo(12), 'Fine for the rollout window.'), delegatedFrom: 'u-omar' },
      step('req-0006', 2, 'steward', 'skipped', null),
      step('req-0007', 1, 'steward', 'approved', clock.hoursAgo(30), 'u-rachel', clock.hoursAgo(20), 'Fine by me if Priya clears the policy side.'),
      step('req-0007', 2, 'access-admin', 'current', clock.hoursAgo(20)),
    ],
    empty: () => [],
  },
});

const evt = (id: string, requestId: string, at: string, actorId: string | null, kind: AccessEventKind, beforeStatus: string | null, afterStatus: string | null, reason: string | null = null): AccessEventRow =>
  ({ id, requestId, policyId: null, delegationId: null, at, actorId, kind, beforeStatus, afterStatus, reason });

export const accessEventsFixture = defineFixture<AccessEventRow>({
  key: 'access.events',
  scenarios: {
    default: () => [
      evt('evt-0001', 'req-0001', clock.hoursAgo(3), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0002', 'req-0002', clock.daysAgo(2), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0003', 'req-0002', clock.daysAgo(1), 'u-omar', 'step-approved', 'submitted', 'pending', 'Agreed with Vera; two sprints.'),
      evt('evt-0004', 'req-0003', clock.daysAgo(12), 'u-omar', 'submitted', 'draft', 'submitted'),
      evt('evt-0005', 'req-0003', clock.daysAgo(12), 'u-priya', 'step-approved', 'submitted', 'pending', 'Covers the rotation.'),
      evt('evt-0006', 'req-0003', clock.daysAgo(11), 'u-priya', 'step-approved', 'pending', 'approved', 'Seven days, then it lapses.'),
      evt('evt-0007', 'req-0003', clock.daysAgo(11), 'u-priya', 'approved', 'pending', 'approved'),
      evt('evt-0017', 'req-0003', clock.daysAgo(11), null, 'provisioned', 'approved', 'active'),
      evt('evt-0018', 'req-0003', clock.daysAgo(4), null, 'expired', 'active', 'expired'),
      evt('evt-0008', 'req-0004', clock.daysAgo(40), 'u-nora', 'submitted', 'draft', 'submitted'),
      evt('evt-0009', 'req-0004', clock.daysAgo(39), 'u-priya', 'step-approved', 'submitted', 'approved', 'Owns the maintenance bots.'),
      evt('evt-0010', 'req-0004', clock.daysAgo(39), 'u-priya', 'approved', 'submitted', 'approved'),
      evt('evt-0011', 'req-0004', clock.daysAgo(39), null, 'provisioned', 'approved', 'active'),
      evt('evt-0012', 'req-0005', clock.daysAgo(6), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0013', 'req-0005', clock.daysAgo(5), 'u-omar', 'step-rejected', 'submitted', 'rejected', 'The review does not need leaderboard access; I will share the export.'),
      evt('evt-0014', 'req-0006', clock.daysAgo(13), 'u-rhea', 'submitted', 'draft', 'submitted'),
      evt('evt-0019', 'req-0006', clock.daysAgo(12), 'u-priya', 'step-approved', 'submitted', 'pending', 'Fine for the rollout window. — decided on behalf of Omar Haddad'),
      evt('evt-0015', 'req-0006', clock.daysAgo(9), 'u-rhea', 'withdrawn', 'pending', 'withdrawn', 'The channel moved to the platform team.'),
      // sod-001 tightened from a warning to a block yesterday; req-0007 (submitted under the old rule) is what it now catches.
      { id: 'evt-0020', requestId: null, policyId: 'sod-001', delegationId: null, at: clock.daysAgo(1), actorId: 'u-priya', kind: 'policy-updated', beforeStatus: 'warn', afterStatus: 'block',
        reason: 'Spend and allocate: tightened so that nobody grants the sprint envelope they spend.' },
      evt('evt-0021', 'req-0007', clock.hoursAgo(30), 'u-eli', 'submitted', 'draft', 'submitted'),
      evt('evt-0022', 'req-0007', clock.hoursAgo(23), null, 'sod-blocked', 'submitted', 'submitted', 'Spend and allocate: Eli Garcia already holds SME in Work.'),
      evt('evt-0023', 'req-0007', clock.hoursAgo(20), 'u-rachel', 'step-approved', 'submitted', 'pending', 'Fine by me if Priya clears the policy side.'),
      // dlg-0001 (mock/access-delegations.ts): Omar handed his decisions to Priya for three days of travel.
      { id: 'evt-0016', requestId: null, policyId: null, delegationId: 'dlg-0001', at: clock.daysAgo(15), actorId: 'u-omar', kind: 'delegated', beforeStatus: null, afterStatus: null,
        reason: 'Omar Haddad → Priya Venkataraman: Travelling to the identity governance summit; Priya covers my approvals.' },
    ],
    empty: () => [],
  },
});
