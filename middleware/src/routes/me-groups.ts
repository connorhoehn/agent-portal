// GET /api/me/groups?kind=initiative|sprint|org-team|assessment-team|pipeline
// — the groups the signed-in user belongs to, in the one `MineReply` shape
// (lib/mine.ts). The Communication plane's My initiatives / My teams / My
// pipelines / My org teams read here (docs/communication-plane-goal.md §1.3,
// §1.4). Mounted in index.ts under a session floor; each kind then asks its own
// tenant boundary (the session must stand in the kind's tenant, admin passes —
// the same rule as `requireTenant`) and the host tenant's read action where it
// has one (ViewAssessment, ViewPipelines), so no row is wider than the page it
// came from.
//
// "Mine" is the session's user and the directory's person link, never a query
// or body field (`?userId=` / `?personId=` are ignored); a masquerade reads the
// impersonated account, since that is whose groups the operator is looking at.

import { Router } from 'express';
import { AppError, asyncHandler, ValidationError } from '../lib/async-handler.js';
import { isAllowed, resolveSession } from '../lib/authz.js';
import { isMineKind, MINE_KIND_ACTION, MINE_KIND_TENANT, MINE_KINDS, readMine } from '../lib/mine.js';
import { ADMIN_ROLE } from '../lib/session.js';

export const meGroupsRouter = Router();

meGroupsRouter.get('/', asyncHandler(async (req, res) => {
  const session = resolveSession(req);
  if (!session) throw new AppError(401, 'Unauthenticated');
  const kind = req.query['kind'];
  if (!isMineKind(kind)) throw new ValidationError(`kind must be one of ${MINE_KINDS.join(', ')}`);
  const tenant = MINE_KIND_TENANT[kind];
  if (session.tenant !== tenant && session.role !== ADMIN_ROLE) {
    res.status(403).json({ error: 'Forbidden', requiredTenant: tenant, tenant: session.tenant });
    return;
  }
  const action = MINE_KIND_ACTION[kind];
  if (action && !await isAllowed({ sub: session.sub, role: session.role, tenant: session.tenant }, action)) {
    res.status(403).json({ error: 'Forbidden', action, role: session.role, tenant: session.tenant });
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.json(await readMine(session, kind));
}));
