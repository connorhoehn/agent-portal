// The budgets read tier as the Initiatives page sees it (decided 2026-10-13).
//
// Below the tier the server withholds `agentSpendUsd` / `allocatedUsd` and
// hands each row `budgetAccess: { visible: false, reason, requestItemId }`
// (middleware lib/budget-read-tier.ts). The page renders a locked cell, never
// a zero, and offers ONE quick request for the tier from where the reader is:
// `POST /api/access-requests/quick` files an ordinary access request that
// managers / the budget owner decide in Access; once it is provisioned the
// grants refresh carries it to the open cookie and the figures appear.
//
// Pure: no React, so `__tests__/budgetAccessModel.test.ts` runs under node --test.

import type { AccessDuration, AccessRequest } from '../../lib/accessRequests';
import type { BudgetAccessLocked, ProjectSummary } from './types';

export const QUICK_REQUEST_API = '/api/access-requests';
/** The query a locked budget answer links to: the Initiatives page opens the request form. */
export const REQUEST_PARAM = 'request';
export const REQUEST_PARAM_VALUE = 'budget-access';
export const JUSTIFICATION_MIN = 20;
/** Durations offered here; `standing` needs a second reason, so it stays in the Access wizard. */
export const QUICK_DURATIONS: readonly AccessDuration[] = ['24h', '7d', '30d'];
export const DEFAULT_QUICK_DURATION: AccessDuration = '30d';

/** The server's lock, when any loaded row carries one (the tier is per reader, so one row speaks for all). */
export function budgetLock(rows: readonly ProjectSummary[] | null | undefined): BudgetAccessLocked | null {
  return rows?.find((r) => r.budgetAccess && r.budgetAccess.visible === false)?.budgetAccess ?? null;
}

export function mineUrl(itemId: string): string {
  return `${QUICK_REQUEST_API}/mine?itemId=${encodeURIComponent(itemId)}`;
}

const OPEN = new Set(['draft', 'submitted', 'pending']);

/** What the header shows: the button, an open request's status, or a granted request awaiting the refresh. */
export type QuickRequestState =
  | { kind: 'none' }
  | { kind: 'open'; request: AccessRequest; waitingOn: string }
  | { kind: 'approved'; request: AccessRequest }
  | { kind: 'granted'; request: AccessRequest };

/** The newest request decides; a closed one (rejected, withdrawn, expired, revoked) lets the reader ask again. */
export function quickRequestState(items: readonly AccessRequest[] | null | undefined): QuickRequestState {
  const newest = [...(items ?? [])].sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
  if (!newest) return { kind: 'none' };
  if (OPEN.has(newest.status)) return { kind: 'open', request: newest, waitingOn: waitingOn(newest) };
  if (newest.status === 'approved') return { kind: 'approved', request: newest };
  if (newest.status === 'provisioned' || newest.status === 'active') return { kind: 'granted', request: newest };
  return { kind: 'none' };
}

/** Who the request waits on now, as the server resolved it (shown, never trusted): names, or the step's kind. */
export function waitingOn(r: AccessRequest): string {
  const current = r.steps.find((s) => s.status === 'current' || s.status === 'info-requested');
  if (!current) return 'an approver';
  const names = current.eligible.map((p) => p.displayName);
  if (names.length === 0) return current.kind === 'manager' ? 'your manager' : 'an approver';
  if (names.length <= 2) return names.join(' or ');
  return `${names[0]} or ${names.length - 1} others`;
}

/** The status line for an open request: what is true and who acts next. */
export function openStatusText(state: Extract<QuickRequestState, { kind: 'open' }>): string {
  return state.request.status === 'pending' && state.request.steps.some((s) => s.status === 'info-requested')
    ? `Requested — ${state.waitingOn} asked for more information`
    : `Requested — waiting on ${state.waitingOn}`;
}

/** Where "View request" goes: the Access record when the reader can open Access, else nowhere (the bell carries the decision). */
export function requestHref(id: string, grants: Readonly<Record<string, readonly string[]>> | null | undefined): string | null {
  return (grants?.['access']?.length ?? 0) > 0 ? `/access/requests/${encodeURIComponent(id)}` : null;
}

/** Why the form cannot be sent yet, or null. The server checks the same and is the authority. */
export function quickRequestProblem(justification: string, duration: AccessDuration | ''): string | null {
  const n = justification.trim().length;
  if (n < JUSTIFICATION_MIN) return `Say why in at least ${JUSTIFICATION_MIN} characters (${n} so far)`;
  if (!duration || !QUICK_DURATIONS.includes(duration)) return 'Choose how long you need it';
  return null;
}
