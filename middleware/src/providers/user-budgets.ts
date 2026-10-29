// User budgets — storage and the burn they are judged against (DE-54,
// docs/deployment-enhancements/DE-54-user-budgets.md).
//
// The allocation and its optional hard cap are the only stored values
// (schema/user_budgets_schema.sql). The burn is derived at read time:
//   spent  = SUM(spend_entries.cost_usd) WHERE actor_id = :user
//            AND occurred_at >= the period start AND trigger IS DISTINCT FROM 'cron'
//   held   = the user's open spend_holds (providers/spend-holds.ts)
// so a figure written beside the row can never drift from the ledger. Offline
// the ledger is the stored box-task entries plus bot runs derived from the
// bot_runs fixture — the same two halves GET /api/me/spend reads.
//
// The decision is lib/budget-decisions.ts `decideUserBudget` / `decideHardCap`,
// called from lib/spend-holds.ts `reserveSpend` under the 'user:'||sub lock.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { userBudgets, type MockUserBudget } from '../mock/user-budgets.js';
import { spendEntries } from '../mock/spend-ledger.js';
import { displayNameForSubject } from './identity.js';
// DE-38: user budgets stay on the calendar month, through the one window helper.
import { PERIOD_START_SQL, monthWindow } from '../lib/budget-periods.js';
import { effectiveHardCap, type CapSource } from '../lib/budget-decisions.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : { name, value: { isNull: true } };
}
function num(name: string, v: number | null): SqlParameter {
  return v == null ? { name, value: { isNull: true } } : { name, value: { doubleValue: v } };
}
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function missingUserBudgetsTable(err: unknown): boolean {
  return /does not exist|relation/i.test((err as Error)?.message ?? '');
}

export interface UserBudgetRow {
  userId: string;
  displayName: string | null;
  period: 'monthly';
  allocatedUsd: number;
  /** The stored cap; null = the deployment default. */
  hardCapUsd: number | null;
  note: string | null;
  setBy: string | null;
  setByName: string | null;
  updatedAt: string | null;
}

export interface UserSpend {
  /** Known spend this period where the user is the actor, cron excluded. */
  spentUsd: number;
  /** Entries this period with no recorded cost (DE-33). */
  unknownCount: number;
}

/** A budget beside its derived burn, for GET /api/me/spend and the list. */
export interface UserBudgetView {
  userId: string;
  displayName: string | null;
  period: 'monthly';
  since: string;
  /** Null = no row: the user is unbraked (a blind spot). */
  allocatedUsd: number | null;
  hardCapUsd: number | null;
  /** The cap actually enforced: the stored one, else allocated x the factor. */
  effectiveHardCapUsd: number | null;
  hardCapSource: CapSource | null;
  spentUsd: number;
  unknownCount: number;
  heldUsd: number;
  /** allocated - spent - held; null without a row. */
  remainingUsd: number | null;
  note: string | null;
  setBy: string | null;
  setByName: string | null;
  updatedAt: string | null;
}

/** Start of the budget period (calendar month, UTC), the mock analogue of PERIOD_START_SQL. */
export function userPeriodStart(now: Date = clock.now()): Date {
  return monthWindow(now).start;
}

function mockRow(m: MockUserBudget): UserBudgetRow {
  return {
    userId: m.userId,
    displayName: displayNameForSubject(m.userId),
    period: 'monthly',
    allocatedUsd: m.allocatedUsd,
    hardCapUsd: m.hardCapUsd,
    note: m.note,
    setBy: m.setBy,
    setByName: displayNameForSubject(m.setBy),
    updatedAt: m.updatedAt ?? new Date(clock.now().getTime() - 6 * 86_400_000).toISOString(),
  };
}

function rowToBudget(r: Record<string, unknown>): UserBudgetRow {
  return {
    userId: toStr(r['user_id']),
    displayName: r['display_name'] != null ? toStr(r['display_name']) : null,
    period: 'monthly',
    allocatedUsd: toNum(r['allocated_usd']),
    hardCapUsd: r['hard_cap_usd'] == null ? null : toNum(r['hard_cap_usd']),
    note: r['note'] != null ? toStr(r['note']) : null,
    setBy: r['set_by'] != null ? toStr(r['set_by']) : null,
    setByName: r['set_by_name'] != null ? toStr(r['set_by_name']) : null,
    updatedAt: r['updated_at'] != null ? toStr(r['updated_at']) : null,
  };
}

