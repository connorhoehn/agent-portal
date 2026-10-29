// Budget period closes — storage (DE-38). The window and carry arithmetic are
// lib/budget-periods.ts; this module only reads and writes `budget_period_closes`
// (Aurora) or its registered fixture (mock/budget-period-closes.ts).
//
// A close is written lazily: the first read that needs an initiative's current
// period, when the policy carries and the previous keyed period has no close
// row, computes that close from the ledger and inserts it with
// ON CONFLICT DO NOTHING — so two replicas (or a retry) racing on the same
// boundary leave one row, and both then read the row that won. A close is
// computed only from its immediate predecessor among the close rows (the
// latest close that started before it), so the chain is never re-walked.
//
// The spend inside a window is injected by providers/budgets.ts, which owns the
// attribution predicates and the SPEND_LEDGER mode; this module imports nothing
// from it (budgets.ts imports this one).

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { budgetPeriodCloses, type MockPeriodClose } from '../mock/budget-period-closes.js';
import { clock } from '../mock/core/index.js';
import { carryOut, type BudgetWindow, type CarryPolicy } from '../lib/budget-periods.js';

type Run = (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>;

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function num(name: string, v: number): SqlParameter { return { name, value: { doubleValue: v } }; }
function int(name: string, v: number): SqlParameter { return { name, value: { longValue: v } }; }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** Known spend and the count of unknown-cost entries inside [from, to). */
export interface WindowSpend { spentUsd: number; unknownCount: number }

export interface CloseContext {
  orgProjectId: string;
  /** The allocation in force (stored; there is no allocation history). */
  allocatedUsd: number;
  policy: CarryPolicy;
}

export interface PeriodClose {
  orgProjectId: string;
  periodKey: string;
  periodStart: string;
  periodEnd: string;
  allocatedUsd: number;
  carryInUsd: number;
  spentUsd: number;
  unknownCostEntries: number;
  carryOutUsd: number;
  reason: 'boundary' | 'reconfigured';
  closedAt: string;
}

type KeyedWindow = Pick<BudgetWindow, 'start' | 'end'> & { key: string };

// ─── Aurora ──────────────────────────────────────────────────────────────────

async function storedCarryOut(run: Run, orgProjectId: string, key: string): Promise<number | null> {
  const rows = await run(
    `SELECT carry_out_usd::float8 AS c FROM budget_period_closes WHERE org_project_id = :pid AND period_key = :key`,
    [s('pid', orgProjectId), s('key', key)],
  );
  return rows[0] ? toNum(rows[0]['c']) : null;
}

/** The carry a period starts with: the latest close that began before it, or 0. */
async function carryBefore(run: Run, orgProjectId: string, start: Date): Promise<number> {
  const rows = await run(
    `SELECT carry_out_usd::float8 AS c FROM budget_period_closes
      WHERE org_project_id = :pid AND period_start < :start::timestamptz
      ORDER BY period_start DESC LIMIT 1`,
    [s('pid', orgProjectId), s('start', start.toISOString())],
  );
  return rows[0] ? toNum(rows[0]['c']) : 0;
}

async function insertClose(run: Run, c: Omit<PeriodClose, 'closedAt'>): Promise<void> {
  await run(
    `INSERT INTO budget_period_closes
       (org_project_id, period_key, period_start, period_end, allocated_usd, carry_in_usd,
        spent_usd, unknown_cost_entries, carry_out_usd, reason)
     VALUES (:pid, :key, :start::timestamptz, :end::timestamptz, :alloc, :cin, :spent, :unknown, :cout, :reason)
     ON CONFLICT (org_project_id, period_key) DO NOTHING`,
    [
      s('pid', c.orgProjectId), s('key', c.periodKey), s('start', c.periodStart), s('end', c.periodEnd),
      num('alloc', c.allocatedUsd), num('cin', c.carryInUsd), num('spent', c.spentUsd),
      int('unknown', c.unknownCostEntries), num('cout', c.carryOutUsd), s('reason', c.reason),
    ],
  );
}

/**
 * The carry into the current period: the previous keyed period's close,
 * written now if it is missing. Returns the stored carry-out of whichever row
 * won the insert.
 */
export async function auroraCarryIn(
  run: Run, ctx: CloseContext, prev: KeyedWindow,
  spendIn: (from: Date, to: Date) => Promise<WindowSpend>,
): Promise<number> {
  const existing = await storedCarryOut(run, ctx.orgProjectId, prev.key);
  if (existing != null) return existing;
  const [carryInUsd, spend] = await Promise.all([carryBefore(run, ctx.orgProjectId, prev.start), spendIn(prev.start, prev.end)]);
  await insertClose(run, {
    orgProjectId: ctx.orgProjectId, periodKey: prev.key,
    periodStart: prev.start.toISOString(), periodEnd: prev.end.toISOString(),
    allocatedUsd: ctx.allocatedUsd, carryInUsd, spentUsd: spend.spentUsd, unknownCostEntries: spend.unknownCount,
    carryOutUsd: carryOut({ allocatedUsd: ctx.allocatedUsd, carryInUsd, spentUsd: spend.spentUsd, periodEnd: prev.end }, ctx.policy),
    reason: 'boundary',
  });
  return (await storedCarryOut(run, ctx.orgProjectId, prev.key)) ?? 0;
}

/** Close the outgoing window of a reconfigured policy: carry-out 0, reason 'reconfigured'. */
export async function auroraCloseReconfigured(
  run: Run, orgProjectId: string, allocatedUsd: number, outgoing: KeyedWindow, carryInUsd: number, spend: WindowSpend,
): Promise<void> {
  await insertClose(run, {
    orgProjectId, periodKey: outgoing.key,
    periodStart: outgoing.start.toISOString(), periodEnd: outgoing.end.toISOString(),
    allocatedUsd, carryInUsd, spentUsd: spend.spentUsd, unknownCostEntries: spend.unknownCount,
    carryOutUsd: 0, reason: 'reconfigured',
  });
}

export async function listAuroraCloses(run: Run, orgProjectId: string): Promise<PeriodClose[]> {
  const rows = await run(
    `SELECT org_project_id, period_key, period_start, period_end, allocated_usd::float8 AS allocated_usd,
            carry_in_usd::float8 AS carry_in_usd, spent_usd::float8 AS spent_usd, unknown_cost_entries,
            carry_out_usd::float8 AS carry_out_usd, reason, closed_at
       FROM budget_period_closes WHERE org_project_id = :pid ORDER BY period_start DESC`,
    [s('pid', orgProjectId)],
  );
  return rows.map((r) => ({
    orgProjectId: String(r['org_project_id']), periodKey: String(r['period_key']),
    periodStart: String(r['period_start']), periodEnd: String(r['period_end']),
    allocatedUsd: toNum(r['allocated_usd']), carryInUsd: toNum(r['carry_in_usd']), spentUsd: toNum(r['spent_usd']),
    unknownCostEntries: toNum(r['unknown_cost_entries']), carryOutUsd: toNum(r['carry_out_usd']),
    reason: r['reason'] === 'reconfigured' ? 'reconfigured' : 'boundary', closedAt: String(r['closed_at']),
  }));
}

// ─── Mock: the same statements over the registered fixture ──────────────────

function mockInsert(c: Omit<MockPeriodClose, 'closedAt'>): void {
  const rows = budgetPeriodCloses.rows();
  if (rows.some((r) => r.orgProjectId === c.orgProjectId && r.periodKey === c.periodKey)) return; // ON CONFLICT DO NOTHING
  rows.push({ ...c, closedAt: clock.now().toISOString() });
}

function mockCarryBefore(orgProjectId: string, start: Date): number {
  const before = budgetPeriodCloses.rows()
    .filter((r) => r.orgProjectId === orgProjectId && Date.parse(r.periodStart) < start.getTime())
    .sort((a, b) => Date.parse(b.periodStart) - Date.parse(a.periodStart));
  return before[0]?.carryOutUsd ?? 0;
}

export function mockCarryIn(ctx: CloseContext, prev: KeyedWindow, spendIn: (from: Date, to: Date) => WindowSpend): number {
  const find = () => budgetPeriodCloses.rows().find((r) => r.orgProjectId === ctx.orgProjectId && r.periodKey === prev.key);
  const existing = find();
  if (existing) return existing.carryOutUsd;
  const carryInUsd = mockCarryBefore(ctx.orgProjectId, prev.start);
  const spend = spendIn(prev.start, prev.end);
  mockInsert({
    orgProjectId: ctx.orgProjectId, periodKey: prev.key,
    periodStart: prev.start.toISOString(), periodEnd: prev.end.toISOString(),
    allocatedUsd: ctx.allocatedUsd, carryInUsd, spentUsd: spend.spentUsd, unknownCostEntries: spend.unknownCount,
    carryOutUsd: carryOut({ allocatedUsd: ctx.allocatedUsd, carryInUsd, spentUsd: spend.spentUsd, periodEnd: prev.end }, ctx.policy),
    reason: 'boundary',
  });
  return find()?.carryOutUsd ?? 0;
}

export function mockCloseReconfigured(
  orgProjectId: string, allocatedUsd: number, outgoing: KeyedWindow, carryInUsd: number, spend: WindowSpend,
): void {
  mockInsert({
    orgProjectId, periodKey: outgoing.key,
    periodStart: outgoing.start.toISOString(), periodEnd: outgoing.end.toISOString(),
    allocatedUsd, carryInUsd, spentUsd: spend.spentUsd, unknownCostEntries: spend.unknownCount,
    carryOutUsd: 0, reason: 'reconfigured',
  });
}

export function listMockCloses(orgProjectId: string): PeriodClose[] {
  return budgetPeriodCloses.rows()
    .filter((r) => r.orgProjectId === orgProjectId)
    .sort((a, b) => Date.parse(b.periodStart) - Date.parse(a.periodStart))
    .map((r) => ({ ...r }));
}
