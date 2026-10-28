// Who may see a computer.
//
// `ManageDevbox` is a role-wide Cedar capability: it answers "may this role
// ever use the Computers surface", not "may this person use *this* computer".
// The operating model's answer to the second question is the same one sprints
// already uses — an SME is scoped to the initiatives they own or contribute to
// — with one addition the sprint rule does not need: a computer can be
// personal.
//
// So there are three shapes of computer, and the rule reads off which:
//
//   personal   ownerId set, no projectId  → its owner, and org-wide roles
//   shared     projectId set              → everyone attached to that
//                                           initiative, and org-wide roles
//   unattributed  neither                 → org-wide roles only
//
// The last case is the one worth being deliberate about. Boxes the fleet makes
// for itself (job-dispatcher, bot-runner) and boxes predating these fields have
// no owner and no project. Hiding them from non-org-wide roles is the
// conservative choice: a shell nobody claimed is not something to hand an SME
// on the theory that it is probably fine.
//
// Split into a pure decision + an async resolver deliberately. The decision is
// where the policy lives and it is trivially testable; the resolver only
// answers "is this person attached to that initiative", which needs I/O.

import { type Session } from './session.js';
import type { Request, Response } from 'express';
import { type FleetBox, getBoxBySession, registerBox } from './devbox-fleet.js';
import { ORG_WIDE_INITIATIVE_ROLES, stewardsInitiative } from './initiative-scope.js';

/** Roles that operate the whole fleet and see every computer in it. */
export const FLEET_WIDE_ROLES = ORG_WIDE_INITIATIVE_ROLES;

export interface VisibilityInput {
  /** Session sub of the caller, or null when there is no session. */
  sub: string | null;
  /** Caller's role, or null. */
  role: string | null;
  /**
   * Initiative ids this caller owns or contributes to. Only consulted for a
   * computer that has a projectId, so callers can resolve lazily.
   */
  attachedInitiatives: ReadonlySet<string>;
}

/**
 * The rule, with no I/O. See the module comment for the three shapes.
 */
export function canSeeBox(box: FleetBox, who: VisibilityInput): boolean {
  if (who.role && FLEET_WIDE_ROLES.includes(who.role)) return true;
  if (!who.sub) return false;
  if (box.projectId) return who.attachedInitiatives.has(box.projectId);
  if (box.ownerId) return box.ownerId === who.sub;
  return false;
}

/**
 * Resolve the caller's visibility input for a set of computers.
 *
 * Only the initiatives actually referenced by `boxes` are checked, so this is
 * at most one lookup per distinct project on screen rather than one per
 * computer — and none at all for a fleet-wide role, which short-circuits.
 */
export async function resolveVisibility(
  session: Session | null,
  boxes: readonly FleetBox[],
): Promise<VisibilityInput> {
  const role = session?.role ?? null;
  const sub = session?.sub ?? null;
  if (role && FLEET_WIDE_ROLES.includes(role)) {
    return { sub, role, attachedInitiatives: new Set() };
  }
  const projectIds = [...new Set(boxes.map((b) => b.projectId).filter((p): p is string => !!p))];
  const attached = new Set<string>();
  await Promise.all(projectIds.map(async (id) => {
    if (await stewardsInitiative(session, id)) attached.add(id);
  }));
  return { sub, role, attachedInitiatives: attached };
}

/** Filter a fleet to what this caller may see. */
export async function visibleBoxes(
  session: Session | null,
  boxes: readonly FleetBox[],
): Promise<FleetBox[]> {
  const who = await resolveVisibility(session, boxes);
  return boxes.filter((b) => canSeeBox(b, who));
}

/** Whether this caller may see one specific computer. */
export async function canSee(session: Session | null, box: FleetBox): Promise<boolean> {
  const who = await resolveVisibility(session, [box]);
  return canSeeBox(box, who);
}

/**
 * Whether this session may act on the box behind `sessionId`; answers the
 * refusal itself. Shared by routes/devbox.ts and the agent-projects clone
 * route. An unregistered session is refused for anyone but a fleet-wide role,
 * which adopts it (see the note above routes/devbox.ts's old copy).
 */
export async function requireBoxAccess(req: Request, res: Response, sessionId: string): Promise<boolean> {
  const box = getBoxBySession(sessionId);
  const session = req.session ?? null;
  if (!box) {
    if (session?.role && FLEET_WIDE_ROLES.includes(session.role)) {
      // A fresh createdAt restarts the lifetime clock, which is the honest
      // reading: the registry cannot know when a session it has never seen
      // began, and a clock that restarts bounds the box, where no clock at
      // all does not.
      registerBox({
        sessionId,
        label: `adopted ${sessionId.slice(-8)}`,
        ...(session.sub ? { ownerId: session.sub } : {}),
      });
      console.warn(`[devbox] adopted unregistered session ${sessionId} — the reaper can see it again`);
      return true;
    }
    res.status(403).json({ error: 'no computer here you can reach', sessionId });
    return false;
  }
  if (await canSee(session, box)) return true;
  res.status(403).json({
    error: 'that computer belongs to someone else, or to an initiative you are not on',
    ...(box.projectId ? { projectId: box.projectId } : {}),
    ...(session?.role ? { role: session.role } : {}),
  });
  return false;
}
