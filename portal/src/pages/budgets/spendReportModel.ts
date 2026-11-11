// Pure derivations for the spend report on the Budgets page
// (GET /api/spend/report). No React: grouping and period options, how a
// figure reads (unknown costs visible, never $0; withheld figures absent, never
// zero), the initiative ledger's floor / discretionary columns, the open-work
// fit pill, and the list rail's rows. Unit-tested under node:test.

import { usd } from '../../lib/format.ts';
import { modelLabelFor } from './budgetsFormat.ts';
import type { BudgetRow, OpenItemFit, SpendCostBasis, SpendEnvelope, SpendGroup, SpendGroupBy, SpendPeriod } from './types.ts';

export const GROUP_OPTIONS: ReadonlyArray<{ value: SpendGroupBy; label: string }> = [
  { value: 'initiative', label: 'Initiative' },
  { value: 'actor', label: 'Person' },
  { value: 'model', label: 'Model' },
  { value: 'source', label: 'Source' },
  { value: 'trigger', label: 'Trigger' },
  { value: 'bot', label: 'Bot' },
];

export const PERIOD_OPTIONS: ReadonlyArray<{ value: SpendPeriod; label: string }> = [
  { value: 'month', label: 'This month' },
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
];

export function parseGroupBy(raw: string | null): SpendGroupBy {
  return GROUP_OPTIONS.find((o) => o.value === raw)?.value ?? 'initiative';
}

export function parsePeriod(raw: string | null): SpendPeriod {
  return PERIOD_OPTIONS.find((o) => o.value === raw)?.value ?? 'month';
}

/** The report's URL for one view. Initiative grouping is the budget period by definition, so it carries no period. */
export function spendReportUrl(groupBy: SpendGroupBy, period: SpendPeriod, initiativeId?: string | null): string {
  const q = new URLSearchParams({ groupBy, period: groupBy === 'initiative' || initiativeId ? 'month' : period });
  if (initiativeId) q.set('initiativeId', initiativeId);
  return `/api/spend/report?${q}`;
}

/**
 * One group's entries. An empty key is the group with no key (for example
 * "Not from a bot"). Initiative grouping is the budget period, so it carries none.
 */
export function spendEntriesUrl(
  groupBy: SpendGroupBy, key: string | null, period: SpendPeriod, limit: number, initiativeId?: string | null,
): string {
  const q = new URLSearchParams({ groupBy, key: key ?? '', period: groupBy === 'initiative' || initiativeId ? 'month' : period, limit: String(limit) });
  if (initiativeId) q.set('initiativeId', initiativeId);
  return `/api/spend/entries?${q}`;
}

/** The Budgets page's own URL for one grouped view of the spend report. */
export function spendReportPageHref(groupBy: SpendGroupBy, period: SpendPeriod): string {
  const q = new URLSearchParams();
  if (groupBy !== 'initiative') q.set('group', groupBy);
  if (period !== 'month') q.set('period', period);
  const s = q.toString();
  return `/iq/budgets${s ? `?${s}` : ''}`;
}

/** The bot a group names, as its page: only a real bot key has one. */
export function botHref(key: string | null): string | null {
  return key ? `/iq/bots/${encodeURIComponent(key)}` : null;
}

/**
 * What one entry's cost cell says. Null = withheld (render the lock). A cost
 * that was never recorded reads "unknown", never $0; an estimate says so.
 */
export function entryCost(costUsd: number | null | undefined, basis: SpendCostBasis): { text: string; note: string | null } | null {
  if (costUsd === undefined) return null;
  if (costUsd === null) return { text: 'unknown', note: null };
  return { text: usd(costUsd, { precision: 4 }), note: basis === 'estimated' ? 'estimated' : null };
}

/** The column header over the spend figure, so the window is never implied. */
export function periodHeading(period: SpendPeriod): string {
  return period === 'month' ? 'Spent this month' : period === '7d' ? 'Spent, 7 days' : 'Spent, 30 days';
}

// ─── How a figure reads ─────────────────────────────────────────────────────

/** What a spend cell says. Null = withheld (render the lock). */
export interface SpendFigure {
  text: string;
  /** "2 unknown" beside the dollars, or null when every cost is known. */
  unknown: string | null;
}

/**
 * Known dollars beside the unknown count. When every entry's cost is unknown
 * the cell says "unknown", not "$0.00": a run that reported no figure did not
 * cost nothing.
 */
