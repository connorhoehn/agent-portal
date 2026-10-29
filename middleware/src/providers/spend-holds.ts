// Spend holds — storage (DE-34, docs/deployment-enhancements/DE-34-spend-holds.md).
//
// A hold is the forecast's p75 written at dispatch and counted as spent by the
// budget brakes until the ledger entry for the same (source, source_id) lands.
// This module is persistence and the lock; the decision — which brake fires,
// what the 409 says — is lib/spend-holds.ts's `reserveSpend`, the one
// chokepoint every spend path calls before its first side effect.
//
// ── The lock ─────────────────────────────────────────────────────────────────
// `withSpendLock` runs its body inside one transaction after
// `pg_advisory_xact_lock(hashtext(key))` for each key, in the order given:
// always the initiative first, then the grant (a per-user key will follow, in
// that order), so two dispatches cannot deadlock. Reads the body issues through
// the ordinary autocommit `exec` start after the lock is acquired, so each sees
// every hold committed by the dispatch it waited on; the hold INSERT goes
// through the transaction so the lock covers it, and commit releases the lock.
// Offline the same shape runs under an in-process keyed mutex, because the
// mock dispatch awaits between its reads and its append and two requests
// would otherwise interleave exactly as the un-held Aurora path did.
//
// ── Settle ───────────────────────────────────────────────────────────────────
// `settleHold` closes the hold whose ledger entry has a KNOWN cost. An entry
// written with cost unknown leaves the hold `held` until it expires: a run
// that reported no figure does not free its money early, and the DE-33
// unknown-cost brake stays armed on the entry (the alternative — converting
// the hold into an estimated entry at the held amount — is recorded as a
// decision owed, not built).

import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec, withTransaction, type TxExec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { spendHolds } from '../mock/spend-holds.js';
import type { SpendSource } from './spend-ledger.js';
import { hasColumns } from './column-probe.js';
import { budgetFailClosed } from '../lib/budget-decisions.js';

export type HoldSource = SpendSource;
export type HoldBasis = 'p75' | 'confirmed_over' | 'topup';
export type HoldStatus = 'held' | 'settled' | 'released' | 'expired';

