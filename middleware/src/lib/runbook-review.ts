// Who may decide a runbook proposal (docs/distillation-runbooks-design.md,
// "Decisions taken (user, 2026-10-14)" #1):
//
//   the runbook's OWNER, or an SME on the runbook's INITIATIVE, accepts;
//   `org-leader` and `admin` override; a proposer never accepts their own.
//
// Cedar's `ReviewRunbook` is the capability floor ("may this role ever review");
// this is the scope check on top of it ("may this person review THIS runbook"),
// the same two-layer shape as ManageSprints + requireInitiativeSteward
// (routes/sprints.ts). Cedar alone would let any SME accept a runbook for an
// initiative they have nothing to do with.
import type { Session } from './session.js';
import type { RunbookScope } from './runbooks/index.js';
import { stewardsInitiative } from './initiative-scope.js';

/** Roles that override the per-runbook scope. NOT hr-admin: the decision names org-leader and admin only. */
export const REVIEW_OVERRIDE_ROLES = ['org-leader', 'admin'] as const;
/** Roles whose attachment to the runbook's initiative counts as "SME on its initiative". */
const STEWARD_ROLES = ['sme', 'program-owner'] as const;

export type ReviewGrant = 'override' | 'owner' | 'initiative-steward';
export type ReviewVerdict = { ok: true; via: ReviewGrant } | { ok: false; reason: string };

/** The id a person acts under in runbook rows: their linked person (p-…), else the account subject. */
export async function actorId(session: Session): Promise<{ actor: string; personId: string | null }> {
  let personId: string | null = null;
  try {
    const { getUser } = await import('../providers/identity.js');
    personId = (await getUser(session.sub))?.personId ?? null;
  } catch { personId = null; }
  return { actor: personId ?? session.sub, personId };
}

/**
 * @param owner  the runbook's owner person id, or null when there is no runbook yet
 *               (accepting a `new` proposal): ownership cannot authorise creating one.
 */
export async function mayReviewRunbook(
  session: Session,
  scope: RunbookScope,
  owner: string | null,
): Promise<ReviewVerdict> {
  if ((REVIEW_OVERRIDE_ROLES as readonly string[]).includes(session.role)) return { ok: true, via: 'override' };
  const { actor, personId } = await actorId(session);
  if (owner && (owner === actor || owner === personId)) return { ok: true, via: 'owner' };
  if (scope.kind === 'initiative' && scope.ref
    && (STEWARD_ROLES as readonly string[]).includes(session.role)
    && await stewardsInitiative(session, scope.ref)) {
    return { ok: true, via: 'initiative-steward' };
  }
  return {
    ok: false,
    reason: scope.kind === 'initiative' && scope.ref
      ? `only the runbook's owner or an SME on ${scope.ref} can decide this`
      : `only the runbook's owner can decide this (scope ${scope.kind}${scope.ref ? ` ${scope.ref}` : ''} has no initiative to steward)`,
  };
}
