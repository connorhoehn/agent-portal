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
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { resolveSession, isAllowed } from '../lib/authz.js';
import { listSprints, SPRINT_STATUSES } from '../providers/sprints.js';
import { getUser } from '../providers/identity.js';

export const sprintsRouter: Router = Router();

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
