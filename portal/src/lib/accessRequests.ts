// The access tenant's wire shapes and the pure helpers its pages share
// (docs/access-tenant-api.md is the contract the middleware lane builds
// against; docs/access-tenant-design.md §3–§6 the model). No React here, so
// `pages/access/__tests__/*.test.ts` run it under plain `node --test`.

/** `capability`: a grant entry that is not a role (budget visibility in Work). */
export type AccessKind = 'tenant-role' | 'initiative-membership' | 'capability';
export type AccessDuration = '8h' | '24h' | '7d' | '30d' | 'standing';
export type RequestStatus = 'draft' | 'submitted' | 'pending' | 'approved' | 'provisioned' | 'active'
  | 'expired' | 'revoked' | 'rejected' | 'withdrawn';
export type StepKind = 'manager' | 'steward' | 'access-admin';
export type StepStatus = 'waiting' | 'current' | 'approved' | 'rejected' | 'info-requested' | 'skipped';
export type AccessTenant = 'orgiq' | 'assessment' | 'social' | 'pipelines';
export type SodSeverity = 'warn' | 'block';
export type Decision = 'approve' | 'reject' | 'info';
/** `grant` asks for access; `revocation` is a pre-approved request an access review created (lane A2). */
export type RequestKind = 'grant' | 'revocation';
export type ReviewStatus = 'open' | 'closed';
export type ReviewDecision = 'keep' | 'revoke';
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'caution' | 'accent';

export interface SodConflict { policyId: string; /** The policy's own name. */ title?: string; reason: string; severity: SodSeverity }

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
  stewardRule: 'tenant-steward' | 'initiative-owner' | 'budget-owner';
  heldByActor: boolean;
  sodConflicts: SodConflict[];
}

export interface AccessPerson { id: string; displayName: string; personId?: string | null }
/** A decider; `onBehalfOf` when only a delegation in force makes them one (2026-10-14). */
export interface EligiblePerson extends AccessPerson { onBehalfOf?: AccessPerson | null }

export interface RequestStep {
  step: number;
  kind: StepKind;
  status: StepStatus;
  decidedBy?: AccessPerson | null;
  decidedAt?: string | null;
  comment?: string | null;
  /** Who may decide it now, resolved live by the server: shown, never trusted. */
  eligible: EligiblePerson[];
  /** Why `eligible` is an escalation rather than the step's own candidates, else null. */
  escalated?: string | null;
  /** Escalation timers (2026-10-14): the step's clock, its level and when it escalates next. */
  currentSince?: string | null;
  escalationLevel?: 0 | 1 | 2;
  escalatedAt?: string | null;
  escalatesAt?: string | null;
  /** The approver a delegate decided it for. */
  decidedOnBehalfOf?: AccessPerson | null;
}

