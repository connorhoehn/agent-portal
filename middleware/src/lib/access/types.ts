// The access tenant's vocabulary and wire shapes — docs/access-tenant-api.md is
// the contract both halves are built against; this file is its middleware copy.

export const ACCESS_TENANTS = ['orgiq', 'assessment', 'social', 'pipelines'] as const;
export type AccessTenant = typeof ACCESS_TENANTS[number];

export type AccessKind = 'tenant-role' | 'initiative-membership';
export const DURATIONS = ['8h', '24h', '7d', '30d', 'standing'] as const;
export type AccessDuration = typeof DURATIONS[number];
export const REQUEST_STATUSES = ['draft', 'submitted', 'pending', 'approved', 'provisioned', 'active',
  'expired', 'revoked', 'rejected', 'withdrawn'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];
export type StepKind = 'manager' | 'steward' | 'access-admin';
export type StepStatus = 'waiting' | 'current' | 'approved' | 'rejected' | 'info-requested' | 'skipped';
export type StewardRule = 'tenant-steward' | 'initiative-owner';
export type AccessSeverity = 'warn' | 'block';
export type SodVerdict = 'clear' | 'warn' | 'block';
export type Decision = 'approve' | 'reject' | 'info';
export type AccessEventKind = 'submitted' | 'step-approved' | 'step-rejected' | 'info-requested' | 'withdrawn'
  | 'approved' | 'provisioned' | 'expired' | 'revoked' | 'sod-override' | 'sod-blocked' | 'policy-updated';
/** A request asks for access (`grant`) or, from an access review, takes it away (`revocation`, lane A2). */
export type RequestKind = 'grant' | 'revocation';
export type ReviewStatus = 'open' | 'closed';
export type ReviewDecision = 'keep' | 'revoke';

export interface SodConflict { policyId: string; reason: string; severity: AccessSeverity }

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

export interface RequestStep {
  step: number;
  kind: StepKind;
  status: StepStatus;
  decidedBy?: Person | null;
  decidedAt?: string | null;
  comment?: string | null;
  /** Who may decide it NOW, resolved live (never stored): shown, not trusted. */
  eligible: Person[];
  /** Why `eligible` is not the step's own candidates (an escalation), else null. Open requests only. */
  escalated: string | null;
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
  closedAt: string | null;
  /** Counted from the item rows the actor may see, at request time. */
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
  /** requestId is null for an event about a policy (`policy-updated`, which names `policyId`). */
  id: string; at: string; requestId: string | null; policyId: string | null; actor: Person | null;
  kind: AccessEventKind;
  before?: string | null; after?: string | null; reason?: string | null;
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
}

/** The thread every request carries (decision A8; A1 admits it on the gateway). */
export const requestThread = (id: string): string => `access:req:${id}`;
