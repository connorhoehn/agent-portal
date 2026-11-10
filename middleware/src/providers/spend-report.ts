// The spend report (docs/budget-system-analysis-2026-10-28.md §3, DE-53 and
// DE-31's per-person view): one grouped read over `spend_entries` and open
// `spend_holds`, by initiative, actor, model, source or trigger, plus — for
// one initiative — the DE-53 blocks (allocation, reserve and floor, envelopes,
// holds, the forecast of open work with fit, run outcomes).
//
// Read-only. The arithmetic is lib/spend-report-model.ts; this module only
// reads rows. Read-tier shaping (who sees dollars) is the route's.
//
// ── Sources ──────────────────────────────────────────────────────────────────
// Spend, burn and projections read the ledger in every SPEND_LEDGER mode: the
// writers run regardless of the read mode, and this report is the ledger's own
// view. The allocation, floor and discretionary figures come from
// providers/budgets.ts (`getBudget`/`listBudgets`) — the figures the brakes
// judge against — so they follow SPEND_LEDGER like every budget read. The
// response carries `ledgerMode` so a reader can tell when the two differ.
//
// ── Mock ─────────────────────────────────────────────────────────────────────
// Offline nothing here is stored (middleware/src/mock/core/contract.ts): the ledger is the
// stored `spend-entries` fixture rows plus a bot_run entry DERIVED from every
// finished run in the bot_runs fixture, attributed by the same arms the Aurora
// writer resolves — exactly what getActorSpend reads.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { spendEntries } from '../mock/spend-ledger.js';
import { allMockRuns } from '../mock/bots.js';
import { MOCK_BOTS, mockBotRunInitiative, mockRunsAttributedTo, dispatchedSpendInWindow } from './bots.js';
import { mockProjectName } from './projects.js';
import { displayNameForSubject, listUsers } from './identity.js';
import { budgetedAllocation } from '../lib/budget-periods.js';
import { attributionPredicateSql, getBudget, getMaintenance30d, listBudgets, listGrants, type BudgetRow } from './budgets.js';
import { listOpenHolds, mockHolds, missingHoldsTable, openHeldUsdForActor, openHeldUsdForGrant } from './spend-holds.js';
import { listUserBudgetRowsAndSpenders, userBudgetView, userSpendThisPeriod } from './user-budgets.js';
import { getProjectWorkItems } from './work-items.js';
import { spendLedgerMode, type SpendLedgerMode } from './spend-ledger.js';
import {
  aggregateEntries, fitOpenItems, projectGroup, reportWindow, round4, SOURCE_LABELS, summarizeForecast, summarizeRuns,
  totalOf, TRIGGER_LABELS, daysLeftInPeriod,
  type ForecastSummary, type OpenItemFit, type RawGroup, type ReportEntry, type ReportPeriod, type ReportWindow,
  type RunOutcomeInput, type RunOutcomes, type SpendGroupBy,
} from '../lib/spend-report-model.js';
import { clock } from '../mock/core/index.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function missingTable(err: unknown): boolean { return /does not exist|relation/i.test((err as Error)?.message ?? ''); }

// ─── Shapes ──────────────────────────────────────────────────────────────────

export interface SpendGroup {
  /** Null = unattributed (no initiative / no actor on the entry). */
  key: string | null;
  label: string;
  knownUsd: number;
  unknownCount: number;
  entries: number;
  burnPerDay7d: number;
  projectedPeriodEndUsd: number;
  /** Open holds under this key; null when holds cannot be grouped this way (model, trigger) or are not tracked. */
  heldUsd: number | null;
  /** Initiative: the discretionary remainder; actor: the user budget's remainder. Absent when the group has no allocation. */
  remainingUsd?: number;
  /** Initiative: allocated; actor: the user budget. Absent when none. */
  allocatedUsd?: number;
}

export interface SpendTotals {
  knownUsd: number;
  unknownCount: number;
  entries: number;
  heldUsd: number | null;
  burnPerDay7d: number;
  projectedPeriodEndUsd: number;
}