export function spendFigure(knownUsd: number | undefined, unknownCount: number): SpendFigure | null {
  if (knownUsd === undefined) return null;
  const unknown = unknownCount > 0 ? `${unknownCount} unknown` : null;
  if (unknownCount > 0 && knownUsd === 0) return { text: 'unknown', unknown };
  return { text: usd(knownUsd), unknown };
}

/** A money field that may be withheld (undefined), not applicable (null) or a figure. */
export function moneyOrDash(v: number | null | undefined): string {
  return v == null ? '—' : usd(v);
}

/** A group's name as the release manager reads it. */
export function groupLabel(g: Pick<SpendGroup, 'key' | 'label'>, groupBy: SpendGroupBy): string {
  if (groupBy === 'model' && g.key && g.key !== 'unknown') return modelLabelFor(g.key);
  return g.label;
}

export type FigureTone = 'danger' | 'warning' | undefined;

/** Over (danger) or under a tenth of the allocation left (warning). */
export function remainingTone(remaining: number | null | undefined, allocated: number | null | undefined): FigureTone {
  if (remaining == null) return undefined;
  if (remaining < 0) return 'danger';
  if (allocated != null && allocated > 0 && remaining < allocated * 0.1) return 'warning';
  return undefined;
}

// ─── The initiative ledger: floor vs discretionary ──────────────────────────

/** A Budgets row joined to its spend-report group (held, projected, unknown). */
export interface InitiativeLedgerRow extends BudgetRow {
  heldUsd: number | null | undefined;
  projectedPeriodEndUsd: number | undefined;
  burnPerDay7d: number | undefined;
  ledgerUnknownCount: number;
}

export function mergeInitiativeLedger(budgets: readonly BudgetRow[], groups: readonly SpendGroup[]): InitiativeLedgerRow[] {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  return budgets.map((b) => {
    const g = byKey.get(b.orgProjectId);
    return {
      ...b,
      heldUsd: g ? g.heldUsd : undefined,
      projectedPeriodEndUsd: g?.projectedPeriodEndUsd,
      burnPerDay7d: g?.burnPerDay7d,
      ledgerUnknownCount: Math.max(g?.unknownCount ?? 0, b.unknownCostCount ?? 0),
    };
  });
}

/** The Floor cell: the reserve's spend against the reserve. */
export function floorFigure(row: Pick<BudgetRow, 'allocatedUsd' | 'reserveUsd' | 'reserveSource' | 'floorSpentUsd' | 'maintenanceUsd'>): { text: string; title: string } {
  if (row.allocatedUsd == null || row.reserveUsd === undefined) {
    const spent = row.floorSpentUsd ?? row.maintenanceUsd;
    return { text: spent > 0 ? `${usd(spent)} spent` : '—', title: 'Scheduled maintenance spend. No reserve without an allocation.' };
  }
  if (row.reserveSource === 'off') return { text: 'off', title: 'The maintenance reserve is turned off for this deployment.' };
  const how = row.reserveSource === 'set' ? 'set by a budget holder' : 'auto: last month’s scheduled spend × 1.1';
  return {
    text: `${usd(row.floorSpentUsd ?? 0)} of ${usd(row.reserveUsd ?? 0)}`,
    title: `Essential bots’ scheduled spend against the maintenance reserve (${how}). The reserve is funded before any discretionary work.`,
  };
}

/** Allocation minus the floor: what the discretionary meter is drawn against. */
export function discretionaryBudget(row: Pick<BudgetRow, 'allocatedUsd' | 'reserveUsd' | 'floorSpentUsd' | 'floorHeldUsd'>): number | null {
  if (row.allocatedUsd == null) return null;
  const floor = Math.max(row.reserveUsd ?? 0, (row.floorSpentUsd ?? 0) + (row.floorHeldUsd ?? 0));
  return Math.max(0, row.allocatedUsd - floor);
}

// ─── Open work ──────────────────────────────────────────────────────────────

export interface FitPill {
  state: 'success' | 'warning' | 'neutral';
  label: string;
  title: string;
}

