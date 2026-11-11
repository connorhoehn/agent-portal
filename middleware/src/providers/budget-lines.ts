// The organisation's budget lines that belong to no initiative (docs/learning-loop-design.md
// "Budgets"): storage and the month's figures.
//
//   learning   server-side distillation, under a monthly organisation cap. The
//              cap is stored in `learning_budget` (one row, id 'org') once an
//              org leader sets it; until then LEARNING_BUDGET_USD (default $5).
//              Spend is the ledger's `learning` entries this calendar month,
//              held is the open `learning` holds. lib/learning-budget.ts
//              reserves against it, through lib/spend-holds.ts reserveSpend.
//   local      local compute runs: billed $0 by construction (lib/run-cost.ts),
//              with the figure the worker reported kept beside it as
//              `reported_usd`. Shown as "reported, not billed"; it never counts
//              toward any cap because nothing reads `reported_usd` as spend.
//
// Persistence only; the gate is routes/budgets.ts.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { learningBudget } from '../mock/budget-lines.js';
import { spendEntries } from '../mock/spend-ledger.js';
import { spendHolds } from '../mock/spend-holds.js';
import { hasColumns } from './column-probe.js';
import { monthWindow } from '../lib/budget-periods.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function missingTable(err: unknown): boolean {
  return /does not exist|relation/i.test((err as Error)?.message ?? '');
}

/** LEARNING_BUDGET_USD: the monthly cap until an org leader sets one. Default $5; must be a number >= 0. */
export function learningCapDefaultUsd(): number {
  const raw = (process.env['LEARNING_BUDGET_USD'] ?? '').trim();
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) && n >= 0 ? n : 5;
}

export interface LearningCap {
  capUsd: number;
  source: 'set' | 'default';
  updatedBy: string | null;
  updatedAt: string | null;
}

/** The cap in force. Throws when the store cannot be read (a missing table reads as the default). */
export async function getLearningCap(): Promise<LearningCap> {
  const fallback: LearningCap = { capUsd: learningCapDefaultUsd(), source: 'default', updatedBy: null, updatedAt: null };
  if (config.mock.aurora) {
    const row = learningBudget.rows().find((r) => r.id === 'org');
    return row ? { capUsd: row.monthlyCapUsd, source: 'set', updatedBy: row.updatedBy, updatedAt: row.updatedAt } : fallback;
  }
  try {
    const rows = await exec(`SELECT monthly_cap_usd::float8 AS cap, updated_by, updated_at FROM learning_budget WHERE id = 'org'`);
    const r = rows[0];
    if (!r) return fallback;
    return { capUsd: toNum(r['cap']), source: 'set', updatedBy: r['updated_by'] != null ? String(r['updated_by']) : null, updatedAt: r['updated_at'] != null ? String(r['updated_at']) : null };
  } catch (err) {
    if (missingTable(err)) return fallback;
    throw err;
  }
}

