// The budgets read tier, as one predicate.
//
// Who may see money — allocations, month-to-date spend, maintenance floors,
// envelopes: the roles that read /api/budgets outright (routes/budgets.ts
// readGate: org-leader, hr-admin, program-owner, plus the cross-tenant admin),
// anyone else Cedar grants ManageBudgets, and — since 2026-10-13 — anyone
// holding the orgiq capability grant `budgets-reader` (lib/session.ts
// CAPABILITY_GRANTS), which the access tenant provisions through the catalog
// item `capability:orgiq:budgets-read`. That grant opens the figures and
// nothing else: it is not a role, carries no Cedar action, and is never a
// session's active role. Asked per call, never cached, so a revoked grant stops
// showing figures on the next request (the grant is read off the session,
// whose grants the ≤120 s refresh re-reads from the directory).
//
// Shared by the initiative status decks (providers/initiative-decks.ts
// deckViewerFor), the local data assistant (lib/local-answers) and the
// Initiatives reads (routes/projects.ts), so a deck, an answer and a table
// cannot disagree about who sees a dollar.

import { isAllowed } from './authz.js';
import { holdsCapability, type Grants } from './session.js';

/** Roles that read the budgets surface outright (routes/budgets.ts readGate). */
export const BUDGET_READ_ROLES: readonly string[] = ['org-leader', 'hr-admin', 'program-owner', 'admin'];

/** The orgiq capability grant that opens the figures (and nothing else). */
export const BUDGET_READ_CAPABILITY = 'budgets-reader';

/** The access catalog item that requests it (mock/access-catalog.ts, schema/access_schema.sql). */
export const BUDGET_READ_ITEM_ID = 'capability:orgiq:budgets-read';

type TierSession = { sub: string; tenant: string; role: string; grants?: Grants | null };

export async function canReadBudgets(session: TierSession | null | undefined): Promise<boolean> {
  if (!session) return false;
  if (BUDGET_READ_ROLES.includes(session.role)) return true;
  if (session.tenant === 'orgiq' && holdsCapability(session.grants, 'orgiq', BUDGET_READ_CAPABILITY)) return true;
  return isAllowed({ sub: session.sub, tenant: session.tenant, role: session.role }, 'ManageBudgets');
}

/**
 * What a reader below the tier is handed in place of the dollar fields: the
 * figures are withheld (never zeroed, never computed client-side), why, and
 * the catalog item that asks for them (POST /api/access-requests/quick).
 */
export interface BudgetAccessLocked {
  visible: false;
  reason: string;
  requestItemId: string;
}

export const BUDGET_LOCKED_REASON =
  'Spend and allocation are visible to the budgets read tier: org-leader, hr-admin, program-owner, or anyone granted budget visibility through Access.';

export function budgetAccessLocked(): BudgetAccessLocked {
  return { visible: false, reason: BUDGET_LOCKED_REASON, requestItemId: BUDGET_READ_ITEM_ID };
}

/** The dollar fields a project summary / detail carries. */
const DOLLAR_FIELDS = ['agentSpendUsd', 'allocatedUsd'] as const;

/** `row` without its dollar fields, with `budgetAccess` saying why. */
export function withholdBudget<T extends object>(row: T): Omit<T, typeof DOLLAR_FIELDS[number]> & { budgetAccess: BudgetAccessLocked } {
  const out = { ...row } as Record<string, unknown>;
  for (const k of DOLLAR_FIELDS) delete out[k];
  out['budgetAccess'] = budgetAccessLocked();
  return out as Omit<T, typeof DOLLAR_FIELDS[number]> & { budgetAccess: BudgetAccessLocked };
}
