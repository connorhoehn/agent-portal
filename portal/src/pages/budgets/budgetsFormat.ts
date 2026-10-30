// Pure derivations for the Budgets surface. No React, no JSX — everything
// here is a plain function over the /api/budgets shapes so the maintenance-
// floor and burn math can be reasoned about (and unit-tested) without
// mounting a page.

import { DEVBOX_MODELS } from '../../lib/devboxModels.ts';
import type { BudgetRow, InitiativeOption } from './types';

// Promoted to lib/format.ts — the app-wide canonical `usd`. Re-exported here
// so existing `from './budgetsFormat'` imports keep working.
import { usd } from '../../lib/format.ts';
import { relativeTime } from '../../lib/relativeTime.ts';
export { usd };

/** Bedrock inference-profile id → the short label the rest of the app uses. */
export function modelLabelFor(id: string): string {
  return DEVBOX_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Aurora stamps carry a `+00` offset ISO 8601 does not allow — shared parser. */
export function ago(iso: string | null): string {
  // Delegates to lib/relativeTime rather than laddering here. Every copy of
  // this ladder in the portal had drifted differently — round vs floor at the
  // minute boundary, "just now" under 1 minute vs under 2, and past a week
  // some counted to "100d ago" forever while the shared one switches to a
  // date — so one instant read differently depending which page you were on.
  // The null sentinel below stays because callers here depend on it.
  if (!iso) return 'never';
  return relativeTime(iso);
}

// ─── The maintenance floor ────────────────────────────────────────────────
//
// The floor is a SUBSET of spend, never additional to it — the provider
// computes it as the cron-triggered slice and that invariant is unit-tested.
// But when every run so far is scheduled, a hint reading "100% of spend ·
// scheduled bots" gets parsed by a reader as "100% of the BUDGET is
// maintenance", directly against a Remaining tile showing real headroom.
// Both would be true and together they mislead — so a full floor says what
// it actually means (no new work funded yet) instead of repeating a percent.

export interface MaintenanceStats {
  floorIsAllSpend: boolean;
  floorPct: number;
  hint: string;
}

export function maintenanceStats(totalSpent: number, totalMaintenance: number): MaintenanceStats {
  const floorIsAllSpend = totalSpent > 0 && totalMaintenance / totalSpent >= 0.995;
  const floorPct = totalSpent > 0 ? Math.round((totalMaintenance / totalSpent) * 100) : 0;
  const hint = totalSpent === 0
    ? 'scheduled bots'
    : floorIsAllSpend
      // 30 chars. `StatStripItem` has no `title`, so a hint that overruns
      // its tile is simply cut mid-word with no way to reach the rest —
      // measured at 196px needed in a 165px box, losing "…w work funded".
      // The full sentence lives in `maintenanceTitle` below, which the tile
      // does surface; this line only has to survive the width.
      ? 'all spent · no new work funded'
      : `${floorPct}% of spend · scheduled bots`;
  return { floorIsAllSpend, floorPct, hint };
}

export function maintenanceTitle(floorIsAllSpend: boolean, monthLabel: string): string {
  return floorIsAllSpend
    ? `Every dollar spent in ${monthLabel} went to scheduled bots keeping repos alive — no discretionary work has been funded yet. This is a subset of "Spent this period", not extra spend: it is already deducted from Remaining, and it recurs next period.`
    : 'Cron-triggered runs — the recurring baseline of keeping each initiative\'s repos alive. A subset of "Spent this period", already deducted from Remaining.';
}

export function remainingHint(remaining: number): string {
  return remaining < 0 ? 'over allocation' : 'allocated − spent';
}

export function remainingTitle(totalMaintenance: number, totalSpent: number, monthLabel: string): string {
  return totalMaintenance > 0
    ? `What is left of the allocation, not a forecast: ${usd(totalMaintenance)} of the ${usd(totalSpent)} spent so far is the scheduled-bot floor, and the rest of ${monthLabel}'s scheduled runs will draw on this figure too.`
    : 'Allocated minus spend so far this period.';
}

// ─── Full initiative list, not just the allocated/blind-spot subset ────────
//
// `GET /api/budgets` returns only initiatives with an allocation OR spend
// (program-owner DEFECTS #7) — an initiative with neither has nowhere to get
// its first budget from, so an unlisted initiative silently had no "Set
// budget" affordance anywhere. `GET /api/graph/projects` is the full roster
// (all 14 seeded `p-*` initiatives the role can see); merging it in here
// means the table is sourced from THAT list, with the /api/budgets row
// (allocation + this-period actuals) layered on top where one exists.

function emptyBudgetRow(orgProjectId: string, orgProjectName: string | null): BudgetRow {
  return {
    orgProjectId,
    orgProjectName,
    allocatedUsd: null,
    period: null,
    updatedBy: null,
    updatedByName: null,
    updatedAt: null,
    spentThisPeriodUsd: 0,
    runCountThisPeriod: 0,
    lastAgentActivityAt: null,
    maintenanceUsd: 0,
  };
}

/** Every initiative the role can see, each carrying its `/api/budgets` row
 *  where one exists and a zeroed, unallocated row where one does not — so
 *  "Set budget" is available for every initiative, not just the ones that
 *  happen to already have spend or an allocation. A budget row whose
 *  initiative did not come back in `initiatives` (e.g. a fetch race, or an
 *  initiative that has since been archived) is kept rather than dropped —
 *  losing a blind spot silently is worse than showing one with no name. */
export function mergeInitiativesWithBudgets(
  initiatives: InitiativeOption[],
  budgets: BudgetRow[],
): BudgetRow[] {
  const byId = new Map(budgets.map((b) => [b.orgProjectId, b]));
  const merged = initiatives.map((p) => {
    const existing = byId.get(p.id);
    byId.delete(p.id);
    return existing ?? emptyBudgetRow(p.id, p.name);
  });
  return [...merged, ...byId.values()];
}

// ─── Per-row burn ──────────────────────────────────────────────────────────

export interface RowBudgetStats {
  /** Spending with no allocation — the blind spot this page exists to surface. */
  blindSpot: boolean;
  remaining: number | null;
  burn: number | null;
}

export function rowBudgetStats(row: Pick<BudgetRow, 'allocatedUsd' | 'spentThisPeriodUsd'>): RowBudgetStats {
  const blindSpot = row.allocatedUsd == null && row.spentThisPeriodUsd > 0;
  const remaining = row.allocatedUsd != null ? row.allocatedUsd - row.spentThisPeriodUsd : null;
  const burn = row.allocatedUsd != null && row.allocatedUsd > 0
    ? row.spentThisPeriodUsd / row.allocatedUsd
    : null;
  return { blindSpot, remaining, burn };
}

/**
 * How a budget's period reads on the page (DE-38): a sprint-period allocation
 * with no sprint open is "between sprints" (not in force), otherwise the
 * period key ('2026-10', '2026-Q4', a sprint id) names the window. Absent
 * fields (an older BFF, a rolling period) say nothing.
 */
export function budgetPeriodLabel(p: { periodKey?: string | null | undefined; periodState?: 'open' | 'between-sprints' | undefined }): { betweenSprints: boolean; key: string | null } {
  return { betweenSprints: p.periodState === 'between-sprints', key: p.periodKey ?? null };
}
