// Delegation of an approver's decisions (2026-10-14; docs/access-tenant-api.md
// § "Escalation timers and delegation"). Pure functions over rows; the route
// (routes/access.ts) persists through providers/access.ts.
//
// An approver out of office hands their decisions to another eligible approver
// for a window. Whether a delegation is in force is never stored: it is the
// window compared with the clock, minus an early end. Who the delegate may
// decide for is resolved live with every other decider (lib/access/chain.ts
// `eligibility`), so a delegation never outlives the delegator's own right:
// demote the delegator and the delegate loses the steps too.
//
// The rules a new delegation must meet (each a refusal with its status):
//   400  no reason, a malformed or inverted window, a window longer than
//        MAX_DELEGATION_DAYS, or one that has already ended;
//   400  an unknown delegate;
//   403  delegating to yourself;
//   409  a delegate with no deciding role in Access (approver / access-admin);
//   409  a window overlapping one of the delegator's own that has not ended;
//   409  a delegate who is themselves delegating during the window (no chains,
//        no A→B→A loops);
//   409  a delegate who submitted or benefits from an open request waiting on
//        the delegator now ("no delegation to the requester": they could never
//        decide it, and the step would look covered while it is not).

import type { AccessDelegationRow } from '../../mock/access-delegations.js';
import { ACCESS_DECIDER_ROLES } from './chain.js';
import type { AccessDirectory, DirectoryUser } from './types.js';

export const MAX_DELEGATION_DAYS = 30;
export const MIN_DELEGATION_REASON = 10;
const DAY_MS = 86_400_000;

export type DelegationState = 'scheduled' | 'active' | 'ended';

/** Where a delegation stands at `now`: before its window, in force, or over (window passed or ended early). */
export function delegationState(d: Pick<AccessDelegationRow, 'startsAt' | 'endsAt' | 'endedAt'>, now: string): DelegationState {
  const t = Date.parse(now);
  if (d.endedAt !== null || Date.parse(d.endsAt) <= t) return 'ended';
  return Date.parse(d.startsAt) > t ? 'scheduled' : 'active';
}

const overlaps = (a: { startsAt: string; endsAt: string }, b: { startsAt: string; endsAt: string }): boolean =>
  Date.parse(a.startsAt) < Date.parse(b.endsAt) && Date.parse(b.startsAt) < Date.parse(a.endsAt);

const decides = (u: DirectoryUser): boolean => (u.grants['access'] ?? []).some((r) => ACCESS_DECIDER_ROLES.has(r));

export interface DelegationInput { delegateId: string; startsAt: string; endsAt: string; reason: string }

export type DelegationRefusal = { status: 400 | 403 | 409; error: string } | null;

/**
 * Why `delegatorId` may not delegate as asked now, or null. `waitingOnDelegator`
 * is the set of open requests whose current step the delegator may decide now
 * (the route resolves it live), as `{ id, requesterId, beneficiaryId }`.
 */
export function delegationRefusal(
  delegatorId: string,
  input: DelegationInput,
  dir: AccessDirectory,
  existing: readonly AccessDelegationRow[],
  waitingOnDelegator: ReadonlyArray<{ id: string; requesterId: string; beneficiaryId: string }>,
  now: string,
): DelegationRefusal {
  const start = Date.parse(input.startsAt);
  const end = Date.parse(input.endsAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return { status: 400, error: 'startsAt and endsAt must be ISO timestamps' };
  if (end <= start) return { status: 400, error: 'endsAt must be after startsAt' };
  if (end <= Date.parse(now)) return { status: 400, error: 'The window has already ended' };
  if (end - start > MAX_DELEGATION_DAYS * DAY_MS) return { status: 400, error: `A delegation lasts at most ${MAX_DELEGATION_DAYS} days` };
  if (input.reason.trim().length < MIN_DELEGATION_REASON) return { status: 400, error: `reason must be at least ${MIN_DELEGATION_REASON} characters` };
  if (input.delegateId === delegatorId) return { status: 403, error: 'You cannot delegate your decisions to yourself' };
  const delegate = dir.users.find((u) => u.id === input.delegateId);
  if (!delegate) return { status: 400, error: `Unknown delegate: ${input.delegateId}` };
  if (!decides(delegate)) return { status: 409, error: `${delegate.displayName} holds no deciding role in Access (approver or access admin)` };
  const window = { startsAt: input.startsAt, endsAt: input.endsAt };
  const live = existing.filter((d) => delegationState(d, now) !== 'ended');
  const own = live.find((d) => d.delegatorId === delegatorId && overlaps(d, window));
  if (own) return { status: 409, error: `${own.id} already hands your decisions on during that window; end it first` };
  const chained = live.find((d) => d.delegatorId === delegate.id && overlaps(d, window));
  if (chained) return { status: 409, error: `${delegate.displayName} is delegating their own decisions during that window (${chained.id}); a delegation is never passed on` };
  const party = waitingOnDelegator.find((r) => r.requesterId === delegate.id || r.beneficiaryId === delegate.id);
  if (party) return { status: 409, error: `${delegate.displayName} is a party to ${party.id}, which waits on your decision; delegate to someone else` };
  return null;
}
