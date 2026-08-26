// Sprints — /api/sprints
//
// The SME's own surface: "my sprint — my work, my money, my dates". Mounted
// tenant-scoped + session-gated in index.ts; the two scopes are gated here.
//
//   GET /api/sprints?scope=mine   any signed-in orgiq session. Returns only
//                                 sprints the caller stewards, holds a budget
//                                 grant on, or has work assigned in.
//   GET /api/sprints?scope=all    the whole org's board. Every row carries the
//                                 sprint's envelope and the initiative's spend
//                                 inside it, which is the same money
//                                 /api/budgets gates — so the wide scope takes
//                                 the same read tier (org-leader / hr-admin,
//                                 else ManageBudgets). An SME asking for it
//                                 gets 403, not a quietly narrowed answer.
//
// `scope` defaults to whichever the caller can have: leaders land on the org
// board, everyone else on their own sprints.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { resolveSession, isAllowed, requireAction } from '../lib/authz.js';
import { type Session } from '../lib/session.js';
import {
  listSprints, SPRINT_STATUSES, createSprint, getSprint, personExists,
  type SprintStatus,
} from '../providers/sprints.js';
import { initiativeExists } from '../providers/budgets.js';
import { getWorkItem, updateWorkItem } from '../providers/work-items.js';
import { getUser } from '../providers/identity.js';
import { getProject } from '../providers/projects.js';

export const sprintsRouter: Router = Router();

/** Sprint mutation (create, move work in/out) is a program-execution action —
 *  the release manager or an SME steering a sprint. `ManageSprints` is held by
 *  `sme` and the org-wide roles in Cedar; this gate only names the action, and
 *  `requireInitiativeSteward` below scopes an SME's write to their own
 *  initiatives (the scoping the sme.cedar comment promises). */
const manageSprints = requireAction('ManageSprints');

/** Org-wide roles run the cadence across every initiative and are not scoped to
 *  one: the release manager (`org-leader`) allocates and grants across the whole
 *  program, the program operator (`hr-admin`) runs the platform, and `admin` is
 *  cross-tenant. They bypass the per-initiative ownership check. Mirrors the
 *  bypass in decideGrantScopedDispatch (lib/bot-runner.ts). */
const ORG_WIDE_SPRINT_ROLES = ['org-leader', 'hr-admin', 'admin'];

/**
 * Whether this caller may create/steer sprints on `initiativeId` — the
 * authorization question the ManageSprints Cedar action only half-answers.
 *
 * Org-wide roles pass unconditionally. Everyone else (an `sme`) is scoped to
 * initiatives they steward or contribute to: the operating model gives each
 * initiative one owner + two `sme` contributions (project_contributions), so
 * "mine" is `projects.owner_id == me` OR I hold a contribution row on it.
 *
 * Conservative like resolveActiveGrant, but pointing the other way: this is an
 * authorization gate, so an unresolvable caller (no session, no linked person)
 * or a lookup failure is treated as NOT owning the initiative — an SME is 403'd
 * rather than let through. An org-wide role is never blocked by a lookup that
 * failed, because it returns before any lookup runs.
 */
async function stewardsInitiative(
  session: Session | null,
  initiativeId: string,
): Promise<boolean> {
  const role = session?.role;
  if (role && ORG_WIDE_SPRINT_ROLES.includes(role)) return true;
  if (!session?.sub) return false;
  try {
    const personId = (await getUser(session.sub))?.personId ?? null;
    if (!personId) return false;
    const project = await getProject(initiativeId);
    if (!project) return false;
    if (project.ownerId === personId) return true;
    return project.contributors.some((c) => c.personId === personId);
  } catch (err) {
    console.warn(`[sprints] could not resolve steward for ${initiativeId}:`, (err as Error).message);
    return false;
  }
}

/** 403 an SME writing to an initiative they neither own nor contribute to. The
 *  message names the rule the sme.cedar comment now enforces at the route. */