/** Set the cap (null: back to the default). Returns what is in force after. */
export async function setLearningCap(capUsd: number | null, actor: string | null): Promise<LearningCap> {
  if (config.mock.aurora) {
    const rows = learningBudget.rows();
    const at = rows.findIndex((r) => r.id === 'org');
    if (capUsd == null) { if (at >= 0) rows.splice(at, 1); }
    else {
      const row = { id: 'org' as const, monthlyCapUsd: capUsd, updatedBy: actor, updatedAt: clock.nowIso() };
      if (at >= 0) rows[at] = row; else rows.push(row);
    }
    return getLearningCap();
  }
  if (capUsd == null) {
    await exec(`DELETE FROM learning_budget WHERE id = 'org'`);
  } else {
    await exec(
      `INSERT INTO learning_budget (id, monthly_cap_usd, updated_by, updated_at) VALUES ('org', :cap::numeric, :actor, NOW())
       ON CONFLICT (id) DO UPDATE SET monthly_cap_usd = EXCLUDED.monthly_cap_usd, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [{ name: 'cap', value: { doubleValue: capUsd } }, actor ? s('actor', actor) : { name: 'actor', value: { isNull: true } }],
    );
  }
  return getLearningCap();
}

/** The calendar month the learning line and the local line are summed over. */
export function lineMonth(now: Date = clock.now()): { key: string; startIso: string } {
  const w = monthWindow(now);
  return { key: w.key!, startIso: new Date(w.start).toISOString() };
}

/** Known `learning` spend this month. Throws when the ledger cannot be read (a missing table is $0). */
export async function learningSpentThisMonth(): Promise<{ spentUsd: number; entries: number }> {
  const { startIso } = lineMonth();
  if (config.mock.aurora) {
    const from = Date.parse(startIso);
    const rows = spendEntries.rows().filter((e) => e.source === 'learning' && Date.parse(e.occurredAt) >= from);
    return { spentUsd: round4(rows.reduce((a, e) => a + (e.costUsd ?? 0), 0)), entries: rows.length };
  }
  try {
    const rows = await exec(
      `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent, COUNT(*)::int AS n
         FROM spend_entries WHERE source = 'learning' AND occurred_at >= :since::timestamptz`,
      [s('since', startIso)],
    );
    return { spentUsd: round4(toNum(rows[0]?.['spent'])), entries: toNum(rows[0]?.['n']) };
  } catch (err) {
    if (missingTable(err)) return { spentUsd: 0, entries: 0 };
    throw err;
  }
}

/** Money held by distillation runs in flight. */
export async function learningHeldUsd(): Promise<number> {
  if (config.mock.aurora) {
    return round4(spendHolds.rows().filter((h) => h.status === 'held' && h.source === 'learning').reduce((a, h) => a + h.amountUsd, 0));
  }
  try {
    const rows = await exec(`SELECT COALESCE(SUM(amount_usd), 0)::float8 AS held FROM spend_holds WHERE source = 'learning' AND status = 'held'`);
    return round4(toNum(rows[0]?.['held']));
  } catch (err) {
    if (missingTable(err)) return 0;
    throw err;
  }
}

/** The open learning hold for one run, if a reservation for it is already in flight (idempotent on runRef). */
export async function openLearningHold(sourceId: string): Promise<{ id: string; amountUsd: number } | null> {
  if (config.mock.aurora) {
    const h = spendHolds.rows().find((x) => x.status === 'held' && x.source === 'learning' && x.sourceId === sourceId);
    return h ? { id: h.id, amountUsd: h.amountUsd } : null;
  }
  try {
    const rows = await exec(
      `SELECT id::text AS id, amount_usd::float8 AS amount FROM spend_holds WHERE source = 'learning' AND source_id = :sid AND status = 'held' LIMIT 1`,
      [s('sid', sourceId)],
    );
    return rows[0] ? { id: String(rows[0]['id']), amountUsd: toNum(rows[0]['amount']) } : null;
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
}

export interface LocalReportedLine {
  /** What local workers reported their runs cost this month. Never billed. */
  reportedUsd: number;
  /** Local runs booked this month, with or without a reported figure. */
  runs: number;
  /** Always 0: the operator's own login pays. Here so the page states it. */
  billedUsd: number;
}

/** Local compute this month: the ledger's provider='local' entries and the figures their workers reported. */
export async function localReportedThisMonth(): Promise<LocalReportedLine> {
  const { startIso } = lineMonth();
  if (config.mock.aurora) {
    const from = Date.parse(startIso);
    const rows = spendEntries.rows().filter((e) => e.provider === 'local' && Date.parse(e.occurredAt) >= from);
    return { reportedUsd: round4(rows.reduce((a, e) => a + (e.reportedUsd ?? 0), 0)), runs: rows.length, billedUsd: 0 };
  }
  try {
    const withProvider = await hasColumns('spend_entries', ['provider']).catch(() => false);
    if (!withProvider) return { reportedUsd: 0, runs: 0, billedUsd: 0 };
    const withReported = await hasColumns('spend_entries', ['reported_usd']).catch(() => false);
    const rows = await exec(
      `SELECT ${withReported ? 'COALESCE(SUM(reported_usd), 0)::float8' : '0::float8'} AS reported, COUNT(*)::int AS n
         FROM spend_entries WHERE provider = 'local' AND occurred_at >= :since::timestamptz`,
      [s('since', startIso)],
    );
    return { reportedUsd: round4(toNum(rows[0]?.['reported'])), runs: toNum(rows[0]?.['n']), billedUsd: 0 };
  } catch (err) {
    if (missingTable(err)) return { reportedUsd: 0, runs: 0, billedUsd: 0 };
    throw err;
  }
}
