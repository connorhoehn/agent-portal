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
import { DEMO_SUB } from './demo-sub.js';
import { insecureDevMode } from './insecure-dev-mode.js';

/** Roles that decide any decision. NOT hr-admin: G54 names org-leader (and admin). */
export const DECIDE_OVERRIDE_ROLES = ['org-leader', 'admin'] as const;

export type DecideGrant = 'override' | 'decider' | 'owner' | 'demo';
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

/**
 * Who the caller acts as: their linked person (p-…), else the account subject,
 * and the name the history records — the account's display name, else the
 * session's own (the demo identity's "Demo User"), and only then the subject.
 */
export async function decisionActor(session: Session): Promise<{ id: string; personId: string | null; name: string }> {
  const sessionName = session.name?.trim() || session.sub;
  try {
    const { getUser } = await providers();
    const user = await getUser(session.sub);
    const personId = user?.personId ?? null;
    return { id: personId ?? session.sub, personId, name: user?.displayName?.trim() || sessionName };
  } catch {
    return { id: session.sub, personId: null, name: sessionName };
  }
}

interface NamedBy { id: string; name: string }

/**
 * The names a record shows for who decided (walk, 9 November: "Decided by
 * demo-user"). The provider names a decider from its person row, else from
 * the name the event recorded; what is left is a bare id (an account with no
 * person, an event recorded before its name was known). Such a name becomes
 * the account's display name, else "you" when it is the viewer's own account
 * or person, else stays the id. Presentation only: the stored rows keep the id.
 */
export async function nameDeciders<T extends { decidedBy: NamedBy | null; history: Array<{ by: NamedBy }> }>(
  session: Session | null, decision: T,
): Promise<T> {
  const bare = (by: NamedBy | null | undefined) => !!by && (!by.name.trim() || by.name === by.id);
  const ids = [...new Set([decision.decidedBy, ...decision.history.map((e) => e.by)].filter(bare).map((by) => by!.id))];
  if (ids.length === 0) return decision;
  const names = new Map<string, string>();
  let viewerPerson: string | null = null;
  try {
    const { getUser } = await providers();
    if (session) viewerPerson = (await getUser(session.sub))?.personId ?? null;
    for (const id of ids) {
      const shown = (await getUser(id))?.displayName?.trim();
      if (shown) names.set(id, shown);
    }
  } catch { /* an unresolvable name stays the id (or "you") */ }
  const name = (by: NamedBy): NamedBy => {
    if (!bare(by)) return by;
    const own = !!session && (by.id === session.sub || (!!viewerPerson && by.id === viewerPerson));
    return { id: by.id, name: names.get(by.id) ?? (own ? 'you' : by.id) };
  };
  return {
    ...decision,
    decidedBy: decision.decidedBy ? name(decision.decidedBy) : null,
    history: decision.history.map((e) => ({ ...e, by: name(e.by) })),
  };
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
  // The demo identity has no person link; under the dev flag it may decide so the demo stays explorable.
  if (session.sub === DEMO_SUB && insecureDevMode()) return { ok: true, via: 'demo', decidesThis };
  return { ok: false, decidesThis: false };
}
