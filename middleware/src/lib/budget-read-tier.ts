// The budgets read tier, as one predicate.
//
// Who may see money — allocations, month-to-date spend, maintenance floors,
// envelopes: the roles that read /api/budgets outright (routes/budgets.ts
// readGate: org-leader, hr-admin, program-owner, plus the cross-tenant admin)
// and anyone else Cedar grants ManageBudgets. Asked per call, never cached, so
// a revoked grant stops showing figures on the next request.
//
// Shared by the initiative status decks (providers/initiative-decks.ts
// deckViewerFor) and the local data assistant (lib/local-answers), so a deck
// and an answer cannot disagree about who sees a dollar.

import { isAllowed } from './authz.js';

/** Roles that read the budgets surface outright (routes/budgets.ts readGate). */
export const BUDGET_READ_ROLES: readonly string[] = ['org-leader', 'hr-admin', 'program-owner', 'admin'];

export async function canReadBudgets(session: { sub: string; tenant: string; role: string } | null | undefined): Promise<boolean> {
  if (!session) return false;
  if (BUDGET_READ_ROLES.includes(session.role)) return true;
  return isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, 'ManageBudgets');
}
