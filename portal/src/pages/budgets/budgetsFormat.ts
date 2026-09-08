// Pure derivations for the Budgets surface. No React, no JSX — everything
// here is a plain function over the /api/budgets shapes so the maintenance-
// floor and burn math can be reasoned about (and unit-tested) without
// mounting a page.

import { DEVBOX_MODELS } from '../../lib/devboxModels.ts';
import type { BudgetRow, InitiativeOption } from './types';

export function usd(n: number): string {
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Bedrock inference-profile id → the short label the rest of the app uses. */
export function modelLabelFor(id: string): string {
  return DEVBOX_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Aurora timestamps arrive without T/Z — same normalization as Bots. */
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
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
      ? 'all spend so far · no new work funded'
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
