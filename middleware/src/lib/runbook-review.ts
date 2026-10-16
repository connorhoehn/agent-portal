// Who may decide a runbook proposal (docs/distillation-runbooks-design.md,
// "Decisions taken (user, 2026-10-14)" #1):
//
//   the runbook's OWNER, or an SME on the runbook's INITIATIVE, accepts;
//   `org-leader` and `admin` override; a proposer never accepts their own.
//   R8 (user, 2026-10-15): a runbook with no initiative (org/tool/repo scope) is a
//   cross-project skill; its stewards are the org-leader and the SMEs of its area
//   (the initiative it was captured on).
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

export type ReviewGrant = 'override' | 'owner' | 'initiative-steward' | 'library-steward';
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
  /** R8: the initiative a cross-project skill came from (Runbook.area, or a new proposal's work item's initiative). */
  area: string | null = null,
): Promise<ReviewVerdict> {
  if ((REVIEW_OVERRIDE_ROLES as readonly string[]).includes(session.role)) return { ok: true, via: 'override' };
  const { actor, personId } = await actorId(session);
  if (owner && (owner === actor || owner === personId)) return { ok: true, via: 'owner' };
  if (scope.kind === 'initiative' && scope.ref
    && (STEWARD_ROLES as readonly string[]).includes(session.role)
    && await stewardsInitiative(session, scope.ref)) {
    return { ok: true, via: 'initiative-steward' };
  }
  // R8 (user, 2026-10-15): a skill in the ONE org-wide library (a runbook with no initiative
  // scope) is accepted by anyone with ReviewRunbook at org scope — the org-leader (override,
  // above), plus any SME for skills in THEIR area: the initiative the skill came from (`area`,
  // a label kept on the runbook; scope no longer gates delivery). The route's Cedar gate
  // already required ReviewRunbook.
  if (scope.kind !== 'initiative' && area
    && (STEWARD_ROLES as readonly string[]).includes(session.role)
    && await stewardsInitiative(session, area)) {
    return { ok: true, via: 'library-steward' };
  }
  return {
    ok: false,
    reason: scope.kind === 'initiative' && scope.ref
      ? `only the runbook's owner or an SME on ${scope.ref} can decide this`
      : area
        ? `only the runbook's owner, an org-leader or an SME on ${area} (the skill's area) can decide this`
        : `only the runbook's owner or an org-leader can decide this (scope ${scope.kind}${scope.ref ? ` ${scope.ref}` : ''} has no initiative to steward)`,
  };
}
