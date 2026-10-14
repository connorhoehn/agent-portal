// The row rules Cedar cannot express (decision A5) and the per-actor views:
//
//   * nobody decides a request they submitted or benefit from — 403 naming it;
//   * only someone eligible NOW (lib/access/chain.ts) decides a step — 403;
//   * a step is decided once — 409 (lib/access/status.ts);
//   * the read rule: requester, beneficiary, the beneficiary's manager, anyone
//     eligible on or having decided a step, and access-admin / admin.
//
// Cedar still gates the route (DecideAccess etc.); these run after it.

import type { AccessCatalogRow } from '../../mock/access-catalog.js';
import type { AccessRequestRow, AccessStepRow } from '../../mock/access-requests.js';
import { eligibleDeciders } from './chain.js';
import { currentStep, isOpen, stepDecided } from './status.js';
import type { AccessDirectory } from './types.js';

export const OWN_REQUEST_ERROR = 'You cannot decide your own request';

/** The signed-in actor as the rules need it. */
export interface AccessActor {
  id: string;
  personId: string | null;
  /** The session's active role (access-admin and admin read everything). */
  role: string;
  /** Cedar's answer for DecideAccess / ProvisionAccess on this session. */
  mayDecide: boolean;
  mayProvision: boolean;
  /** Cedar's answer for ManageAccessPolicy (the SoD override, lane A2); absent = no. */
  mayManagePolicy?: boolean;
}

export const isParty = (actorId: string, r: Pick<AccessRequestRow, 'requesterId' | 'beneficiaryId'>): boolean =>
  r.requesterId === actorId || r.beneficiaryId === actorId;

/** Is the actor the beneficiary's manager through people.manager_id, now? */
export function managesBeneficiary(actor: AccessActor, r: Pick<AccessRequestRow, 'beneficiaryId'>, dir: AccessDirectory): boolean {
  if (!actor.personId) return false;
  const beneficiary = dir.users.find((u) => u.id === r.beneficiaryId);
  return !!beneficiary?.personId && dir.managerOf(beneficiary.personId) === actor.personId;
}

export function mayRead(actor: AccessActor, r: AccessRequestRow, steps: readonly AccessStepRow[], item: AccessCatalogRow | undefined, dir: AccessDirectory): boolean {
  if (isParty(actor.id, r)) return true;
  if (actor.role === 'access-admin' || actor.role === 'admin') return true;
  if (managesBeneficiary(actor, r, dir)) return true;
  if (steps.some((s) => s.decidedBy === actor.id)) return true;
  if (!item || !isOpen(r.status)) return false;
  return steps.some((s) => !stepDecided(s) && eligibleDeciders(s.kind, item, r, dir, s.escalationLevel).some((p) => p.id === actor.id));
}

/** Why the actor may not decide step `stepNo` now, or null when they may (the 409 cases are status.ts's). */
export function decideRefusal(actor: AccessActor, r: AccessRequestRow, steps: readonly AccessStepRow[], stepNo: number, item: AccessCatalogRow, dir: AccessDirectory): { status: 403; error: string } | null {
  if (isParty(actor.id, r)) {
    const as = r.requesterId === actor.id && r.beneficiaryId === actor.id ? 'submitted and benefit from'
      : r.requesterId === actor.id ? 'submitted' : 'benefit from';
    return { status: 403, error: `${OWN_REQUEST_ERROR} — you ${as} ${r.id}` };
  }
  if (!actor.mayDecide) return { status: 403, error: 'Deciding requests needs DecideAccess' };
  const step = steps.find((s) => s.step === stepNo);
  // A decided / missing / not-yet-current step is a 409 the status machine names.
  if (!step || stepDecided(step) || currentStep(steps)?.step !== stepNo || !isOpen(r.status)) return null;
  if (!eligibleDeciders(step.kind, item, r, dir, step.escalationLevel).some((p) => p.id === actor.id)) {
    return { status: 403, error: `You are not eligible to decide step ${stepNo} (${step.kind}) of ${r.id}` };
  }
  return null;
}

/** What the actor may do with the request now. */
export function canFlags(actor: AccessActor, r: AccessRequestRow, steps: readonly AccessStepRow[], item: AccessCatalogRow | undefined, dir: AccessDirectory): { decide: boolean; withdraw: boolean; viewAudit: boolean } {
  const party = isParty(actor.id, r);
  const cur = currentStep(steps);
  const decide = !party && actor.mayDecide && isOpen(r.status) && !!cur && !!item
    && eligibleDeciders(cur.kind, item, r, dir, cur.escalationLevel).some((p) => p.id === actor.id);
  return { decide, withdraw: party && isOpen(r.status), viewAudit: party || actor.mayDecide };
}