const SELECT = `
  SELECT ub.user_id, au.display_name, ub.allocated_usd::float8 AS allocated_usd,
         ub.hard_cap_usd::float8 AS hard_cap_usd, ub.note, ub.set_by,
         sb.display_name AS set_by_name, ub.updated_at
    FROM user_budgets ub
    LEFT JOIN app_users au ON au.id = ub.user_id
    LEFT JOIN app_users sb ON sb.id = ub.set_by`;

/** The stored row, or null. Throws when it cannot be read (the gate decides what that means). */
export async function getUserBudget(userId: string): Promise<UserBudgetRow | null> {
  if (config.mock.aurora) {
    const m = userBudgets.rows().find((b) => b.userId === userId);
    return m ? mockRow(m) : null;
  }
  const rows = await exec(`${SELECT} WHERE ub.user_id = :u`, [s('u', userId)]);
  return rows[0] ? rowToBudget(rows[0]) : null;
}

/** The actor burn this period. Throws when the ledger cannot be read. */
export async function userSpendThisPeriod(userId: string): Promise<UserSpend> {
  if (config.mock.aurora) {
    const from = userPeriodStart().getTime();
    const stored = spendEntries.rows().filter((e) => e.actorId === userId && e.trigger !== 'cron' && Date.parse(e.occurredAt) >= from);
    // bot_run entries are derived offline (providers/spend-ledger.ts getActorSpend does the same).
    const { allMockRuns } = await import('../mock/bots.js');
    const runs = allMockRuns().filter((r) => r.dispatchedBy === userId && r.trigger !== 'cron'
      && (r.status === 'done' || r.status === 'failed') && Date.parse(r.startedAt) >= from);
    const costs = [...stored.map((e) => e.costUsd), ...runs.map((r) => r.costUsd ?? null)];
    return {
      spentUsd: round4(costs.reduce<number>((a, c) => a + (c ?? 0), 0)),
      unknownCount: costs.filter((c) => c == null).length,
    };
  }
  const rows = await exec(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spent, COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unknown
       FROM spend_entries
      WHERE actor_id = :u AND occurred_at >= ${PERIOD_START_SQL} AND trigger IS DISTINCT FROM 'cron'`,
    [s('u', userId)],
  );
  return { spentUsd: round4(toNum(rows[0]?.['spent'])), unknownCount: toNum(rows[0]?.['unknown']) };
}

export type UserBudgetGate =
  | { kind: 'ok'; row: UserBudgetRow; spend: UserSpend }
  | { kind: 'none' }
  | { kind: 'unavailable'; reason: string; error: unknown };

/**
 * The tri-state read the gate needs (DE-36): a row and its burn, no row, or
 * "could not read" — never a null that means both of the last two.
 */
export async function readUserBudgetGate(userId: string): Promise<UserBudgetGate> {
  try {
    const row = await getUserBudget(userId);
    if (!row) return { kind: 'none' };
    return { kind: 'ok', row, spend: await userSpendThisPeriod(userId) };
  } catch (error) {
    return { kind: 'unavailable', reason: (error as Error).message, error };
  }
}

/** A budget and its burn, as the read surfaces show it. `heldUsd` comes from the caller (the holds provider). */
export function userBudgetView(userId: string, row: UserBudgetRow | null, spend: UserSpend, heldUsd: number): UserBudgetView {
  const cap = row ? effectiveHardCap(row.allocatedUsd, row.hardCapUsd) : null;
  return {
    userId,
    displayName: row?.displayName ?? displayNameForSubject(userId),
    period: 'monthly',
    since: userPeriodStart().toISOString(),
    allocatedUsd: row?.allocatedUsd ?? null,
    hardCapUsd: row?.hardCapUsd ?? null,
    effectiveHardCapUsd: cap?.capUsd ?? null,
    hardCapSource: cap?.source ?? null,
    spentUsd: spend.spentUsd,
    unknownCount: spend.unknownCount,
    heldUsd,
    remainingUsd: row ? round4(row.allocatedUsd - spend.spentUsd - heldUsd) : null,
    note: row?.note ?? null,
    setBy: row?.setBy ?? null,
    setByName: row?.setByName ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** Every stored budget, plus every user who spent this period with none (the blind spots). */
export async function listUserBudgetRowsAndSpenders(): Promise<{ rows: UserBudgetRow[]; spenders: string[] }> {
  if (config.mock.aurora) {
    const rows = userBudgets.rows().map(mockRow);
    const from = userPeriodStart().getTime();
    const { allMockRuns } = await import('../mock/bots.js');
    const spenders = new Set<string>();
    for (const e of spendEntries.rows()) if (e.actorId && e.trigger !== 'cron' && Date.parse(e.occurredAt) >= from) spenders.add(e.actorId);
    for (const r of allMockRuns()) if (r.dispatchedBy && r.trigger !== 'cron' && Date.parse(r.startedAt) >= from) spenders.add(r.dispatchedBy);
    return { rows, spenders: [...spenders].sort() };
  }
  let rows: UserBudgetRow[] = [];
  try {
    rows = (await exec(`${SELECT} ORDER BY ub.user_id`)).map(rowToBudget);
  } catch (err) {
    if (!missingUserBudgetsTable(err)) throw err;
  }
  let spenders: string[] = [];
  try {
    spenders = (await exec(
      `SELECT DISTINCT actor_id FROM spend_entries
        WHERE actor_id IS NOT NULL AND occurred_at >= ${PERIOD_START_SQL} AND trigger IS DISTINCT FROM 'cron'
        ORDER BY actor_id`,
    )).map((r) => toStr(r['actor_id']));
  } catch (err) {
    if (!missingUserBudgetsTable(err)) throw err;
  }
  return { rows, spenders };
}

/** Does the app user exist? Offline: a seeded (or cloned) identity. */
export async function appUserExists(userId: string): Promise<boolean> {
  if (config.mock.aurora) return displayNameForSubject(userId) != null;
  const rows = await exec('SELECT 1 AS ok FROM app_users WHERE id = :u LIMIT 1', [s('u', userId)]);
  return rows.length > 0;
}

export interface UserBudgetInput {
  allocatedUsd: number;
  /** undefined = keep the stored cap; null = clear it (back to the default). */
  hardCapUsd?: number | null;
  /** undefined = keep; null/'' clears. */
  note?: string | null;
}

/** Insert or update a budget. Validation (cap >= allocation, self-set) is the route's. */
export async function upsertUserBudget(userId: string, input: UserBudgetInput, setBy: string | null): Promise<UserBudgetRow | null> {
  if (config.mock.aurora) {
    const rows = userBudgets.rows();
    const existing = rows.find((b) => b.userId === userId);
    const stamp = clock.nowIso();
    if (existing) {
      existing.allocatedUsd = input.allocatedUsd;
      if (input.hardCapUsd !== undefined) existing.hardCapUsd = input.hardCapUsd;
      if (input.note !== undefined) existing.note = input.note || null;
      existing.setBy = setBy;
      existing.updatedAt = stamp;
    } else {
      rows.push({
        userId, allocatedUsd: input.allocatedUsd, hardCapUsd: input.hardCapUsd ?? null,
        note: input.note || null, setBy, updatedAt: stamp,
      });
    }
    return getUserBudget(userId);
  }
  await exec(
    `INSERT INTO user_budgets (user_id, allocated_usd, hard_cap_usd, note, set_by)
     VALUES (:u, :alloc, :cap, :note, :by)
     ON CONFLICT (user_id) DO UPDATE
       SET allocated_usd = EXCLUDED.allocated_usd,
           hard_cap_usd = ${input.hardCapUsd !== undefined ? 'EXCLUDED.hard_cap_usd' : 'user_budgets.hard_cap_usd'},
           note = ${input.note !== undefined ? 'EXCLUDED.note' : 'user_budgets.note'},
           set_by = EXCLUDED.set_by,
           updated_at = NOW()`,
    [s('u', userId), num('alloc', input.allocatedUsd), num('cap', input.hardCapUsd ?? null), maybe('note', input.note || null), maybe('by', setBy)],
  );
  return getUserBudget(userId);
}

export async function deleteUserBudget(userId: string): Promise<boolean> {
  if (config.mock.aurora) {
    const rows = userBudgets.rows();
    const at = rows.findIndex((b) => b.userId === userId);
    if (at < 0) return false;
    rows.splice(at, 1);
    return true;
  }
  const rows = await exec('DELETE FROM user_budgets WHERE user_id = :u RETURNING user_id', [s('u', userId)]);
  return rows.length > 0;
}
