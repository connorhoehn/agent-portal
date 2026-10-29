// The access tenant's vocabulary and wire shapes — docs/access-tenant-api.md is
// the contract both halves are built against; this file is its middleware copy.

import { TENANTS_GOVERNED_BY_ACCESS } from '../tenants.generated.js';

/** The tenants whose roles this product requests and provisions: manifest `governedByAccess`. */
export const ACCESS_TENANTS = TENANTS_GOVERNED_BY_ACCESS;
export type AccessTenant = typeof ACCESS_TENANTS[number];

/**
 * `capability`: a grant entry that is not a role (lib/session.ts CAPABILITY_GRANTS), e.g. orgiq budget visibility.
 * `sprint-envelope` (2026-10-28): a spend envelope on one initiative — provisioned as a `budget_grants`
 * row through the same path POST /api/grants writes, never a grants-table entry. One derived catalog
 * item per initiative (`envelope:<projectId>`, lib/access/items.ts); the request carries the amount.
 */
export type AccessKind = 'tenant-role' | 'initiative-membership' | 'capability' | 'sprint-envelope';
export const ACCESS_KINDS: readonly AccessKind[] = ['tenant-role', 'initiative-membership', 'capability', 'sprint-envelope'];
export const DURATIONS = ['8h', '24h', '7d', '30d', 'standing'] as const;
export type AccessDuration = typeof DURATIONS[number];
export const REQUEST_STATUSES = ['draft', 'submitted', 'pending', 'approved', 'provisioned', 'active',
  'expired', 'revoked', 'rejected', 'withdrawn'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export type StepKind = 'manager' | 'steward' | 'access-admin';
export type StepStatus = 'waiting' | 'current' | 'approved' | 'rejected' | 'info-requested' | 'skipped';
/**
 * `budget-owner`: the orgiq budget owner — `org-leader`, the holder of ManageBudgets (budget visibility, 2026-10-13).
 * `budget-holder` (2026-10-28): the initiative's budget holder — whoever last set its allocation
 * (`initiative_budgets.updated_by`) when they can decide in Access, else the org-leaders (lib/access/chain.ts).
 */
export type StewardRule = 'tenant-steward' | 'initiative-owner' | 'budget-owner' | 'budget-holder';
export type AccessSeverity = 'warn' | 'block';
export type SodVerdict = 'clear' | 'warn' | 'block';
export type Decision = 'approve' | 'reject' | 'info';
export type AccessEventKind = 'submitted' | 'step-approved' | 'step-rejected' | 'info-requested' | 'withdrawn'
  | 'approved' | 'provisioned' | 'expired' | 'revoked' | 'sod-override' | 'sod-blocked' | 'policy-updated'
  // Escalation timers and delegation (2026-10-14).
  | 'escalated' | 'delegated' | 'delegation-ended';
/** A request asks for access (`grant`) or, from an access review, takes it away (`revocation`, lane A2). */
export type RequestKind = 'grant' | 'revocation';
export type ReviewStatus = 'open' | 'closed';
export type ReviewDecision = 'keep' | 'revoke';

/** `title` is the policy's own name, so a page prints "Write and approve a pipeline", never `sod-002`. */
export interface SodConflict { policyId: string; title: string; reason: string; severity: AccessSeverity }

export interface CatalogItem {
  id: string;
  kind: AccessKind;
  tenant: AccessTenant;
  role?: string;
  projectId?: string;
  title: string;
  description: string;
  sensitive: boolean;
  defaultDuration: AccessDuration;
  stewardRule: StewardRule;
  heldByActor: boolean;
  sodConflicts: SodConflict[];
}

export interface Person { id: string; displayName: string; personId?: string | null }

/**
 * The forecast a sprint-envelope request was filed against (2026-10-28): the
 * work item the SME was about to dispatch, the model, and the p25/p75 cost the
 * dispatch drawer showed. Stored whole on the request (`access_requests.forecast`)
 * so the approver sees what the requester saw; null on every other kind.
 */
export interface EnvelopeForecast {
  workItemId: string | null;
  model: string | null;
  costUsdP25: number | null;
  costUsdP75: number | null;
}

/** A person who may decide a step now; `onBehalfOf` when only a delegation makes them eligible (2026-10-14). */
export interface EligiblePerson extends Person { onBehalfOf?: Person | null }

/** How far a step has escalated: 0 its own deciders, 1 + the next tier, 2 + the tier after (lib/access/chain.ts). */
export type EscalationLevel = 0 | 1 | 2;

export interface RequestStep {
  step: number;
  kind: StepKind;
  status: StepStatus;
  decidedBy?: Person | null;
  decidedAt?: string | null;
  comment?: string | null;
  /** Who may decide it NOW, resolved live (never stored): shown, not trusted. */
  eligible: EligiblePerson[];
  /** Why `eligible` is not the step's own candidates (an escalation), else null. Open requests only. */
  escalated: string | null;
  /** When it became the step awaiting a decision (the escalation clock), else null. */
  currentSince: string | null;
  /** Timer escalations so far (lib/access-escalation.ts) and when the last one happened. */
  escalationLevel: EscalationLevel;
  escalatedAt: string | null;
  /** When it escalates next if still undecided (current steps below the top tier), else null. */
  escalatesAt: string | null;
  /** The approver a delegate decided it for, else null. */
  decidedOnBehalfOf: Person | null;
}

export interface AccessRequest {
  id: string;
  /** `revocation`: a pre-approved request an access review created to take a standing grant away (A10). */
  kind: RequestKind;
  /** The review campaign a revocation came from, else null. */
  reviewId: string | null;
  requester: Person;
  beneficiary: Person;
  item: CatalogItem;
  justification: string;
  duration: AccessDuration;
  /** `sprint-envelope` only: the dollars asked for (becomes `budget_grants.allocated_usd` when provisioned); null otherwise. */
  requestedUsd: number | null;
  /** `sprint-envelope` only: the dispatch forecast the request was filed against; null otherwise. */
  forecast: EnvelopeForecast | null;
  status: RequestStatus;
  steps: RequestStep[];
  submittedAt: string;
  decidedAt?: string | null;
  provisionedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  sod: { verdict: SodVerdict; conflicts: SodConflict[]; overriddenBy?: Person | null; overrideReason?: string | null };
  can: {
    decide: boolean; withdraw: boolean; viewAudit: boolean;
    /** ProvisionAccess on an active grant request (lane A2 manual revoke). */
    revoke: boolean;
    /** ManageAccessPolicy on a request whose live SoD verdict is block and not yet overridden (A7). */
    overrideSod: boolean;
  };
  thread: string;
}

/** An access review campaign (docs/access-tenant-api.md §A2). */
export interface AccessReview {
  id: string;
  tenant: AccessTenant;
  title: string;
  status: ReviewStatus;
  owner: Person | null;
  openedAt: string;
  /** The campaign's deadline, else null. */
  closesAt: string | null;
  closedAt: string | null;
  /** Counted from the campaign's item rows at request time: the totals are the campaign's, whoever reads them. */
  progress: { total: number; decided: number; kept: number; revoked: number };
  can: { decide: boolean };
}

/** One standing grant under review: a (user, role) pair in the campaign's tenant. */
export interface AccessReviewItem {
  id: string;
  reviewId: string;
  user: Person;
  tenant: AccessTenant;
  role: string;
  decision: ReviewDecision | null;
  decidedBy: Person | null;
  decidedAt: string | null;
  comment: string | null;
  /** The pre-approved revocation request a `revoke` created. */
  revocationRequestId: string | null;
  can: { decide: boolean };
}

export interface AccessPolicy {
  id: string; title: string; reason: string; severity: AccessSeverity;
  left: { tenant: string; role: string }; right: { tenant: string; role: string };
  updatedAt: string; updatedBy?: Person | null;
}

export interface AccessEvent {
  /** requestId is null for an event about a policy (`policy-updated`, which names `policyId`) or a delegation (`delegationId`). */
  id: string; at: string; requestId: string | null; policyId: string | null; delegationId: string | null; actor: Person | null;
  kind: AccessEventKind;
  before?: string | null; after?: string | null; reason?: string | null;
  /** What the event is about, in words: the item and its beneficiary, the policy's title, or the delegation's parties. */
  subject?: string | null;
}

/** A directory user as the resolver needs it: current grants and the org-graph link. */
export interface DirectoryUser {
  id: string;
  displayName: string;
  personId: string | null;
  grants: Record<string, string[]>;
}

/**
 * The live directory a decision is resolved against (decision A4): the app
 * users with their CURRENT grants, `people.manager_id`, and each initiative's
 * owner and contributors (`projects.owner_id` / `project_contributions`).
 * Built fresh per request by providers/access.ts; never cached on a request.
 */
export interface AccessDirectory {
  users: readonly DirectoryUser[];
  /** people.manager_id of `personId`, or null. */
  managerOf(personId: string | null | undefined): string | null;
  /** The initiative's owner person and every contributing person, or null when unknown. */
  initiative(projectId: string): { ownerPersonId: string | null; memberPersonIds: readonly string[] } | null;
  /** Delegations in force now (window open, not ended), resolved when the directory is built. Absent = none. */
  activeDelegations?: ReadonlyArray<{ id: string; delegatorId: string; delegateId: string }>;
  /**
   * Sprint envelopes (2026-10-28): the people holding an ACTIVE budget grant on the
   * initiative (its sprint `active`, or sprint-less), the same rule lib/bot-runner.ts
   * dispatches on — "already holds" for a `sprint-envelope` item. Absent = nobody.
   */
  envelopeHolders?(projectId: string): readonly string[];
  /**
   * The app user who last set the initiative's allocation (`initiative_budgets.updated_by`),
   * the `budget-holder` steward's first candidate. Absent or null = unknown.
   */
  budgetHolderOf?(projectId: string): string | null;
}

/** A delegation of one approver's decisions to another for a window (2026-10-14). */
export interface AccessDelegation {
  id: string;                        // 'dlg-0001'
  delegator: Person;
  delegate: Person;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdAt: string;
  endedAt: string | null;
  endedBy: Person | null;
  /** 'scheduled' (starts later), 'active' (in force now), 'ended' (window passed or ended early). */
  state: 'scheduled' | 'active' | 'ended';
  can: { end: boolean };
}

/** The thread every request carries (decision A8; A1 admits it on the gateway). */
export const requestThread = (id: string): string => `access:req:${id}`;

/**
 * `POST /api/access/requests/preview` (the request page's summary): what
 * filing would produce, computed by the same checks as the submit and written
 * nowhere. `item` carries the ACTOR's `heldByActor`/`sodConflicts` (the
 * catalog's view); `sod` is evaluated against the BENEFICIARY's current grants.
 */
export interface AccessRequestPreview {
  item: CatalogItem;
  beneficiary: Person;
  /** The chain planChain would write, each step's eligible deciders resolved live now. */
  steps: Array<{ step: number; kind: StepKind; eligible: EligiblePerson[]; escalated: string | null }>;
  sod: { verdict: SodVerdict; conflicts: SodConflict[] };
  /** The body's duration, else the item's default. */
  duration: AccessDuration;
  /** When the grant would end were it provisioned now; null for standing. */
  expiresIfProvisionedNow: string | null;
  /** The refusal the submit would answer now (already held, a duplicate open request, an SoD block), else null. */
  refusal: null | { status: 400 | 403 | 409; error: string; requestId?: string };
}