export interface EnvelopeView {
  grantId: string;
  granteePersonId: string;
  granteeName: string | null;
  /** The app user linked to the grantee, whose dispatches burn the envelope; null when unlinked. */
  granteeUserId: string | null;
  sprintId: string | null;
  sprintName: string | null;
  sprintStatus: string | null;
  startsOn: string | null;
  endsOn: string | null;
  allocatedUsd: number;
  /** The grantee's own dispatched burn in the window; null when it cannot be attributed (unknown, not zero). */
  spentUsd: number | null;
  unknownCount: number;
  heldUsd: number | null;
  remainingUsd: number | null;
  attributionAvailable: boolean;
  /** The initiative's spend in the sprint window — not the grantee's burn. */
  initiativeSpendInWindowUsd: number;
}

export interface HoldView {
  id: string;
  source: string;
  actorId: string | null;
  actorName: string | null;
  amountUsd: number;
  essential: boolean;
  basis: string;
  createdAt: string;
  expiresAt: string;
}

export interface InitiativeReport {
  id: string;
  name: string | null;
  allocation: {
    allocatedUsd: number | null;
    period: string | null;
    /** DE-38: the current window and its carry. */
    periodKey: string | null;
    periodState: 'open' | 'between-sprints';
    periodStart: string;
    periodEnd: string;
    carryInUsd: number;
    /** allocated + carry in; null with no allocation or between sprints. */
    effectiveAllocatedUsd: number | null;
    spentUsd: number;
    runCount: number;
    unknownCount: number;
    effectiveHardCapUsd: number | null;
    hardCapSource: string | null;
  };
  reserve: {
    reserveUsd: number | null;
    reserveSource: string | null;
    allowFloorSpill: boolean;
    floorSpentUsd: number;
    floorHeldUsd: number;
    discretionarySpentUsd: number;
    discretionaryHeldUsd: number;
    discretionaryRemainingUsd: number | null;
    maintenance30dUsd: number;
    maintenance30dRuns: number;
  };
  holds: { tracked: boolean; heldUsd: number | null; count: number; items: HoldView[] };
  envelopes: EnvelopeView[];
  /** This initiative's ledger spend grouped by actor (the per-person view). */
  people: SpendGroup[];
  forecast: ForecastSummary & { discretionaryRemainingUsd: number | null; items: OpenItemFit[] };
  runs: RunOutcomes & { since: string };
}

export interface SpendReport {
  groupBy: SpendGroupBy;
  period: ReportPeriod;
  since: string;
  asOf: string;
  periodStart: string;
  periodEnd: string;
  daysLeftInPeriod: number;
  ledgerMode: SpendLedgerMode;
  holdsTracked: boolean;
  initiativeId: string | null;
  totals: SpendTotals;
  groups: SpendGroup[];
  initiative?: InitiativeReport;
}

// ─── Ledger rows ─────────────────────────────────────────────────────────────

/** Offline: stored entries plus bot_run entries derived from the run fixture. */
function mockLedgerEntries(w: ReportWindow, initiativeId: string | null): ReportEntry[] {
  const from = w.readFrom.getTime();
  let stored: ReportEntry[] = [];
  try {
    stored = spendEntries.rows().map((e) => ({
      initiativeId: e.initiativeId, actorId: e.actorId, model: e.model, source: e.source,
      trigger: e.trigger, costUsd: e.costUsd, occurredAt: e.occurredAt,
    }));
  } catch { stored = []; }
  const modelByBot = new Map(MOCK_BOTS.map((b) => [b.id, b.model]));
  const derived: ReportEntry[] = allMockRuns()
    .filter((r) => (r.status === 'done' || r.status === 'failed') && Date.parse(r.startedAt) >= from)
    .map((r) => ({
      initiativeId: mockBotRunInitiative(r),
      actorId: r.dispatchedBy,
      model: (r.botId && modelByBot.get(r.botId)) || (typeof r.outcome?.['model'] === 'string' ? String(r.outcome['model']) : null),
      source: 'bot_run',
      trigger: r.trigger,
      costUsd: r.costUsd ?? null,
      occurredAt: r.startedAt,
    }));
  return [...stored, ...derived].filter((e) => Date.parse(e.occurredAt) >= from && (initiativeId == null || e.initiativeId === initiativeId));
}

