// The request status machine (docs/access-tenant-design.md §3):
//
//   draft → submitted → pending → approved → provisioned → active → expired | revoked
//                    ↘ rejected            ↘ withdrawn (from draft/submitted/pending)
//
// A0 stops at `approved`: provisioning (A1) is the only path that moves a
// request on and the only one that touches the grant store. Pure functions over
// rows: the caller supplies `now` and persists what comes back.

import type { AccessRequestRow, AccessStepRow } from '../../mock/access-requests.js';
import type { AccessEventKind, Decision, RequestStatus, StepKind } from './types.js';

/** Statuses a request can still be decided or withdrawn in. */
export const OPEN_STATUSES: ReadonlySet<RequestStatus> = new Set(['draft', 'submitted', 'pending']);
/** Statuses that hold (or held) a provisioned grant. */
export const ELEVATED_STATUSES: ReadonlySet<RequestStatus> = new Set(['provisioned', 'active']);
const DECIDED_STEP = new Set(['approved', 'rejected', 'skipped']);

export const isOpen = (status: RequestStatus): boolean => OPEN_STATUSES.has(status);
export const stepDecided = (s: Pick<AccessStepRow, 'status'>): boolean => DECIDED_STEP.has(s.status);

/** The step awaiting a decision now (current or info-requested), if any. */
export function currentStep(steps: readonly AccessStepRow[]): AccessStepRow | null {
  return [...steps].sort((a, b) => a.step - b.step).find((s) => s.status === 'current' || s.status === 'info-requested') ?? null;
}

export interface Transition {
  request: AccessRequestRow;
  steps: AccessStepRow[];
  events: Array<{ kind: AccessEventKind; before: string | null; after: string | null; reason: string | null }>;
}

/** The rows a fresh submission writes: status `submitted`, step 1 current, the rest waiting. */
export function submitRows(request: Omit<AccessRequestRow, 'status' | 'decidedAt' | 'provisionedAt' | 'expiresAt' | 'revokedAt' | 'expiryWarnedAt'>, kinds: readonly StepKind[]): Transition {
  return {
    request: { ...request, status: 'submitted', decidedAt: null, provisionedAt: null, expiresAt: null, revokedAt: null, expiryWarnedAt: null },
    steps: kinds.map((kind, i) => ({ requestId: request.id, step: i + 1, kind, status: i === 0 ? 'current' : 'waiting', decidedBy: null, decidedAt: null, comment: null })),
    events: [{ kind: 'submitted', before: 'draft', after: 'submitted', reason: null }],
  };
}

export class TransitionError extends Error {
  constructor(public readonly status: 409, message: string) { super(message); }
}

/**
 * Apply a decision on step `stepNo` by `actorId`. Throws TransitionError(409)
 * when the request is not open, the step was already decided, or it is not
 * the step awaiting a decision. Authority (who may decide) is NOT checked
 * here — lib/access/rules.ts decides that before calling.
 */
export function decide(request: AccessRequestRow, steps: readonly AccessStepRow[], stepNo: number, decision: Decision, actorId: string, comment: string | null, now: string): Transition {
  const ordered = [...steps].sort((a, b) => a.step - b.step).map((s) => ({ ...s }));
  const target = ordered.find((s) => s.step === stepNo);
  if (!target) throw new TransitionError(409, `Request ${request.id} has no step ${stepNo}`);
  if (stepDecided(target)) throw new TransitionError(409, `Step ${stepNo} of ${request.id} was already decided`);
  if (!isOpen(request.status)) throw new TransitionError(409, `Request ${request.id} is ${request.status}; it takes no decisions`);
  if (currentStep(ordered)?.step !== stepNo) throw new TransitionError(409, `Step ${stepNo} of ${request.id} is not awaiting a decision yet`);

  const before = request.status;
  const next: AccessRequestRow = { ...request };
  const events: Transition['events'] = [];
  target.decidedBy = actorId;
  target.decidedAt = now;
  target.comment = comment;

  if (decision === 'info') {
    target.status = 'info-requested';
    next.status = 'pending';
    events.push({ kind: 'info-requested', before, after: next.status, reason: comment });
  } else if (decision === 'reject') {
    target.status = 'rejected';
    for (const s of ordered) if (s.step > stepNo && !stepDecided(s)) s.status = 'skipped';
    next.status = 'rejected';
    next.decidedAt = now;
    events.push({ kind: 'step-rejected', before, after: next.status, reason: comment });
  } else {
    target.status = 'approved';
    const following = ordered.find((s) => s.step > stepNo && s.status === 'waiting');
    if (following) {
      following.status = 'current';
      next.status = 'pending';
      events.push({ kind: 'step-approved', before, after: next.status, reason: comment });
    } else {
      next.status = 'approved';
      next.decidedAt = now;
      events.push({ kind: 'step-approved', before, after: next.status, reason: comment });
      events.push({ kind: 'approved', before, after: next.status, reason: null });
    }
  }
  return { request: next, steps: ordered, events };
}

/** Withdraw an open request; every undecided step is skipped. 409 once it left the open states. */
export function withdraw(request: AccessRequestRow, steps: readonly AccessStepRow[], reason: string | null): Transition {
  if (!isOpen(request.status)) throw new TransitionError(409, `Request ${request.id} is ${request.status}; only an open request can be withdrawn`);
  const ordered = [...steps].sort((a, b) => a.step - b.step).map((s) => (stepDecided(s) ? { ...s } : { ...s, status: 'skipped' as const }));
  return {
    request: { ...request, status: 'withdrawn' },
    steps: ordered,
    events: [{ kind: 'withdrawn', before: request.status, after: 'withdrawn', reason }],
  };
}
