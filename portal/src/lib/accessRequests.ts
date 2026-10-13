// The access tenant's wire shapes and the pure helpers its pages share
// (docs/access-tenant-api.md is the contract the middleware lane builds
// against; docs/access-tenant-design.md §3–§6 the model). No React here, so
// `pages/access/__tests__/*.test.ts` run it under plain `node --test`.

export type AccessKind = 'tenant-role' | 'initiative-membership';
export type AccessDuration = '8h' | '24h' | '7d' | '30d' | 'standing';
export type RequestStatus = 'draft' | 'submitted' | 'pending' | 'approved' | 'provisioned' | 'active'
  | 'expired' | 'revoked' | 'rejected' | 'withdrawn';
export type StepKind = 'manager' | 'steward' | 'access-admin';
export type StepStatus = 'waiting' | 'current' | 'approved' | 'rejected' | 'info-requested' | 'skipped';
export type AccessTenant = 'orgiq' | 'assessment' | 'social' | 'pipelines';
export type SodSeverity = 'warn' | 'block';
export type Decision = 'approve' | 'reject' | 'info';
export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'caution' | 'accent';

export interface SodConflict { policyId: string; reason: string; severity: SodSeverity }

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
  stewardRule: 'tenant-steward' | 'initiative-owner';
  heldByActor: boolean;
  sodConflicts: SodConflict[];
}

export interface AccessPerson { id: string; displayName: string; personId?: string | null }

export interface RequestStep {
  step: number;
  kind: StepKind;
  status: StepStatus;
  decidedBy?: AccessPerson | null;
  decidedAt?: string | null;
  comment?: string | null;
  /** Who may decide it now, resolved live by the server: shown, never trusted. */
  eligible: AccessPerson[];
}

export interface AccessRequest {
  id: string;
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
  can: { decide: boolean; withdraw: boolean; viewAudit: boolean };
  thread: string;
}

export interface AccessPolicy {
  id: string; title: string; reason: string; severity: SodSeverity;
  left: { tenant: string; role: string }; right: { tenant: string; role: string };
  updatedAt: string; updatedBy?: AccessPerson | null;
}

export type AccessEventKind = 'submitted' | 'step-approved' | 'step-rejected' | 'info-requested' | 'withdrawn'
  | 'approved' | 'provisioned' | 'expired' | 'revoked' | 'sod-override' | 'policy-updated';

export interface AccessEvent {
  id: string; at: string; requestId: string; actor: AccessPerson | null;
  kind: AccessEventKind;
  before?: string | null; after?: string | null; reason?: string | null;
}

export interface ItemsResponse<T> { items: T[]; limits?: unknown }

export const ACCESS_API = '/api/access';

// ── Vocabulary ─────────────────────────────────────────────────────────────

export const TENANT_LABELS: Readonly<Record<AccessTenant, string>> = {
  orgiq: 'Work', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines',
};
export const KIND_LABELS: Readonly<Record<AccessKind, string>> = {
  'tenant-role': 'Workspace role', 'initiative-membership': 'Initiative membership',
};
export const DURATION_LABELS: Readonly<Record<AccessDuration, string>> = {
  '8h': '8 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days', standing: 'Standing',
};
export const DURATIONS: readonly AccessDuration[] = ['8h', '24h', '7d', '30d', 'standing'];
export const STEP_KIND_LABELS: Readonly<Record<StepKind, string>> = {
  manager: 'Manager', steward: 'Steward', 'access-admin': 'Access admin',
};
export const EVENT_LABELS: Readonly<Record<AccessEventKind, string>> = {
  submitted: 'Submitted', 'step-approved': 'Step approved', 'step-rejected': 'Step rejected',
  'info-requested': 'Information requested', withdrawn: 'Withdrawn', approved: 'Approved',
  provisioned: 'Provisioned', expired: 'Expired', revoked: 'Revoked', 'sod-override': 'Policy override',
  'policy-updated': 'Policy updated',
};

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
  return item.kind === 'tenant-role'
    ? `${item.role ?? 'role'} in ${TENANT_LABELS[item.tenant] ?? item.tenant}`
    : `member of ${item.projectId ?? 'an initiative'}`;
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
    && has(query, r.id, r.title, r.reason, `${r.left.tenant} ${r.left.role}`, `${r.right.tenant} ${r.right.role}`));
}

export function filterEvents(rows: readonly AccessEvent[], query: string, kind: string): AccessEvent[] {
  return rows.filter((r) => (!kind || r.kind === kind)
    && has(query, r.id, r.requestId, r.actor?.displayName ?? 'system', EVENT_LABELS[r.kind], r.reason, r.before, r.after));
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

/** Who may decide a step, for display (the server decides). */
export function eligibleLabel(step: RequestStep): string {
  if (step.decidedBy) return step.decidedBy.displayName;
  if (!step.eligible.length) return 'No one is eligible yet';
  return step.eligible.map((p) => p.displayName).join(', ');
}

// ── The request wizard (who → what → why → how long) ───────────────────────

export const JUSTIFICATION_MIN = 20;
export const WIZARD_STEPS = ['Who', 'What', 'Why', 'How long'] as const;

export interface RequestDraft {
  beneficiaryId: string;
  itemId: string;
  justification: string;
  duration: AccessDuration | '';
  /** The extra reason a standing grant needs (design A6). */
  standingReason: string;
}

export const EMPTY_DRAFT: RequestDraft = { beneficiaryId: '', itemId: '', justification: '', duration: '', standingReason: '' };

/** What blocks each wizard step, or null when it may advance. */
export function draftProblem(step: number, draft: RequestDraft, item: CatalogItem | null): string | null {
  if (step === 0) return draft.beneficiaryId ? null : 'Choose who the access is for.';
  if (step === 1) {
    if (!item) return 'Choose what to request from the catalog.';
    if (item.sodConflicts.some((c) => c.severity === 'block')) return 'A separation-of-duties policy blocks this item; an access admin must override it.';
    return null;
  }
  if (step === 2) {
    const n = draft.justification.trim().length;
    return n >= JUSTIFICATION_MIN ? null : `Say why in at least ${JUSTIFICATION_MIN} characters (${n} so far).`;
  }
  if (!draft.duration) return 'Choose how long the access should last.';
  if (draft.duration === 'standing' && draft.standingReason.trim().length < JUSTIFICATION_MIN) {
    return `Standing access needs its own reason of at least ${JUSTIFICATION_MIN} characters.`;
  }
  return null;
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