const KEY_SQL: Readonly<Record<SpendGroupBy, string>> = {
  initiative: 'initiative_id',
  actor: 'actor_id',
  model: "COALESCE(model, 'unknown')",
  source: 'source',
  trigger: 'COALESCE(trigger, source)',
};

/** The grouped ledger read — the raw sums lib/spend-report-model.ts finishes. */
export function groupedLedgerSql(by: SpendGroupBy, scoped: boolean): string {
  return `
    SELECT ${KEY_SQL[by]} AS k,
           COALESCE(SUM(cost_usd) FILTER (WHERE occurred_at >= :since::timestamptz), 0)::float8 AS known,
           COUNT(*) FILTER (WHERE occurred_at >= :since::timestamptz AND cost_usd IS NULL)::int AS unknown,
           COUNT(*) FILTER (WHERE occurred_at >= :since::timestamptz)::int AS n,
           COALESCE(SUM(cost_usd) FILTER (WHERE occurred_at >= :month::timestamptz), 0)::float8 AS mtd,
           COALESCE(SUM(cost_usd) FILTER (WHERE occurred_at >= :burn::timestamptz), 0)::float8 AS last7
      FROM spend_entries
     WHERE occurred_at >= :from::timestamptz AND occurred_at <= :now::timestamptz
       ${scoped ? 'AND initiative_id = :pid' : ''}
     GROUP BY 1`;
}

