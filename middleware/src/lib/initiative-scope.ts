// Who is attached to an initiative — the authorization question a role-wide
// Cedar capability only half-answers.
//
// Several capabilities are granted to `sme` role-wide (ManageSprints,
// ManageDevbox) because Cedar decides "may this role ever do this", not "may
// this person do this *here*". The operating model's answer to "here" is
// always the same: one owner runs an initiative and a few SMEs contribute
// across several, so "mine" means `projects.owner_id == me` OR I hold a
// contribution row on it.
//
// This lived inside routes/sprints.ts until the Computers surface needed the
// identical rule. Extracted rather than copied: two implementations of an
// authorization predicate drift, and the one that drifts loose is a hole.

import { type Session } from './session.js';

// The providers are loaded lazily, inside the function.
//
// Not a style choice: importing them at module scope drags config.ts into the
// graph of everything that imports this file, and config.ts uses import.meta,
// which ts-jest refuses to compile under the CommonJS test config. That turned
// two unrelated suites into "test suite failed to run" the moment routes/devbox
// imported this. Node caches the module after the first call, so the await is
// a map lookup on every call but the first.
async function providers() {
  const [identity, projects] = await Promise.all([
    import('../providers/identity.js'),
    import('../providers/projects.js'),
  ]);
  return { getUser: identity.getUser, getProject: projects.getProject };
}

/**
 * Roles that run the program across every initiative and are therefore not
 * scoped to one: the release manager (`org-leader`) allocates and grants across
 * the whole program, the program operator (`hr-admin`) runs the platform, and
 * `admin` is cross-tenant. They bypass the per-initiative check.
 *
 * Mirrors the bypass in decideGrantScopedDispatch (lib/bot-runner.ts).
 */
export const ORG_WIDE_INITIATIVE_ROLES = ['org-leader', 'hr-admin', 'admin'];

/**
 * Whether this caller owns or contributes to `initiativeId`.
 *
 * Org-wide roles pass unconditionally, before any lookup runs — so a failed
 * lookup can never block them. Everyone else (an `sme`) is scoped.
 *
 * Deliberately conservative in the other direction: this is an authorization
 * gate, so an unresolvable caller (no session, no linked person) or a lookup
 * failure resolves to NOT attached. An SME is denied rather than let through.
 */
export async function stewardsInitiative(
  session: Session | null,
  initiativeId: string,
): Promise<boolean> {
  const role = session?.role;
  if (role && ORG_WIDE_INITIATIVE_ROLES.includes(role)) return true;
  if (!session?.sub) return false;
  try {
    const { getUser, getProject } = await providers();
    const personId = (await getUser(session.sub))?.personId ?? null;
    if (!personId) return false;
    return await personOnInitiative(personId, initiativeId);
  } catch (err) {
    console.warn(`[initiative-scope] could not resolve steward for ${initiativeId}:`, (err as Error).message);
    return false;
  }
}

/**
 * The same rule for a user id with no session in hand: a service-signed call
 * names who it acts for (`principal.requestedBy`), not a cookie. The user is
 * read authoritatively so a revoked grant cannot charge an initiative, and an
 * org-wide role held in any tenant bypasses as it does for a session. Unknown
 * user, unlinked person or a failed read resolves to NOT attached.
 */
export async function userStewardsInitiative(userId: string, initiativeId: string): Promise<boolean> {
  try {
    const { getUser } = await providers();
    const user = await getUser(userId, { authoritative: true });
    if (!user) return false;
    if (Object.values(user.grants).flat().some((role) => ORG_WIDE_INITIATIVE_ROLES.includes(role))) return true;
    return await personOnInitiative(user.personId, initiativeId);
  } catch (err) {
    console.warn(`[initiative-scope] could not resolve steward ${userId} for ${initiativeId}:`, (err as Error).message);
    return false;
  }
}

/**
 * The same "mine" rule for a person id with no session in hand and NO role
 * bypass: owner or contributor, nothing else. Used where the question is about
 * a recorded person (a proposal's author), not the caller. A lookup failure or
 * an unknown initiative resolves to NOT attached.
 */
export async function personOnInitiative(personId: string | null | undefined, initiativeId: string): Promise<boolean> {
  if (!personId) return false;
  try {
    const { getProject } = await providers();
    const project = await getProject(initiativeId);
    if (!project) return false;
    if (project.ownerId === personId) return true;
    return project.contributors.some((c) => c.personId === personId);
  } catch (err) {
    console.warn(`[initiative-scope] could not resolve membership of ${personId} on ${initiativeId}:`, (err as Error).message);
    return false;
  }
}