export interface SpendHold {
  id: string;
  /** Null = unattributed spend held only against its actor's user budget (DE-54). */
  initiativeId: string | null;
  grantId: string | null;
  actorId: string | null;
  source: HoldSource;
  sourceId: string | null;
  amountUsd: number;
  basis: HoldBasis;
  /** An essential bot's scheduled firing: floor money, counted against the maintenance reserve (DE-55). */
  essential: boolean;
  status: HoldStatus;
  expiresAt: string;
  createdBy: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface HoldInput {
  initiativeId: string | null;
  grantId?: string | null;
  actorId?: string | null;
  source: HoldSource;
  sourceId?: string | null;
  amountUsd: number;
  basis: HoldBasis;
  essential?: boolean;
  expiresAt: string;
}

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : { name, value: { isNull: true } };
}
function num(name: string, v: number): SqlParameter { return { name, value: { doubleValue: v } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** `SPEND_HOLDS=off` is the kill switch: brakes judge settled spend only, as before DE-34. */
export function spendHoldsEnabled(): boolean {
  return (process.env['SPEND_HOLDS'] ?? '').trim().toLowerCase() !== 'off';
}

/** `SPEND_HOLDS_FAIL_CLOSED=1`: an unreadable hold store refuses the dispatch instead of proceeding unheld.
 *  Also on wherever budget state fails closed (DE-36 `BUDGET_FAIL_CLOSED`, default on in production):
 *  a hold store that cannot be read is budget state that cannot be read. */
export function spendHoldsFailClosed(): boolean {
  return (process.env['SPEND_HOLDS_FAIL_CLOSED'] ?? '').trim() === '1' || budgetFailClosed();
}

export function missingHoldsTable(err: unknown): boolean {
  return /does not exist|relation/i.test((err as Error)?.message ?? '');
}

function rowToHold(r: Record<string, unknown>): SpendHold {
  return {
    id: toStr(r['id']),
    initiativeId: r['initiative_id'] != null ? toStr(r['initiative_id']) : null,
    grantId: r['grant_id'] != null ? toStr(r['grant_id']) : null,
    actorId: r['actor_id'] != null ? toStr(r['actor_id']) : null,
    source: toStr(r['source']) as HoldSource,
    sourceId: r['source_id'] != null ? toStr(r['source_id']) : null,
    amountUsd: toNum(r['amount_usd']),
    basis: toStr(r['basis']) as HoldBasis,
    // Absent before maintenance_reserve_schema.sql: every hold was discretionary.
    essential: r['essential'] === true || r['essential'] === 't' || r['essential'] === 'true',
    status: toStr(r['status']) as HoldStatus,
    expiresAt: toStr(r['expires_at']),
    createdBy: r['created_by'] != null ? toStr(r['created_by']) : null,
    createdAt: toStr(r['created_at']),
    closedAt: r['closed_at'] != null ? toStr(r['closed_at']) : null,
  };
}

// ─── The mock's keyed mutex ───────────────────────────────────────────────────

const chains = new Map<string, Promise<void>>();

/** Wait for `key`; the returned function hands it to the next waiter. */
async function acquire(key: string): Promise<() => void> {
  const prior = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => { release = resolve; });
  const next = prior.then(() => mine);
  chains.set(key, next);
  await prior;
  return () => {
    release();
    if (chains.get(key) === next) chains.delete(key);
  };
}

// ─── The lock + insert ────────────────────────────────────────────────────────

export interface SpendLockTx {
  /** Take a further key, in order (the grant after the initiative). */
  lock(key: string): Promise<void>;
  /** Write the hold under the lock; the commit releases the lock. */
  insertHold(input: HoldInput): Promise<SpendHold>;
}

/**
 * Serialise the body on `keys` (in order) and hand it a transaction-bound
 * `insertHold`. The body's other reads use the ordinary providers.
 */
export async function withSpendLock<T>(keys: readonly string[], fn: (tx: SpendLockTx) => Promise<T>): Promise<T> {
  if (config.mock.aurora) {
    const releases: Array<() => void> = [];
    try {
      for (const k of keys) releases.push(await acquire(k));
      return await fn({
        lock: async (key) => { releases.push(await acquire(key)); },
        insertHold: async (input) => {
          const row: SpendHold = {
            id: randomUUID(),
            initiativeId: input.initiativeId,
            grantId: input.grantId ?? null,
            actorId: input.actorId ?? null,
            source: input.source,
            sourceId: input.sourceId ?? null,
            amountUsd: input.amountUsd,
            basis: input.basis,
            essential: input.essential === true,
            status: 'held',
            expiresAt: input.expiresAt,
            createdBy: input.actorId ?? null,
            createdAt: clock.nowIso(),
            closedAt: null,
          };
          spendHolds.rows().push(row);
          return { ...row };
        },
      });
    } finally {
      // Release in reverse order, as the transaction's commit does at once.
      for (const release of releases.reverse()) release();
    }
  }
  // Probed outside the transaction (cached): an older cluster takes the row without the flag.
  const withEssential = await hasColumns('spend_holds', ['essential']).catch(() => false);
  return withTransaction(async (tx: TxExec) => {
    const lock = async (key: string): Promise<void> => {
      await tx(`SELECT pg_advisory_xact_lock(hashtext(:k))`, [s('k', key)]);
    };
    for (const k of keys) await lock(k);
    return fn({
      lock,
      insertHold: async (input) => {
        const rows = await tx(
          `INSERT INTO spend_holds (initiative_id, grant_id, actor_id, source, source_id, amount_usd, basis, expires_at, created_by${withEssential ? ', essential' : ''})
           VALUES (:pid, :gid, :actor, :source, :sid, :amount::numeric, :basis, :exp::timestamptz, :actor${withEssential ? ', :essential' : ''})
           RETURNING *`,
          [
            maybe('pid', input.initiativeId), maybe('gid', input.grantId), maybe('actor', input.actorId),
            s('source', input.source), maybe('sid', input.sourceId), num('amount', input.amountUsd),
            s('basis', input.basis), s('exp', input.expiresAt),
            ...(withEssential ? [{ name: 'essential', value: { booleanValue: input.essential === true } }] : []),
          ],
        );
        if (!rows[0]) throw new Error('spend_holds insert returned no row');
        return rowToHold(rows[0]);
      },
    });
  });
}

// ─── Reads ────────────────────────────────────────────────────────────────────

function openMockHolds(filter: (h: SpendHold) => boolean): SpendHold[] {
  return spendHolds.rows().filter((h) => h.status === 'held' && filter(h));
}

const sumUsd = (holds: readonly SpendHold[]): number =>
  Math.round(holds.reduce((acc, h) => acc + h.amountUsd, 0) * 10_000) / 10_000;

/** Money held on an initiative by dispatches still in flight. */
export async function openHeldUsd(initiativeId: string): Promise<number> {
  if (config.mock.aurora) return sumUsd(openMockHolds((h) => h.initiativeId === initiativeId));
  const rows = await exec(
    `SELECT COALESCE(SUM(amount_usd), 0)::float8 AS held FROM spend_holds WHERE initiative_id = :pid AND status = 'held'`,
    [s('pid', initiativeId)],
  );
  return toNum(rows[0]?.['held']);
}

/** An initiative's open holds split into floor (essential firings) and discretionary money (DE-55). */
export async function openHeldSplit(initiativeId: string): Promise<{ floorUsd: number; discretionaryUsd: number }> {
  if (config.mock.aurora) {
    const open = openMockHolds((h) => h.initiativeId === initiativeId);
    return { floorUsd: sumUsd(open.filter((h) => h.essential)), discretionaryUsd: sumUsd(open.filter((h) => !h.essential)) };
  }
  const withEssential = await hasColumns('spend_holds', ['essential']).catch(() => false);
  const rows = await exec(
    withEssential
      ? `SELECT COALESCE(SUM(amount_usd) FILTER (WHERE essential), 0)::float8 AS floor,
                COALESCE(SUM(amount_usd) FILTER (WHERE NOT essential), 0)::float8 AS disc
           FROM spend_holds WHERE initiative_id = :pid AND status = 'held'`
      : `SELECT 0::float8 AS floor, COALESCE(SUM(amount_usd), 0)::float8 AS disc
           FROM spend_holds WHERE initiative_id = :pid AND status = 'held'`,
    [s('pid', initiativeId)],
  );
  return { floorUsd: toNum(rows[0]?.['floor']), discretionaryUsd: toNum(rows[0]?.['disc']) };
}

/** Every initiative's open holds, split, for the Budgets list. */
export async function openHeldSplitAll(): Promise<Map<string, { floorUsd: number; discretionaryUsd: number }>> {
  const out = new Map<string, { floorUsd: number; discretionaryUsd: number }>();
  if (config.mock.aurora) {
    for (const h of openMockHolds((x) => x.initiativeId != null)) {
      const cur = out.get(h.initiativeId!) ?? { floorUsd: 0, discretionaryUsd: 0 };
      if (h.essential) cur.floorUsd = Math.round((cur.floorUsd + h.amountUsd) * 10_000) / 10_000;
      else cur.discretionaryUsd = Math.round((cur.discretionaryUsd + h.amountUsd) * 10_000) / 10_000;
      out.set(h.initiativeId!, cur);
    }
    return out;
  }
  try {
    const withEssential = await hasColumns('spend_holds', ['essential']).catch(() => false);
    const rows = await exec(
      `SELECT initiative_id,
              ${withEssential ? 'COALESCE(SUM(amount_usd) FILTER (WHERE essential), 0)::float8' : '0::float8'} AS floor,
              COALESCE(SUM(amount_usd)${withEssential ? ' FILTER (WHERE NOT essential)' : ''}, 0)::float8 AS disc
         FROM spend_holds WHERE status = 'held' AND initiative_id IS NOT NULL GROUP BY initiative_id`,
    );
    for (const r of rows) out.set(toStr(r['initiative_id']), { floorUsd: toNum(r['floor']), discretionaryUsd: toNum(r['disc']) });
  } catch (err) {
    if (!missingHoldsTable(err)) throw err;
  }
  return out;
}

/** Money held by one actor across every initiative (the user budget's in-flight burn, DE-54). */
export async function openHeldUsdForActor(actorId: string): Promise<number> {
  if (config.mock.aurora) return sumUsd(openMockHolds((h) => h.actorId === actorId && !h.essential));
  const withEssential = await hasColumns('spend_holds', ['essential']).catch(() => false);
  const rows = await exec(
    `SELECT COALESCE(SUM(amount_usd), 0)::float8 AS held FROM spend_holds
      WHERE actor_id = :a AND status = 'held'${withEssential ? ' AND NOT essential' : ''}`,
    [s('a', actorId)],
  );
  return toNum(rows[0]?.['held']);
}

/** Money held on a grant (the envelope's in-flight burn). */
export async function openHeldUsdForGrant(grantId: string): Promise<number> {
  if (config.mock.aurora) return sumUsd(openMockHolds((h) => h.grantId === grantId));
  const rows = await exec(
    `SELECT COALESCE(SUM(amount_usd), 0)::float8 AS held FROM spend_holds WHERE grant_id = :gid AND status = 'held'`,
    [s('gid', grantId)],
  );
  return toNum(rows[0]?.['held']);
}

/** Open holds on an initiative, for the spend report. */
export async function listOpenHolds(initiativeId: string): Promise<SpendHold[]> {
  if (config.mock.aurora) return openMockHolds((h) => h.initiativeId === initiativeId).map((h) => ({ ...h }));
  const rows = await exec(
    `SELECT * FROM spend_holds WHERE initiative_id = :pid AND status = 'held' ORDER BY created_at`,
    [s('pid', initiativeId)],
  );
  return rows.map(rowToHold);
}

// ─── Writes after the hold ────────────────────────────────────────────────────

/** Name the row the hold is for, once that row exists (the bot_run id, the run id). */
export async function bindHoldSource(holdId: string, source: HoldSource, sourceId: string): Promise<void> {
  if (config.mock.aurora) {
    const h = spendHolds.rows().find((x) => x.id === holdId);
    if (h) { h.source = source; h.sourceId = sourceId; }
    return;
  }
  await exec(
    `UPDATE spend_holds SET source = :source, source_id = :sid WHERE id = :id::uuid AND status = 'held'`,
    [s('id', holdId), s('source', source), s('sid', sourceId)],
  );
}

/** A dispatch that failed before its run was live gives the money back. */
export async function releaseHold(holdId: string | null | undefined): Promise<void> {
  if (!holdId) return;
  try {
    if (config.mock.aurora) {
      const h = spendHolds.rows().find((x) => x.id === holdId);
      if (h && h.status === 'held') { h.status = 'released'; h.closedAt = clock.nowIso(); }
      return;
    }
    await exec(
      `UPDATE spend_holds SET status = 'released', closed_at = NOW() WHERE id = :id::uuid AND status = 'held'`,
      [s('id', holdId)],
    );
  } catch (err) {
    console.warn(`[spend-holds] could not release ${holdId}: ${(err as Error).message}`);
  }
}

/** The statement `settleHold` runs: settle the hold whose ledger entry has a KNOWN cost. */
export const SETTLE_HOLD_SQL = `
  UPDATE spend_holds SET status = 'settled', closed_at = NOW()
   WHERE source = :source AND source_id = :sid AND status = 'held'
     AND EXISTS (SELECT 1 FROM spend_entries se
                  WHERE se.source = :source AND se.source_id = :sid AND se.cost_usd IS NOT NULL)`;

/**
 * Settle the hold behind a ledger entry. Called by the ledger writers after
 * their insert, through the same transaction when they have one. A hold whose
 * entry is still unknown-cost stays held (see the header). Idempotent: a
 * settled hold is not re-settled, so a retried settle changes nothing.
 */
export async function settleHold(
  source: HoldSource, sourceId: string, run: TxExec = exec, costKnown?: boolean,
): Promise<void> {
  if (config.mock.aurora) {
    if (costKnown === false) return;
    const h = spendHolds.rows().find((x) => x.source === source && x.sourceId === sourceId && x.status === 'held');
    if (h) { h.status = 'settled'; h.closedAt = clock.nowIso(); }
    return;
  }
  try {
    await run(SETTLE_HOLD_SQL, [s('source', source), s('sid', sourceId)]);
  } catch (err) {
    if (missingHoldsTable(err)) return;
    throw err;
  }
}

/** The reconcile tick's statement: holds past their expiry are closed. Returns how many. */
export async function expireHolds(): Promise<number> {
  if (config.mock.aurora) {
    const now = clock.now().getTime();
    let n = 0;
    for (const h of spendHolds.rows()) {
      if (h.status === 'held' && Date.parse(h.expiresAt) < now) { h.status = 'expired'; h.closedAt = clock.nowIso(); n++; }
    }
    return n;
  }
  try {
    const rows = await exec(
      `UPDATE spend_holds SET status = 'expired', closed_at = NOW()
        WHERE status = 'held' AND expires_at < NOW() RETURNING id`,
    );
    return rows.length;
  } catch (err) {
    if (missingHoldsTable(err)) return 0;
    throw err;
  }
}

/**
 * The boot sweep's statement: a hold whose owner row is already terminal can
 * never settle through that row's own path, so it is expired now rather than
 * at its deadline. Box tasks have no owner row and expire by time only.
 */
export async function expireHoldsWithTerminalOwners(): Promise<number> {
  if (config.mock.aurora) return 0;
  try {
    const rows = await exec(
      `UPDATE spend_holds h SET status = 'expired', closed_at = NOW()
        WHERE h.status = 'held' AND h.source_id IS NOT NULL AND (
          (h.source = 'bot_run' AND EXISTS (
             SELECT 1 FROM bot_runs br WHERE br.id::text = h.source_id AND br.status <> 'running'))
          OR (h.source = 'agent_project_run' AND EXISTS (
             SELECT 1 FROM agent_project_runs r WHERE r.id::text = h.source_id AND r.status IN ('done', 'failed')))
          OR (h.source = 'job' AND EXISTS (
             SELECT 1 FROM agent_jobs j WHERE j.id = split_part(h.source_id, ':', 1)
                AND j.status IN ('done', 'awaiting_review', 'failed', 'cancelled')))
        ) RETURNING id`,
    );
    return rows.length;
  } catch (err) {
    if (missingHoldsTable(err)) return 0;
    throw err;
  }
}

/** The stored mock rows. For tests and the mock report. */
export function mockHolds(): SpendHold[] {
  return spendHolds.rows();
}