async function requireInitiativeSteward(
  session: Session | null,
  initiativeId: string,
  res: { status: (n: number) => { json: (b: unknown) => void } },
): Promise<boolean> {
  if (await stewardsInitiative(session, initiativeId)) return true;
  res.status(403).json({
    error: 'you can only manage sprints on initiatives you own or contribute to',
    initiativeId,
    ...(session?.role ? { role: session.role } : {}),
  });
  return false;
}

/** A calendar date the schema stores as DATE — 'YYYY-MM-DD', nothing looser. */
function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}

/** The roles that read the money-bearing org-wide board directly (mirrors the
 *  readForRolesElseAction list on /api/budgets); anyone else needs the Cedar
 *  action. `admin` is cross-tenant and passes every gate. */
const WIDE_READ_ROLES = ['org-leader', 'hr-admin', 'admin'];

async function canReadWide(role: string | undefined, principal: ReturnType<typeof resolveSession>): Promise<boolean> {
  if (role && WIDE_READ_ROLES.includes(role)) return true;
  if (!principal) return false;
  return isAllowed(principal, 'ManageBudgets');
}

sprintsRouter.get('/', asyncHandler(async (req, res) => {
  const session = resolveSession(req);
  // requireSession on the mount already rejected the anonymous case; this keeps
  // the handler honest if it is ever mounted differently.
  if (!session) { res.status(401).json({ error: 'Unauthenticated' }); return; }

  const status = String(req.query['status'] ?? '').trim();
  if (status && !SPRINT_STATUSES.includes(status as never)) {
    throw new ValidationError(`status must be one of: ${SPRINT_STATUSES.join(', ')}`);
  }
  const orgProjectId = String(req.query['initiative'] ?? '').trim();
  const rawLimit = parseInt(String(req.query['limit'] ?? '100'), 10);
  const limit = Number.isNaN(rawLimit) ? 100 : rawLimit;

  const wide = await canReadWide(session.role, session);
  const requested = String(req.query['scope'] ?? '').trim();
  if (requested && requested !== 'mine' && requested !== 'all') {
    throw new ValidationError("scope must be 'mine' or 'all'");
  }
  const scope = requested || (wide ? 'all' : 'mine');
  if (scope === 'all' && !wide) {
    res.status(403).json({ error: 'Forbidden', action: 'ManageBudgets', scope: 'all', role: session.role });
    return;
  }

  // The org graph keys work and stewardship on people.id, the session on
  // app_users.id — "my sprints" only exists for an account linked to a person.
  // An unlinked account (the platform operator, the HR admin) gets an explicit
  // null rather than an empty list that reads as "you have no sprints".
  const personId = (await getUser(session.sub))?.personId ?? null;

  const sprints = await listSprints({
    personId,
    mineOnly: scope === 'mine',
    ...(status ? { status } : {}),
    ...(orgProjectId ? { orgProjectId } : {}),
    limit,
  });

  res.json({ scope, personId, canSeeAll: wide, sprints });
}));

// ─── Create a sprint ──────────────────────────────────────────────────────────
//
//   POST /api/sprints
//     { initiativeId, name, startsOn, endsOn, stewardPersonId?, goal?, status? }
//   → 201 { sprint }   (the full board row shape, rollups zeroed)
//
// ManageSprints. The release manager or a steering SME opens a new iteration on
// an initiative. Dates are DATE-typed in the schema (ends_on > starts_on), so we
// reject anything but ordered ISO dates before the write.