export interface AccessRequest {
  id: string;
  kind: RequestKind;
  /** The review campaign a revocation came from, else null. */
  reviewId: string | null;
  requester: AccessPerson;
  beneficiary: AccessPerson;
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
  sod: { verdict: 'clear' | SodSeverity; conflicts: SodConflict[]; overriddenBy?: AccessPerson | null; overrideReason?: string | null };
  can: {
    decide: boolean; withdraw: boolean; viewAudit: boolean;
    /** ProvisionAccess on an active grant (lane A2 manual revoke). */
    revoke: boolean;
    /** ManageAccessPolicy on a live, not-yet-overridden SoD block (decision A7). */
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
  owner: AccessPerson | null;
  openedAt: string;
  /** The campaign's deadline, else null. */
  closesAt?: string | null;
  closedAt: string | null;
  /** Counted by the server from the items the viewer may see. */
  progress: { total: number; decided: number; kept: number; revoked: number };
  can: { decide: boolean };
}

/** One standing (user, role) grant under review. */
export interface AccessReviewItem {
  id: string;
  reviewId: string;
  user: AccessPerson;
  tenant: AccessTenant;
  role: string;
  decision: ReviewDecision | null;
  decidedBy: AccessPerson | null;
  decidedAt: string | null;
  comment: string | null;
  revocationRequestId: string | null;
  can: { decide: boolean };
}

export interface ReviewRecord { review: AccessReview; items: AccessReviewItem[] }

/** GET /api/access/configuration. */
export interface AccessConfiguration {
  durations: { offered: AccessDuration[]; standingReasonMin: number };
  stewards: Array<{ scope: 'tenant-role' | 'initiative-membership' | 'capability' | 'sensitive'; tenant: string | null; rule: string; role: string | null }>;
  items: Array<{ id: string; title: string; kind: AccessKind; tenant: AccessTenant; defaultDuration: AccessDuration; stewardRule: CatalogItem['stewardRule']; sensitive: boolean }>;
  /** Fixed by the deployment (2026-10-14): how long a step waits before it escalates, and to whom. */
  escalation?: { stepSlaHours: number; tiers: ReadonlyArray<'access-admins' | 'platform-admins'> };
  delegation?: { maxDays: number };
}

/** GET /api/access/delegations (2026-10-14). */
export interface AccessDelegation {
  id: string;
  delegator: AccessPerson;
  delegate: AccessPerson;
  startsAt: string;
  endsAt: string;
  reason: string;
  createdAt: string;
  endedAt: string | null;
  endedBy: AccessPerson | null;
  state: 'scheduled' | 'active' | 'ended';
  can: { end: boolean };
}

export interface AccessPolicy {
  id: string; title: string; reason: string; severity: SodSeverity;
  left: { tenant: string; role: string }; right: { tenant: string; role: string };
  updatedAt: string; updatedBy?: AccessPerson | null;
}

export type AccessEventKind = 'submitted' | 'step-approved' | 'step-rejected' | 'info-requested' | 'withdrawn'
  | 'approved' | 'provisioned' | 'expired' | 'revoked' | 'sod-override' | 'sod-blocked' | 'policy-updated'
  | 'escalated' | 'delegated' | 'delegation-ended';

export interface AccessEvent {
  /** requestId is null for a policy change (`policy-updated`), which names `policyId`. */
  id: string; at: string; requestId: string | null; policyId?: string | null; delegationId?: string | null; actor: AccessPerson | null;
  kind: AccessEventKind;
  before?: string | null; after?: string | null; reason?: string | null;
  /** What the event is about, in words (the item and its beneficiary, the policy, the delegation). */
  subject?: string | null;
}

export interface ItemsResponse<T> { items: T[]; limits?: unknown }

export const ACCESS_API = '/api/access';

// ── Vocabulary ─────────────────────────────────────────────────────────────

export const TENANT_LABELS: Readonly<Record<AccessTenant, string>> = {
  orgiq: 'Work', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines',
};
export const KIND_LABELS: Readonly<Record<AccessKind, string>> = {
  'tenant-role': 'Workspace role', 'initiative-membership': 'Initiative membership', capability: 'Capability',
};
export const DURATION_LABELS: Readonly<Record<AccessDuration, string>> = {
  '8h': '8 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days', standing: 'Standing',
};
/** Who approves an item after the manager, in words (the request wizard, the configuration table). */
export const STEWARD_LABELS: Readonly<Record<CatalogItem['stewardRule'], string>> = {
  'tenant-steward': 'the workspace steward', 'initiative-owner': 'the initiative owner', 'budget-owner': 'the budget owner',
};
export const DURATIONS: readonly AccessDuration[] = ['8h', '24h', '7d', '30d', 'standing'];
export const STEP_KIND_LABELS: Readonly<Record<StepKind, string>> = {
  manager: 'Manager', steward: 'Steward', 'access-admin': 'Access admin',
};
export const EVENT_LABELS: Readonly<Record<AccessEventKind, string>> = {
  submitted: 'Submitted', 'step-approved': 'Step approved', 'step-rejected': 'Step rejected',
  'info-requested': 'Information requested', withdrawn: 'Withdrawn', approved: 'Approved',
  provisioned: 'Provisioned', expired: 'Expired', revoked: 'Revoked', 'sod-override': 'Policy override',
  'sod-blocked': 'Blocked by policy',
  'policy-updated': 'Policy updated',
  escalated: 'Escalated', delegated: 'Delegated', 'delegation-ended': 'Delegation ended',
};

/** A role id in words: "sme" is "SME", "org-leader" is "Org leader" (the audit, the policies, the review items). */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  sme: 'SME', 'org-leader': 'Org leader', 'hr-admin': 'HR admin', 'program-owner': 'Program owner', member: 'Member',
  assessor: 'Assessor', 'lead-assessor': 'Lead assessor', 'program-lead': 'Program lead',
  participant: 'Participant', moderator: 'Moderator', 'community-admin': 'Community admin',
  author: 'Author', operator: 'Operator', 'pipeline-admin': 'Pipeline admin',
  requester: 'Requester', approver: 'Approver', 'access-admin': 'Access admin', admin: 'Platform admin',
  'budgets-reader': 'Budget visibility',
};
export function roleLabel(role: string): string {
  const known = ROLE_LABELS[role];
  if (known) return known;
  const spaced = role.replaceAll('-', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** "draft" is "Draft": a status as a word at the start of a cell. */
export function statusWord(status: string): string {
  const spaced = status.replaceAll('-', ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const STATUS_TONE: Readonly<Record<RequestStatus, Tone>> = {
  draft: 'neutral', submitted: 'info', pending: 'info', approved: 'success', provisioned: 'success',
  active: 'success', expired: 'neutral', revoked: 'warning', rejected: 'danger', withdrawn: 'neutral',
};
export function statusTone(status: RequestStatus): Tone { return STATUS_TONE[status] ?? 'neutral'; }
export function statusLabel(status: string): string { return status.replaceAll('-', ' '); }

const STEP_TONE: Readonly<Record<StepStatus, Tone>> = {
  waiting: 'neutral', current: 'info', approved: 'success', rejected: 'danger', 'info-requested': 'caution', skipped: 'neutral',
};
export function stepTone(status: StepStatus): Tone { return STEP_TONE[status] ?? 'neutral'; }

/** Statuses a request leaves only by an exit nobody can undo. */
export const TERMINAL: ReadonlySet<RequestStatus> = new Set(['expired', 'revoked', 'rejected', 'withdrawn']);
/** Open: still waiting on a person. */
export const OPEN: ReadonlySet<RequestStatus> = new Set(['draft', 'submitted', 'pending']);

/** The status filter the Requests toolbar and its command phrases share. */
export const REQUEST_STATUS_FILTERS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'open', label: 'Open' },
  { value: 'approved', label: 'Approved' },
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
];
export function matchesStatusFilter(status: RequestStatus, filter: string): boolean {
  if (!filter) return true;
  if (filter === 'open') return OPEN.has(status);
  if (filter === 'approved') return status === 'approved';
  if (filter === 'active') return status === 'provisioned' || status === 'active';
  if (filter === 'closed') return TERMINAL.has(status);
  return false;
}

// ── Row text, search and filters (the toolbar and the command composer share these) ──

const has = (q: string, ...values: Array<string | null | undefined>) => {
  const needle = q.trim().toLowerCase();
  return !needle || values.some((v) => (v ?? '').toLowerCase().includes(needle));
};

export function catalogLabel(item: Pick<CatalogItem, 'kind' | 'tenant' | 'role' | 'projectId'>): string {
  if (item.kind === 'initiative-membership') return `member of ${item.projectId ?? 'an initiative'}`;
  return `${item.role ?? (item.kind === 'capability' ? 'capability' : 'role')} in ${TENANT_LABELS[item.tenant] ?? item.tenant}`;
}

export function filterCatalog(rows: readonly CatalogItem[], query: string, tenant: string): CatalogItem[] {
  return rows.filter((r) => (!tenant || r.tenant === tenant)
    && has(query, r.id, r.title, r.description, r.role, r.projectId, TENANT_LABELS[r.tenant]));
}

export function filterRequests(rows: readonly AccessRequest[], query: string, status: string): AccessRequest[] {
  return rows.filter((r) => matchesStatusFilter(r.status, status)
    && has(query, r.id, r.item.title, r.requester.displayName, r.beneficiary.displayName, r.justification, r.status));
}

export function filterPolicies(rows: readonly AccessPolicy[], query: string, severity: string): AccessPolicy[] {
  return rows.filter((r) => (!severity || r.severity === severity)
    && has(query, r.id, r.title, r.reason, `${r.left.tenant} ${r.left.role}`, `${r.right.tenant} ${r.right.role}`, roleLabel(r.left.role), roleLabel(r.right.role)));
}

export function filterEvents(rows: readonly AccessEvent[], query: string, kind: string): AccessEvent[] {
  return rows.filter((r) => (!kind || r.kind === kind)
    && has(query, r.id, r.requestId, r.policyId, r.subject, r.actor?.displayName ?? 'system', EVENT_LABELS[r.kind], r.reason, r.before, r.after));
}

/** A request's title for the table and `open <title>`: the item it asks for, for whom. */
export function requestTitle(r: AccessRequest): string {
  return r.requester.id === r.beneficiary.id ? r.item.title : `${r.item.title} for ${r.beneficiary.displayName}`;
}

/** The step that waits on a person now, or null. */
export function currentStep(r: Pick<AccessRequest, 'steps'>): RequestStep | null {
  return r.steps.find((s) => s.status === 'current' || s.status === 'info-requested') ?? null;
}

/** The approval chain as the library `WorkflowStepper`'s steps. */
export function chainSteps(steps: readonly RequestStep[]): Array<{ step: number; label: string; done: boolean; active: boolean }> {
  return steps.map((s) => ({
    step: s.step,
    label: `${STEP_KIND_LABELS[s.kind] ?? s.kind}${s.status === 'rejected' ? ' — rejected' : s.status === 'skipped' ? ' — skipped' : ''}`,
    done: s.status === 'approved' || s.status === 'skipped',
    active: s.status === 'current' || s.status === 'info-requested' || s.status === 'rejected',
  }));
}

/** Who may decide a step, for display (the server decides). A closed request's undecided step claims no one. */
export function eligibleLabel(step: RequestStep, status?: RequestStatus): string {
  if (step.decidedBy) return decidedByLabel(step) ?? step.decidedBy.displayName;
  if (status && !OPEN.has(status)) return '—';
  if (step.status === 'skipped') return '—';
  if (!step.eligible.length) return 'No one can decide this step';
  return step.eligible.map((p) => (p.onBehalfOf ? `${p.displayName} (for ${p.onBehalfOf.displayName})` : p.displayName)).join(', ');
}

/** Who decided a step, naming the approver a delegate acted for. */
export function decidedByLabel(step: Pick<RequestStep, 'decidedBy' | 'decidedOnBehalfOf'>): string | null {
  if (!step.decidedBy) return null;
  return step.decidedOnBehalfOf ? `${step.decidedBy.displayName}, on behalf of ${step.decidedOnBehalfOf.displayName}` : step.decidedBy.displayName;
}

/** The escalation line for a step that waits on a person: where it stands and when it moves next, or null. */
export function escalationLabel(step: Pick<RequestStep, 'escalationLevel' | 'escalatesAt' | 'status'>, now: number = Date.now()): string | null {
  const level = step.escalationLevel ?? 0;
  const tier = level >= 2 ? 'the platform admins' : 'the access admins';
  const reached = level > 0 ? `Escalated to ${tier}.` : null;
  if (!step.escalatesAt || (step.status !== 'current')) return reached;
  const next = level === 0 ? 'the access admins' : 'the platform admins';
  const ms = Date.parse(step.escalatesAt) - now;
  const when = ms <= 0 ? 'at the next sweep' : `in ${relativeSpan(ms)}`;
  return `${reached ? `${reached} ` : ''}Escalates to ${next} ${when} if undecided.`;
}

function relativeSpan(ms: number): string {
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

/** Where an audit event opens: its request, or the changed policy's own record
 *  page (`policy-updated` names `policyId`); the policies list only when an
 *  event names neither. */
export function eventHref(e: Pick<AccessEvent, 'requestId' | 'policyId'> & { delegationId?: string | null }): string {
  if (e.requestId) return requestHref(e.requestId);
  if (e.delegationId) return DELEGATIONS_HREF;
  return e.policyId ? policyHref(e.policyId) : '/access/policies';
}

export function policyHref(id: string): string { return `/access/policies/${encodeURIComponent(id)}`; }

// ── The request form (who → what → why → how long, on one page) ─────────────

export const JUSTIFICATION_MIN = 20;

export interface RequestDraft {
  beneficiaryId: string;
  itemId: string;
  justification: string;
  duration: AccessDuration | '';
  /** The extra reason a standing grant needs (design A6). */
  standingReason: string;
}

export const EMPTY_DRAFT: RequestDraft = { beneficiaryId: '', itemId: '', justification: '', duration: '', standingReason: '' };

export type RequestSection = 'who' | 'what' | 'why' | 'howLong';

/** What blocks each section of the request form, or null when it is complete. The SoD verdict is the server's (the preview), not this. */
export function sectionProblems(draft: RequestDraft, item: CatalogItem | null): Record<RequestSection, string | null> {
  const n = draft.justification.trim().length;
  const duration = draft.duration || item?.defaultDuration || '';
  return {
    who: draft.beneficiaryId ? null : 'Choose who the access is for.',
    what: item ? null : 'Choose what to request from the catalog.',
    why: n >= JUSTIFICATION_MIN ? null : `Say why in at least ${JUSTIFICATION_MIN} characters (${n} so far).`,
    howLong: !duration ? 'Choose how long the access should last.'
      : duration === 'standing' && draft.standingReason.trim().length < JUSTIFICATION_MIN
        ? `Standing access needs its own reason of at least ${JUSTIFICATION_MIN} characters.` : null,
  };
}

/** One step of the chain `POST /requests/preview` computed (docs/access-tenant-api.md). */
export interface PreviewStep { step: number; kind: StepKind; eligible: AccessPerson[]; escalated: string | null }

/** `POST /api/access/requests/preview`: the chain, SoD check and expiry a submit would produce, written nowhere. */
export interface AccessRequestPreview {
  item: CatalogItem;
  beneficiary: AccessPerson;
  steps: PreviewStep[];
  sod: { verdict: 'clear' | SodSeverity; conflicts: SodConflict[] };
  duration: AccessDuration;
  expiresIfProvisionedNow: string | null;
  refusal: null | { status: number; error: string; requestId?: string };
}

/** Who decides a previewed step, in words. */
export function previewStepLabel(s: PreviewStep): string {
  if (!s.eligible.length) return 'No one can decide this step';
  return s.eligible.map((p) => p.displayName).join(', ');
}

/** "Tue, Oct 20, 2026" — the concrete end of a time-bound grant. */
export function expiryDateLabel(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/** The summary's "Until" line: the date a grant approved now would end, or why there is none. */
export function untilLabel(duration: AccessDuration, expiresIfProvisionedNow: string | null): string {
  if (duration === 'standing' || !expiresIfProvisionedNow) return 'No end date — standing access';
  return `${expiryDateLabel(expiresIfProvisionedNow)} — ${DURATION_LABELS[duration]} from approval`;
}

/** The POST body (`docs/access-tenant-api.md`): only the keys the route accepts. */
export function submitBody(draft: RequestDraft, selfId: string): { itemId: string; justification: string; duration: AccessDuration; beneficiaryId?: string } {
  if (!draft.duration) throw new Error('Choose a duration before submitting.');
  const justification = draft.duration === 'standing'
    ? `${draft.justification.trim()}\n\nStanding access: ${draft.standingReason.trim()}`
    : draft.justification.trim();
  return {
    itemId: draft.itemId, justification, duration: draft.duration,
    ...(draft.beneficiaryId && draft.beneficiaryId !== selfId ? { beneficiaryId: draft.beneficiaryId } : {}),
  };
}

/** The detail route of one request. */
export function requestHref(id: string): string { return `/access/requests/${encodeURIComponent(id)}`; }

// ── Access reviews (lane A2) ────────────────────────────────────────────────

/** The SoD override's minimum reason (routes/access.ts MIN_OVERRIDE_REASON). */
export const OVERRIDE_REASON_MIN = 20;
/** A review campaign's title bounds (routes/access.ts). */
export const REVIEW_TITLE_MIN = 3;
export const REVIEW_TITLE_MAX = 200;

/** The record route of one review campaign. */
export function reviewHref(id: string): string { return `/access/reviews/${encodeURIComponent(id)}`; }

/** The Reviews toolbar's status filter (and its command phrases). */
export function filterReviews(rows: readonly AccessReview[], query: string, status: string): AccessReview[] {
  return rows.filter((r) => (!status || r.status === status)
    && has(query, r.id, r.title, TENANT_LABELS[r.tenant], r.owner?.displayName));
}

/** "2 of 4 decided", for the campaign table and the record's progress bar. */
export function reviewProgressLabel(p: AccessReview['progress']): string {
  return `${p.decided} of ${p.total} decided`;
}

/**
 * A requester's own standing in a review campaign (UX walk D): the campaign's progress is the reviewers'
 * view, so someone who cannot decide reads only their own grants' state, or that nothing of theirs is in it.
 */
export function ownReviewStanding(items: readonly Pick<AccessReviewItem, 'role' | 'tenant' | 'decision'>[]): { title: string; description: string } {
  if (items.length === 0) {
    return { title: 'Nothing of yours is under review', description: 'None of your standing grants is in this campaign, so there is nothing here for you to follow.' };
  }
  const state = (d: AccessReviewItem['decision']) => (d === 'keep' ? 'kept' : d === 'revoke' ? 'revoked' : 'waiting for a reviewer');
  const lines = items.map((i) => `${roleLabel(i.role)} in ${TENANT_LABELS[i.tenant] ?? 'another workspace'}: ${state(i.decision)}`);
  const waiting = items.filter((i) => i.decision === null).length;
  return {
    title: waiting ? `${waiting === 1 ? 'One of your grants is' : `${waiting} of your grants are`} under review` : 'Your grants in this review are decided',
    description: `${lines.join('; ')}. The campaign's owner or an access admin decides; a revoke reaches you as a revocation request.`,
  };
}

/** A review item's title for the table and `open <title>`: who holds what. */
export function reviewItemTitle(i: AccessReviewItem): string {
  return `${i.user.displayName} · ${roleLabel(i.role)}`;
}

/** A campaign's deadline as the page says it: "Closes in 9 days", or why there is none. */
export function reviewDeadlineLabel(r: Pick<AccessReview, 'status' | 'closesAt'>, now: number = Date.now()): string | null {
  if (r.status === 'closed' || !r.closesAt) return null;
  const ms = Date.parse(r.closesAt) - now;
  if (ms <= 0) return 'Past its deadline';
  const days = Math.round(ms / 86_400_000);
  if (days < 1) return 'Closes today';
  return `Closes in ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** The record's decision filter: open (undecided), keep or revoke. */
export function filterReviewItems(rows: readonly AccessReviewItem[], query: string, decision: string): AccessReviewItem[] {
  return rows.filter((i) => (!decision || (decision === 'open' ? i.decision === null : i.decision === decision))
    && has(query, i.id, i.user.displayName, i.role, i.comment, i.decidedBy?.displayName));
}

/** What blocks a review decision, or null when it may be sent: a revoke states its reason. */
export function reviewDecisionProblem(decision: ReviewDecision, comment: string): string | null {
  return decision === 'revoke' && !comment.trim() ? 'A revoke needs a comment: it becomes the revocation’s reason.' : null;
}

/** What blocks a new campaign, or null. */
export function campaignProblem(tenant: string, title: string): string | null {
  if (!tenant) return 'Choose the workspace whose standing grants to review.';
  return campaignTitleProblem(title);
}

/** What blocks a campaign's title, or null. */
export function campaignTitleProblem(title: string): string | null {
  const n = title.trim().length;
  if (n < REVIEW_TITLE_MIN) return `Give the campaign a title of at least ${REVIEW_TITLE_MIN} characters.`;
  if (n > REVIEW_TITLE_MAX) return `Keep the title under ${REVIEW_TITLE_MAX} characters.`;
  return null;
}

/** What blocks an SoD override, or null. */
export function overrideProblem(reason: string): string | null {
  const n = reason.trim().length;
  return n >= OVERRIDE_REASON_MIN ? null : `Say why the conflict is acceptable in at least ${OVERRIDE_REASON_MIN} characters (${n} so far).`;
}

/** Whose events GET /api/access/audit returns to this role (routes/access.ts: the request read rule). */
export function auditScopeNotice(role: string | null | undefined): string {
  return role === 'access-admin' || role === 'admin'
    ? 'You see every event in the access workspace.'
    : 'You see the events of requests you may open: yours, your reports’, and those you decided or may decide.';
}

// ── Configuration (GET/PUT /api/access/configuration) ──────────────────────

/** Unsaved per-item edits on the configuration page. */
export type ConfigurationEdits = Record<string, { defaultDuration?: AccessDuration; sensitive?: boolean }>;

/** The PUT body: only the items whose stored values differ from what was read. */
export function configurationPatch(items: readonly AccessConfiguration['items'][number][], edits: ConfigurationEdits): { items: Array<{ id: string; defaultDuration?: AccessDuration; sensitive?: boolean }> } {
  const out: Array<{ id: string; defaultDuration?: AccessDuration; sensitive?: boolean }> = [];
  for (const i of items) {
    const e = edits[i.id];
    if (!e) continue;
    const patch = {
      ...(e.defaultDuration !== undefined && e.defaultDuration !== i.defaultDuration ? { defaultDuration: e.defaultDuration } : {}),
      ...(e.sensitive !== undefined && e.sensitive !== i.sensitive ? { sensitive: e.sensitive } : {}),
    };
    if (Object.keys(patch).length) out.push({ id: i.id, ...patch });
  }
  return { items: out };
}

// ── Delegation (2026-10-14, /access/settings) ────────────────────────────────

/** Where an approver's delegations live. */
export const DELEGATIONS_HREF = '/access/settings';
export const DELEGATION_REASON_MIN = 10;
/** The windows the delegation form offers, starting now (the server caps a window at 30 days). */
export const DELEGATION_WINDOWS: ReadonlyArray<{ value: string; label: string; hours: number }> = [
  { value: '1d', label: '1 day', hours: 24 },
  { value: '3d', label: '3 days', hours: 72 },
  { value: '7d', label: '1 week', hours: 168 },
  { value: '14d', label: '2 weeks', hours: 336 },
];

export interface DelegationDraft { delegateId: string; window: string; reason: string }
export const EMPTY_DELEGATION: DelegationDraft = { delegateId: '', window: '3d', reason: '' };

/** What is wrong with a delegation draft before it is sent, else null. */
export function delegationProblem(d: DelegationDraft): string | null {
  if (!d.delegateId) return 'Choose who decides for you.';
  if (!DELEGATION_WINDOWS.some((w) => w.value === d.window)) return 'Choose how long.';
  if (d.reason.trim().length < DELEGATION_REASON_MIN) return `Say why in at least ${DELEGATION_REASON_MIN} characters.`;
  return null;
}

/** POST /api/access/delegations body for a draft, starting at `now`. */
export function delegationBody(d: DelegationDraft, now: number = Date.now()): { delegateId: string; startsAt: string; endsAt: string; reason: string } {
  const hours = DELEGATION_WINDOWS.find((w) => w.value === d.window)?.hours ?? 72;
  return { delegateId: d.delegateId, startsAt: new Date(now).toISOString(), endsAt: new Date(now + hours * 3_600_000).toISOString(), reason: d.reason.trim() };
}

export const DELEGATION_STATE_TONE: Readonly<Record<AccessDelegation['state'], Tone>> = { scheduled: 'info', active: 'success', ended: 'neutral' };

/** "Oct 14 – Oct 17" in the viewer's zone. */
export function delegationWindowLabel(d: Pick<AccessDelegation, 'startsAt' | 'endsAt' | 'endedAt'>, locale?: string): string {
  const f = (iso: string) => new Date(iso).toLocaleDateString(locale ?? 'en-US', { month: 'short', day: 'numeric' });
  return `${f(d.startsAt)} – ${f(d.endedAt ?? d.endsAt)}${d.endedAt ? ' (ended early)' : ''}`;
}
