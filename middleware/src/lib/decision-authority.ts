// Who may decide a waiting decision (G54, docs/voice-navigator-gaps.md):
//
//   the decision's assigned DECIDER (its `decision_participants` row with role
//   `decider`), or the OWNER of the initiative it was raised against; the
//   `org-leader` and `admin` override.
//
// Cedar's `DecideDecision` is the capability floor ("may this role ever
// decide"), held role-wide because anyone can be named a decider; this is the
// scope check on top of it ("may this person decide THIS decision"), the same
// two-layer shape as ReviewRunbook + lib/runbook-review.ts. The route asks it
// first and refuses with 403 NOT_DECIDER, because the local seed matrix ignores
// Cedar's `when` clauses; it then sends the answer to Cedar as `decidesThis`,
// which production's forbid (seeds/roles/orgiq/member.cedar) reads.
//
// Conservative like lib/initiative-scope.ts: an unresolvable caller (no linked
// person) or a failed lookup is NOT the decider.
import type { Session } from './session.js';

/** Roles that decide any decision. NOT hr-admin: G54 names org-leader (and admin). */
export const DECIDE_OVERRIDE_ROLES = ['org-leader', 'admin'] as const;

export type DecideGrant = 'override' | 'decider' | 'owner';
export type DecideVerdict =
  | { ok: true; via: DecideGrant; decidesThis: boolean }
  | { ok: false; decidesThis: false };

/** The decision fields the rule reads. */
export interface DecidableDecision {
  projectId: string | null;
  participants: ReadonlyArray<{ personId: string; role: string | null }>;
}

// Loaded lazily, as in lib/initiative-scope.ts: a module-scope import drags
// config.ts (import.meta) into every test that imports this file.
async function providers() {
  const [identity, projects] = await Promise.all([
    import('../providers/identity.js'),
    import('../providers/projects.js'),
  ]);
  return { getUser: identity.getUser, getProject: projects.getProject };
}

/** Who the caller acts as: their linked person (p-…) and display name, else the account subject. */
export async function decisionActor(session: Session): Promise<{ id: string; personId: string | null; name: string }> {
  try {
    const { getUser } = await providers();
    const user = await getUser(session.sub);
    const personId = user?.personId ?? null;
    return { id: personId ?? session.sub, personId, name: user?.displayName?.trim() || session.sub };
  } catch {
    return { id: session.sub, personId: null, name: session.sub };
  }
}

export async function mayDecideDecision(session: Session, decision: DecidableDecision): Promise<DecideVerdict> {
  let personId: string | null = null;
  let ownerId: string | null = null;
  try {
    const { getUser, getProject } = await providers();
    personId = (await getUser(session.sub))?.personId ?? null;
    if (personId && decision.projectId) ownerId = (await getProject(decision.projectId))?.ownerId ?? null;
  } catch (err) {
    console.warn('[decision-authority] could not resolve the caller or the initiative owner:', (err as Error).message);
  }
  const isDecider = !!personId && decision.participants.some((p) => p.personId === personId && (p.role ?? '').toLowerCase() === 'decider');
  const isOwner = !!personId && !!ownerId && ownerId === personId;
  const decidesThis = isDecider || isOwner;
  if (isDecider) return { ok: true, via: 'decider', decidesThis };
  if (isOwner) return { ok: true, via: 'owner', decidesThis };
  if ((DECIDE_OVERRIDE_ROLES as readonly string[]).includes(session.role)) return { ok: true, via: 'override', decidesThis };
  return { ok: false, decidesThis: false };
}