sprintsRouter.post('/', manageSprints, asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const initiativeId = String(body['initiativeId'] ?? '').trim();
  const name = String(body['name'] ?? '').trim();
  const startsOn = body['startsOn'];
  const endsOn = body['endsOn'];
  const stewardPersonId = body['stewardPersonId'] != null ? String(body['stewardPersonId']).trim() : null;
  const goal = body['goal'] != null ? String(body['goal']) : null;

  if (!initiativeId) throw new ValidationError('initiativeId is required');
  if (!name) throw new ValidationError('name is required');
  if (!isIsoDate(startsOn) || !isIsoDate(endsOn)) {
    throw new ValidationError('startsOn and endsOn must be calendar dates (YYYY-MM-DD)');
  }
  if (Date.parse(endsOn) <= Date.parse(startsOn)) {
    throw new ValidationError('endsOn must be after startsOn');
  }
  let status: SprintStatus | undefined;
  if (body['status'] != null) {
    const raw = String(body['status']);
    if (!SPRINT_STATUSES.includes(raw as SprintStatus)) {
      throw new ValidationError(`status must be one of: ${SPRINT_STATUSES.join(', ')}`);
    }
    status = raw as SprintStatus;
  }

  if (!await initiativeExists(initiativeId)) throw new NotFoundError('No such initiative');

  // Scope the write: an SME opens sprints only on initiatives they own or
  // contribute to. Org-wide roles bypass. After existence (so a bad id is a 404,
  // not a 403), before the steward lookup and the write.
  if (!await requireInitiativeSteward(resolveSession(req), initiativeId, res)) return;

  if (stewardPersonId && !await personExists(stewardPersonId)) {
    throw new NotFoundError('No such steward');
  }

  const sprint = await createSprint({
    orgProjectId: initiativeId,
    name,
    startsOn,
    endsOn,
    stewardPersonId,
    goal,
    ...(status ? { status } : {}),
  });
  res.status(201).json({ sprint });
}));

// ─── Move a work item into / out of a sprint ──────────────────────────────────
//
//   PATCH  /api/sprints/:sprintId/items          { workItemId }   → adds
//   DELETE /api/sprints/:sprintId/items/:itemId                   → removes
//
// ManageSprints. A sprint scopes work for one initiative, so an item can only be
// pulled into a sprint on the SAME initiative — moving p-auth work into a
// p-observability sprint would put it under the wrong envelope and steward.

sprintsRouter.patch('/:sprintId/items', manageSprints, asyncHandler(async (req, res) => {
  const sprintId = String(req.params['sprintId'] ?? '').trim();
  const workItemId = String((req.body as { workItemId?: unknown })?.workItemId ?? '').trim();
  if (!workItemId) throw new ValidationError('workItemId is required');

  const sprint = await getSprint(sprintId);
  if (!sprint) throw new NotFoundError('No such sprint');
  // The target initiative is the sprint's own — scope the move to an SME who
  // owns or contributes to it (org-wide roles bypass).
  if (!await requireInitiativeSteward(resolveSession(req), sprint.orgProjectId, res)) return;
  const item = await getWorkItem(workItemId);
  if (!item) throw new NotFoundError('No such work item');
  if (item.projectId !== sprint.orgProjectId) {
    throw new ValidationError(
      'a work item can only join a sprint on its own initiative — ' +
      `item is on ${item.projectId}, sprint is on ${sprint.orgProjectId}`,
    );
  }

  const updated = await updateWorkItem(workItemId, { sprintId });
  if (!updated) throw new NotFoundError('No such work item');
  res.json({ workItem: updated });
}));

sprintsRouter.delete('/:sprintId/items/:itemId', manageSprints, asyncHandler(async (req, res) => {
  const sprintId = String(req.params['sprintId'] ?? '').trim();
  const workItemId = String(req.params['itemId'] ?? '').trim();

  const sprint = await getSprint(sprintId);
  if (!sprint) throw new NotFoundError('No such sprint');
  // Scope the removal to the sprint's own initiative (org-wide roles bypass).
  if (!await requireInitiativeSteward(resolveSession(req), sprint.orgProjectId, res)) return;
  const item = await getWorkItem(workItemId);
  if (!item) throw new NotFoundError('No such work item');
  // Removing an item that isn't in this sprint is a 404 on the membership, not a
  // silent success — the caller's model of the board is wrong.
  if (item.sprintId !== sprintId) throw new NotFoundError('work item is not in this sprint');

  const updated = await updateWorkItem(workItemId, { sprintId: null });
  if (!updated) throw new NotFoundError('No such work item');
  res.json({ workItem: updated });
}));
