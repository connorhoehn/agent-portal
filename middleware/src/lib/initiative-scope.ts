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
    const project = await getProject(initiativeId);
    if (!project) return false;
    if (project.ownerId === personId) return true;
    return project.contributors.some((c) => c.personId === personId);
  } catch (err) {
    console.warn(`[initiative-scope] could not resolve steward for ${initiativeId}:`, (err as Error).message);
    return false;
  }
}