async function rawGroups(by: SpendGroupBy, w: ReportWindow, initiativeId: string | null): Promise<RawGroup[]> {
  if (config.mock.aurora) return aggregateEntries(mockLedgerEntries(w, initiativeId), by, w);
  const params = [
    s('since', w.since.toISOString()), s('month', w.monthStart.toISOString()), s('burn', w.burnFrom.toISOString()),
    s('from', w.readFrom.toISOString()), s('now', w.now.toISOString()),
    ...(initiativeId ? [s('pid', initiativeId)] : []),
  ];
  try {
    const rows = await exec(groupedLedgerSql(by, initiativeId != null), params);
    return rows.map((r) => ({
      key: r['k'] == null ? null : toStr(r['k']),
      knownUsd: round4(toNum(r['known'])), unknownCount: toNum(r['unknown']), entries: toNum(r['n']),
      monthToDateUsd: round4(toNum(r['mtd'])), last7dUsd: round4(toNum(r['last7'])),
    })).filter((g) => g.entries > 0 || g.monthToDateUsd > 0 || g.last7dUsd > 0);
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

// ─── Holds by group ──────────────────────────────────────────────────────────

const HOLD_KEY_SQL: Partial<Record<SpendGroupBy, string>> = { initiative: 'initiative_id', actor: 'actor_id', source: 'source' };

/** Open held dollars per group key, or null when holds cannot be grouped this way / are not tracked. */
async function heldByGroup(by: SpendGroupBy, initiativeId: string | null): Promise<{ tracked: boolean; byKey: Map<string | null, number> | null }> {
  const keySql = HOLD_KEY_SQL[by];
  if (config.mock.aurora) {
    let open;
    try { open = mockHolds().filter((h) => h.status === 'held' && (initiativeId == null || h.initiativeId === initiativeId)); } catch { return { tracked: false, byKey: null }; }
    if (!keySql) return { tracked: true, byKey: null };
    const byKey = new Map<string | null, number>();
    for (const h of open) {
      const k = by === 'initiative' ? h.initiativeId : by === 'actor' ? h.actorId : h.source;
      byKey.set(k, round4((byKey.get(k) ?? 0) + h.amountUsd));
    }
    return { tracked: true, byKey };
  }
  try {
    if (!keySql) {
      await exec(`SELECT 1 FROM spend_holds LIMIT 1`);
      return { tracked: true, byKey: null };
    }
    const rows = await exec(
      `SELECT ${keySql} AS k, COALESCE(SUM(amount_usd), 0)::float8 AS held
         FROM spend_holds WHERE status = 'held' ${initiativeId ? 'AND initiative_id = :pid' : ''} GROUP BY 1`,
      initiativeId ? [s('pid', initiativeId)] : [],
    );
    return { tracked: true, byKey: new Map(rows.map((r) => [r['k'] == null ? null : toStr(r['k']), toNum(r['held'])])) };
  } catch (err) {
    if (missingHoldsTable(err)) return { tracked: false, byKey: null };
    throw err;
  }
}

// ─── Labels ──────────────────────────────────────────────────────────────────

async function labelsFor(by: SpendGroupBy, keys: ReadonlyArray<string | null>): Promise<Map<string | null, string>> {
  const out = new Map<string | null, string>();
  const real = keys.filter((k): k is string => k != null);
  if (by === 'initiative') {
    out.set(null, 'Unattributed');
    if (config.mock.aurora) { for (const k of real) out.set(k, mockProjectName(k) ?? k); return out; }
    if (real.length) {
      const params = real.map((k, i) => s(`k${i}`, k));
      try {
        for (const r of await exec(`SELECT id, name FROM projects WHERE id IN (${params.map((p) => `:${p.name}`).join(', ')})`, params)) {
          out.set(toStr(r['id']), toStr(r['name']) || toStr(r['id']));
        }
      } catch (err) { if (!missingTable(err)) throw err; }
    }
  } else if (by === 'actor') {
    out.set(null, 'No person (scheduled or unattributed)');
    let users: Array<{ id: string; displayName: string }> = [];
    try { users = await listUsers(); } catch { users = []; }
    for (const k of real) out.set(k, users.find((u) => u.id === k)?.displayName ?? displayNameForSubject(k) ?? k);
  } else if (by === 'source') {
    for (const k of real) out.set(k, SOURCE_LABELS[k] ?? k);
  } else if (by === 'trigger') {
    for (const k of real) out.set(k, TRIGGER_LABELS[k] ?? k);
  } else {
    for (const k of real) out.set(k, k === 'unknown' ? 'Model not recorded' : k);
  }
  for (const k of real) if (!out.has(k)) out.set(k, k);
  return out;
}

// ─── Allocations per group ───────────────────────────────────────────────────

async function allocationsFor(by: SpendGroupBy, keys: ReadonlyArray<string | null>, budgets: readonly BudgetRow[] | null): Promise<Map<string, { allocatedUsd: number; remainingUsd: number }>> {
  const out = new Map<string, { allocatedUsd: number; remainingUsd: number }>();
  if (by === 'initiative') {
    for (const b of budgets ?? []) {
      const allocated = budgetedAllocation(b);
      if (allocated == null || b.discretionaryRemainingUsd == null) continue;
      out.set(b.orgProjectId, { allocatedUsd: allocated, remainingUsd: b.discretionaryRemainingUsd });
    }
  } else if (by === 'actor') {
    let rows;
    try { ({ rows } = await listUserBudgetRowsAndSpenders()); } catch { return out; }
    const want = new Set(keys.filter((k): k is string => k != null));
    await Promise.all(rows.filter((r) => want.has(r.userId)).map(async (r) => {
      const [spend, held] = await Promise.all([
        userSpendThisPeriod(r.userId),
        openHeldUsdForActor(r.userId).catch((err: unknown) => { if (missingHoldsTable(err)) return 0; throw err; }),
      ]);
      const view = userBudgetView(r.userId, r, spend, held);
      if (view.allocatedUsd != null && view.remainingUsd != null) out.set(r.userId, { allocatedUsd: view.allocatedUsd, remainingUsd: view.remainingUsd });
    }));
  }
  return out;
}

// ─── The grouped report ──────────────────────────────────────────────────────

async function buildGroups(
  by: SpendGroupBy, w: ReportWindow, initiativeId: string | null, budgets: readonly BudgetRow[] | null,
): Promise<{ groups: SpendGroup[]; totals: SpendTotals; holdsTracked: boolean }> {
  const [raw, held] = await Promise.all([rawGroups(by, w, initiativeId), heldByGroup(by, initiativeId)]);
  // Initiatives with an allocation but no entries still belong in an
  // initiative grouping: an allocated, idle initiative is a row, not a gap.
  const keys = new Set<string | null>(raw.map((g) => g.key));
  if (by === 'initiative' && !initiativeId) for (const b of budgets ?? []) if (b.allocatedUsd != null) keys.add(b.orgProjectId);
  for (const k of held.byKey?.keys() ?? []) keys.add(k);
  if (initiativeId && by === 'initiative') { keys.clear(); keys.add(initiativeId); }
  const empty = (key: string | null): RawGroup => ({ key, knownUsd: 0, unknownCount: 0, entries: 0, monthToDateUsd: 0, last7dUsd: 0 });
  const all = [...keys].map((k) => raw.find((g) => g.key === k) ?? empty(k));
  const [labels, allocations] = await Promise.all([labelsFor(by, [...keys]), allocationsFor(by, [...keys], budgets)]);
  const groups: SpendGroup[] = all.map((g) => {
    const alloc = g.key != null ? allocations.get(g.key) : undefined;
    return {
      key: g.key,
      label: labels.get(g.key) ?? g.key ?? 'Unattributed',
      knownUsd: g.knownUsd,
      unknownCount: g.unknownCount,
      entries: g.entries,
      ...projectGroup(g, w),
      heldUsd: held.byKey ? round4(held.byKey.get(g.key) ?? 0) : null,
      ...(alloc ? { allocatedUsd: alloc.allocatedUsd, remainingUsd: alloc.remainingUsd } : {}),
    };
  }).sort((a, b) => b.knownUsd - a.knownUsd || b.unknownCount - a.unknownCount || a.label.localeCompare(b.label));
  const t = totalOf(all);
  const heldTotal = held.byKey ? round4([...held.byKey.values()].reduce((a, v) => a + v, 0)) : null;
  return {
    groups,
    totals: { knownUsd: t.knownUsd, unknownCount: t.unknownCount, entries: t.entries, heldUsd: heldTotal, ...projectGroup(t, w) },
    holdsTracked: held.tracked,
  };
}

// ─── The initiative blocks (DE-53) ───────────────────────────────────────────

async function envelopesFor(initiativeId: string): Promise<EnvelopeView[]> {
  const grants = await listGrants(initiativeId);
  let users: Array<{ id: string; personId: string | null }> = [];
  try { users = await listUsers(); } catch { users = []; }
  const views = await Promise.all(grants.map(async (g): Promise<EnvelopeView> => {
    const granteeUserId = users.find((u) => u.personId === g.granteePersonId)?.id ?? null;
    const burn = granteeUserId
      ? await dispatchedSpendInWindow({ orgProjectId: initiativeId, dispatchedBy: granteeUserId, startsOn: g.startsOn, endsOn: g.endsOn })
      : null;
    let heldUsd: number | null;
    try { heldUsd = await openHeldUsdForGrant(g.id); } catch (err) { if (missingHoldsTable(err)) heldUsd = null; else throw err; }
    const attributed = burn?.attributionAvailable === true;
    const spentUsd = attributed ? round4(burn!.spentUsd) : null;
    return {
      grantId: g.id, granteePersonId: g.granteePersonId, granteeName: g.granteeName, granteeUserId,
      sprintId: g.sprintId, sprintName: g.sprintName, sprintStatus: g.sprintStatus, startsOn: g.startsOn, endsOn: g.endsOn,
      allocatedUsd: g.allocatedUsd,
      spentUsd,
      unknownCount: burn?.unknownCount ?? 0,
      heldUsd,
      remainingUsd: spentUsd == null ? null : round4(g.allocatedUsd - spentUsd - (heldUsd ?? 0)),
      attributionAvailable: attributed,
      initiativeSpendInWindowUsd: g.initiativeSpendInWindowUsd,
    };
  }));
  // Active sprints (and standing grants) first, then the newest window.
  const rank = (e: EnvelopeView) => (e.sprintStatus === 'active' || e.sprintId == null ? 0 : e.sprintStatus === 'planned' ? 1 : 2);
  return views.sort((a, b) => rank(a) - rank(b) || String(b.startsOn ?? '').localeCompare(String(a.startsOn ?? '')));
}

async function holdsFor(initiativeId: string): Promise<InitiativeReport['holds']> {
  let open;
  try { open = await listOpenHolds(initiativeId); } catch (err) {
    if (missingHoldsTable(err)) return { tracked: false, heldUsd: null, count: 0, items: [] };
    throw err;
  }
  let users: Array<{ id: string; displayName: string }> = [];
  try { users = await listUsers(); } catch { users = []; }
  const items = open.map((h) => ({
    id: h.id, source: h.source, actorId: h.actorId,
    actorName: h.actorId ? users.find((u) => u.id === h.actorId)?.displayName ?? displayNameForSubject(h.actorId) : null,
    amountUsd: h.amountUsd, essential: h.essential, basis: h.basis, createdAt: h.createdAt, expiresAt: h.expiresAt,
  }));
  return { tracked: true, heldUsd: round4(items.reduce((a, h) => a + h.amountUsd, 0)), count: items.length, items };
}

async function runsFor(initiativeId: string, since: Date): Promise<RunOutcomeInput[]> {
  if (config.mock.aurora) {
    return mockRunsAttributedTo(initiativeId)
      .filter((r) => Date.parse(r.startedAt) >= since.getTime())
      .map((r) => ({ trigger: r.trigger, status: r.status, outcome: r.outcome ?? null }));
  }
  try {
    const rows = await exec(
      `SELECT br.trigger, br.status, br.outcome FROM bot_runs br
        WHERE br.started_at >= :since::timestamptz AND (${attributionPredicateSql(':pid')})`,
      [s('since', since.toISOString()), s('pid', initiativeId)],
    );
    return rows.map((r) => {
      let outcome: Record<string, unknown> | null = null;
      const raw = r['outcome'];
      if (raw && typeof raw === 'object') outcome = raw as Record<string, unknown>;
      else if (typeof raw === 'string') { try { outcome = JSON.parse(raw) as Record<string, unknown>; } catch { outcome = null; } }
      return { trigger: toStr(r['trigger']), status: toStr(r['status']), outcome };
    });
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

async function initiativeBlocks(initiativeId: string, w: ReportWindow, budget: BudgetRow | null, people: SpendGroup[]): Promise<InitiativeReport> {
  const [maint, holds, envelopes, items, runs] = await Promise.all([
    getMaintenance30d(initiativeId),
    holdsFor(initiativeId),
    envelopesFor(initiativeId),
    getProjectWorkItems(initiativeId),
    runsFor(initiativeId, w.since),
  ]);
  const remaining = budget?.discretionaryRemainingUsd ?? null;
  // Open items only: in-progress money is a hold already (DE-53 decision
  // proposal), and an epic's estimate is its children's, so it is not counted twice.
  const open = items.filter((i) => i.status === 'open' && i.type !== 'epic');
  const fits = fitOpenItems(open.map((i) => ({
    id: i.id, key: i.key ?? null, title: i.title, priority: i.priority, storyPoints: i.storyPoints,
    createdAt: i.createdAt, estimateModel: i.estimateModel, estimateForecast: i.estimateForecast, estimatedCostUsd: i.estimatedCostUsd,
  })), remaining);
  return {
    id: initiativeId,
    name: budget?.orgProjectName ?? (config.mock.aurora ? mockProjectName(initiativeId) : null),
    allocation: {
      allocatedUsd: budget?.allocatedUsd ?? null,
      period: budget?.period ?? null,
      // DE-38: the window and carry the figures below are read in.
      periodKey: budget?.periodKey ?? null,
      periodState: budget?.periodState ?? 'open',
      periodStart: budget?.periodStart ?? w.monthStart.toISOString(),
      periodEnd: budget?.periodEnd ?? w.monthEnd.toISOString(),
      carryInUsd: budget?.carryInUsd ?? 0,
      effectiveAllocatedUsd: budget ? budgetedAllocation(budget) : null,
      spentUsd: budget?.spentThisPeriodUsd ?? 0,
      runCount: budget?.runCountThisPeriod ?? 0,
      unknownCount: budget?.unknownCostCount ?? people.reduce((a, p) => a + p.unknownCount, 0),
      effectiveHardCapUsd: budget?.effectiveHardCapUsd ?? null,
      hardCapSource: budget?.hardCapSource ?? null,
    },
    reserve: {
      reserveUsd: budget?.reserveUsd ?? null,
      reserveSource: budget?.reserveSource ?? null,
      allowFloorSpill: budget?.allowFloorSpill !== false,
      floorSpentUsd: budget?.floorSpentUsd ?? 0,
      floorHeldUsd: budget?.floorHeldUsd ?? 0,
      discretionarySpentUsd: budget?.discretionarySpentUsd ?? 0,
      discretionaryHeldUsd: budget?.discretionaryHeldUsd ?? 0,
      discretionaryRemainingUsd: remaining,
      maintenance30dUsd: maint.costUsd,
      maintenance30dRuns: maint.cronRuns,
    },
    holds,
    envelopes,
    people,
    forecast: { ...summarizeForecast(fits), discretionaryRemainingUsd: remaining, items: fits },
    runs: { ...summarizeRuns(runs), since: w.since.toISOString() },
  };
}

/**
 * The report. `initiativeId` narrows the groups to one initiative and adds its
 * DE-53 blocks. Throws only on a real read failure; a missing table reads as
 * no rows (holds as `holdsTracked: false`).
 */
export async function getSpendReport(opts: { groupBy: SpendGroupBy; period: ReportPeriod; initiativeId?: string | null; now?: Date }): Promise<SpendReport> {
  const initiativeId = opts.initiativeId ?? null;
  const budgets: BudgetRow[] | null = initiativeId
    ? await getBudget(initiativeId).then((b) => (b ? [b] : []))
    : opts.groupBy === 'initiative' ? await listBudgets() : null;
  // DE-38: one initiative's report is cut at that initiative's budget window
  // (month-to-date and the projection are "this period"); org-wide stays the
  // calendar month, since initiatives no longer share a boundary.
  const scoped = initiativeId ? budgets?.[0] : null;
  const w = reportWindow(opts.period, opts.now ?? clock.now(),
    scoped?.periodStart && scoped.periodEnd ? { start: new Date(scoped.periodStart), end: new Date(scoped.periodEnd) } : null);
  const { groups, totals, holdsTracked } = await buildGroups(opts.groupBy, w, initiativeId, budgets);
  const report: SpendReport = {
    groupBy: opts.groupBy,
    period: opts.period,
    since: w.since.toISOString(),
    asOf: w.now.toISOString(),
    periodStart: w.monthStart.toISOString(),
    periodEnd: w.monthEnd.toISOString(),
    daysLeftInPeriod: Math.round(daysLeftInPeriod(w) * 100) / 100,
    ledgerMode: spendLedgerMode(),
    holdsTracked,
    initiativeId,
    totals,
    groups,
  };
  if (initiativeId) {
    const people = opts.groupBy === 'actor' ? groups : (await buildGroups('actor', w, initiativeId, null)).groups;
    report.initiative = await initiativeBlocks(initiativeId, w, budgets?.[0] ?? null, people);
  }
  return report;
}
