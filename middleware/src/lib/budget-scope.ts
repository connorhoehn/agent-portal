// Where a ManageBudgets holder may allocate (docs/next-steps.md §9 item 8a).
//
// org-leader, hr-admin and admin allocate across the whole program. A
// program-owner holds ManageBudgets too, but only within the initiatives they
// own: an initiative's allocation, its run limits and its sprint envelopes
// (routes/budgets.ts, routes/grants.ts). Reads are unchanged.
//
// Cedar is asked with `ownsInitiative` so the program-owner forbid
// (seeds/roles/orgiq/program-owner.cedar) decides in production; the route
// refuses on its own as well, because the local seed matrix ignores `when`
// clauses. authz.ts is loaded lazily for the reason lib/agent-actions.ts
// gives: it drags config.ts into the graph of every suite that imports this.

import type { Request, Response } from 'express';
import { ownsInitiative } from './initiative-scope.js';

/** The roles scoped to their own initiatives' budgets. */
export const INITIATIVE_SCOPED_BUDGET_ROLES = ['program-owner'];

/**
 * True to go on. Answers the 403 itself: `NOT_INITIATIVE_OWNER` when a
 * program-owner writes the budget of an initiative they do not own.
 */
export async function requireBudgetScope(req: Request, res: Response, initiativeId: string): Promise<boolean> {
  const { resolveSession, isAllowed } = await import('./authz.js');
  const session = resolveSession(req);
  if (!session || !INITIATIVE_SCOPED_BUDGET_ROLES.includes(session.role)) return true;
  const owns = await ownsInitiative(session, initiativeId);
  const allowed = await isAllowed(session, 'ManageBudgets', { ownsInitiative: owns });
  if (owns && allowed) return true;
  res.status(403).json({
    error: 'a program owner allocates budget only on initiatives they own',
    code: 'NOT_INITIATIVE_OWNER', action: 'ManageBudgets', role: session.role, initiativeId,
  });
  return false;
}
