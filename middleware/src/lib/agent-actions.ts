// The agent-code authorities split out of ManageDevbox (DE-42): shell, task,
// decide, deliver and policy edit, each its own Cedar action.
//
// Cedar decides "may this role ever", conditioned for `sme` on two booleans
// the route computes: `onInitiative` (the caller owns or contributes to the
// box's or change's initiative, or holds an org-wide role) and `ownsBox`. The
// local open-mode matrix ignores `when` clauses, so the route refuses first
// (403 NOT_ON_INITIATIVE) and Cedar repeats the rule in production. This
// file is that route half, in one place for devbox, agent-projects, agents
// and sdlc.

import type { Request, Response, NextFunction } from 'express';
import type { ResourceAttrs } from './authz.js';
import { ORG_WIDE_INITIATIVE_ROLES, stewardsInitiative } from './initiative-scope.js';
import type { Session } from './session.js';

// authz.ts and audit.ts are loaded lazily, inside the functions, for the same
// reason initiative-scope.ts loads its providers lazily: authz drags config.ts
// (import.meta) into the graph, and ts-jest's CommonJS transform rejects it,
// so a static import here broke every suite that imports routes/devbox.ts.
async function authz() {
  const [a, audit] = await Promise.all([import('./authz.js'), import('./audit.js')]);
  return { isAllowed: a.isAllowed, resolveSession: a.resolveSession, eventFromSession: audit.eventFromSession, logAuthz: audit.logAuthz };
}

export type AgentAction =
  | 'OpenDevboxShell'
  | 'RunDevboxTask'
  | 'DecideAgentChange'
  | 'DeliverAgentChange'
  | 'EditSdlcPolicy';

export interface AgentActionAttrs {
  onInitiative?: boolean;
  ownsBox?: boolean;
  isAuthor?: boolean;
}

/** Whether this caller is on `initiativeId`; a null initiative scopes nothing (as requireInitiativeScope). */
export async function onInitiative(session: Session | null, initiativeId: string | null | undefined): Promise<boolean> {
  if (!initiativeId) return true;
  return stewardsInitiative(session, initiativeId);
}

/**
 * Ask Cedar for `action` with the given attributes, answering the refusal.
 * True means go on. A caller on neither the initiative nor the box is refused
 * with NOT_ON_INITIATIVE before Cedar is asked, in both modes.
 */
export async function authorizeAgentAction(
  req: Request, res: Response, action: AgentAction, attrs: AgentActionAttrs,
): Promise<boolean> {
  const { isAllowed, resolveSession, eventFromSession, logAuthz } = await authz();
  const session = resolveSession(req);
  if (!session) {
    logAuthz({ decision: 'DENY', action, sub: 'anonymous', role: '-', path: req.path, reason: 'no session' });
    res.status(401).json({ error: 'Unauthenticated', code: 'SESSION_INVALID' });
    return false;
  }
  if (attrs.onInitiative === false && attrs.ownsBox !== true) {
    logAuthz(eventFromSession(session, action, 'DENY', { path: req.path, reason: 'not on the initiative' }));
    res.status(403).json({
      error: 'you are not on this initiative', code: 'NOT_ON_INITIATIVE', action, role: session.role,
    });
    return false;
  }
  const resource: ResourceAttrs = {};
  for (const [k, v] of Object.entries(attrs)) if (typeof v === 'boolean') resource[k] = v;
  try {
    const ok = await isAllowed(session, action, resource);
    logAuthz(eventFromSession(session, action, ok ? 'ALLOW' : 'DENY', { path: req.path }));
    if (ok) return true;
    res.status(403).json({ error: 'Forbidden', action, role: session.role, tenant: session.tenant });
    return false;
  } catch (err) {
    logAuthz(eventFromSession(session, action, 'DENY', { path: req.path, reason: `authz-error: ${(err as Error).message}` }));
    res.status(503).json({ error: 'authorization unavailable', action });
    return false;
  }
}

/** The box attributes for a session id: owner, and whether the caller is on its initiative. */
export async function boxAttrs(session: Session | null, sessionId: string): Promise<AgentActionAttrs & { registered: boolean }> {
  const { getBoxBySession } = await import('./devbox-fleet.js');
  const box = getBoxBySession(sessionId);
  const orgWide = !!session?.role && ORG_WIDE_INITIATIVE_ROLES.includes(session.role);
  if (!box) return { registered: false, onInitiative: orgWide, ownsBox: false };
  const ownsBox = !!session?.sub && box.ownerId === session.sub;
  const on = orgWide || (box.projectId ? await stewardsInitiative(session, box.projectId) : false);
  return { registered: true, onInitiative: on, ownsBox };
}

/**
 * Route middleware for a box action (`/:sessionId/...`). An unregistered
 * session is left to requireBoxAccess, which adopts it for a fleet-wide role
 * and refuses everyone else; only the bare action is asked here.
 */
export function requireBoxAction(action: Extract<AgentAction, 'OpenDevboxShell' | 'RunDevboxTask'>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { resolveSession } = await authz();
    const box = await boxAttrs(resolveSession(req), String(req.params['sessionId'] ?? ''));
    // An unregistered session has no initiative to be on: Cedar is asked as
    // for the box the caller is about to adopt, and requireBoxAccess (which
    // runs next) adopts it for a fleet-wide role and refuses everyone else.
    const attrs = box.registered
      ? { onInitiative: box.onInitiative ?? false, ownsBox: box.ownsBox ?? false }
      : { onInitiative: box.onInitiative ?? false, ownsBox: true };
    if (await authorizeAgentAction(req, res, action, attrs)) next();
  };
}