export function fitPill(item: Pick<OpenItemFit, 'fitsRemaining' | 'basis'>, hasAllocation: boolean): FitPill | null {
  if (item.fitsRemaining === undefined) return null;
  if (item.basis == null) return { state: 'neutral', label: 'no estimate', title: 'No stored forecast or estimate, so it cannot be judged against the money left.' };
  if (item.fitsRemaining == null || !hasAllocation) return { state: 'neutral', label: 'no allocation', title: 'This initiative has no allocation to fit work against.' };
  return item.fitsRemaining
    ? { state: 'success', label: 'fits', title: 'Its p75 fits the discretionary remainder after every higher-priority item ahead of it.' }
    : { state: 'warning', label: 'over remaining', title: 'Its p75 does not fit what is left after the higher-priority items ahead of it.' };
}

export function basisLabel(basis: OpenItemFit['basis']): string {
  return basis === 'forecast' ? 'authorized forecast' : basis === 'estimate' ? '$/point estimate' : 'none';
}

// ─── Envelopes ──────────────────────────────────────────────────────────────

/** The envelope's burn: the grantee's own dispatches, or unknown (never $0) when they cannot be attributed. */
export function envelopeBurn(e: Pick<SpendEnvelope, 'spentUsd' | 'granteeUserId' | 'unknownCount'>): SpendFigure & { title: string } {
  if (e.spentUsd == null) {
    return {
      text: 'unknown',
      unknown: null,
      title: e.granteeUserId == null
        ? 'The grantee has no linked account, so no dispatch can be attributed to this envelope.'
        : 'This cluster does not record who dispatched a run.',
    };
  }
  const fig = spendFigure(e.spentUsd, e.unknownCount)!;
  return { ...fig, title: 'Runs this person dispatched on this initiative inside the sprint window.' };
}

// ─── The list rail ──────────────────────────────────────────────────────────

export const OVERVIEW_ROW_ID = 'all';

export interface RailRow {
  id: string;
  groupId: 'overview' | 'initiatives';
  title: string;
  subline: string;
  blindSpot: boolean;
}

export function budgetRailRows(budgets: readonly BudgetRow[], totals: { allocated: number; spent: number } | null): RailRow[] {
  const overview: RailRow = {
    id: OVERVIEW_ROW_ID,
    groupId: 'overview',
    title: 'All spend',
    subline: totals ? `${usd(totals.spent)} of ${usd(totals.allocated)}` : 'every initiative',
    blindSpot: false,
  };
  return [overview, ...budgets.map((b): RailRow => {
    const blindSpot = b.allocatedUsd == null && b.spentThisPeriodUsd > 0;
    return {
      id: b.orgProjectId,
      groupId: 'initiatives',
      title: b.orgProjectName ?? b.orgProjectId,
      subline: b.allocatedUsd != null ? `${usd(b.spentThisPeriodUsd)} of ${usd(b.allocatedUsd)}`
        : blindSpot ? `${usd(b.spentThisPeriodUsd)} · unallocated` : 'unallocated',
      blindSpot,
    };
  })];
}

// ─── People and envelopes, one row per person ───────────────────────────────

export interface PersonEnvelopeRow {
  id: string;
  name: string;
  /** This person's ledger spend on the initiative; null = none recorded. */
  spend: SpendGroup | null;
  /** Their current envelope (active or standing first, then newest); null = none. */
  envelope: SpendEnvelope | null;
  /** Further envelopes on other sprints. */
  otherEnvelopes: number;
}

/**
 * People who spent on the initiative and people who hold an envelope on it,
 * one row each. A grantee with no linked account is still a row (their
 * envelope burn is unknown); the "no person" ledger group (scheduled runs)
 * stays its own row so the people sum to the initiative.
 */
export function peopleWithEnvelopes(people: readonly SpendGroup[], envelopes: readonly SpendEnvelope[]): PersonEnvelopeRow[] {
  const rows = new Map<string, PersonEnvelopeRow>();
  for (const p of people) {
    const id = p.key ?? '__none';
    rows.set(id, { id, name: p.label, spend: p, envelope: null, otherEnvelopes: 0 });
  }
  for (const e of envelopes) {
    const id = e.granteeUserId ?? `person:${e.granteePersonId}`;
    const row = rows.get(id) ?? { id, name: e.granteeName ?? e.granteePersonId, spend: null, envelope: null, otherEnvelopes: 0 };
    if (row.envelope == null) row.envelope = e; else row.otherEnvelopes++;
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) =>
    Number(a.id === '__none') - Number(b.id === '__none')
    || Number(b.envelope != null) - Number(a.envelope != null)
    || (b.spend?.knownUsd ?? 0) - (a.spend?.knownUsd ?? 0)
    || a.name.localeCompare(b.name));
}
