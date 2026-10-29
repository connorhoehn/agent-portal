// Run limits — storage (DE-37, docs/deployment-enhancements/DE-37-run-limits.md).
//
// The decision (which limit refuses, what the 429 says) is lib/run-limits.ts's
// pure `decideRunLimits`, evaluated inside lib/spend-holds.ts `reserveSpend`
// under the same lock as the hold. This module is the rows: `run_limits` per
// scope, `run_slots` as concurrency leases, and the usage the rate limits read
// from the spend ledger.
//
// ── Slots ────────────────────────────────────────────────────────────────────
// A slot's holder is the run's spend hold id. A slot is LIVE while it has not
// expired and no CLOSED hold matches its holder — so a run's slot frees when
// the run releases it (`releaseRunSlots`, at the run's end), when its hold
// settles/releases/expires, or at `expires_at`, whichever comes first. Nothing
// counts `bot_runs` rows, so the count holds across replicas: concurrent
// acquirers serialise on an advisory lock per scope key (`slots:<key>`), taken
// after the initiative → grant → user money locks, and the (scope_key, slot_no)
// primary key refuses a second writer of the same slot regardless.

import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { exec, withTransaction, type TxExec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { runLimits, runSlots, type RunLimitRow, type RunSlotRow } from '../mock/run-controls.js';

export type { RunLimitRow } from '../mock/run-controls.js';
export type ScopeKind = RunLimitRow['scopeKind'];

export interface RunScope { kind: ScopeKind; id: string }

export function scopeKey(s: RunScope): string {
  return `${s.kind}:${s.id}`;
}

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function numOrNull(name: string, v: number | null | undefined): SqlParameter {
  return v == null ? { name, value: { isNull: true } } : { name, value: { doubleValue: v } };
}
function intOrNull(name: string, v: number | null | undefined): SqlParameter {
  return v == null ? { name, value: { isNull: true } } : { name, value: { longValue: Math.floor(v) } };
}
const toNumOrNull = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toNum = (v: unknown): number => toNumOrNull(v) ?? 0;

export function missingRunControls(err: unknown): boolean {
  return /does not exist|relation/i.test((err as Error)?.message ?? '');
}

function rowToLimit(r: Record<string, unknown>): RunLimitRow {
  return {
    scopeKind: String(r['scope_kind']) as ScopeKind,
    scopeId: String(r['scope_id']),
    maxConcurrent: toNumOrNull(r['max_concurrent']),
    maxRunsPerDay: toNumOrNull(r['max_runs_per_day']),
    maxUsdPerHour: toNumOrNull(r['max_usd_per_hour']),
    updatedBy: r['updated_by'] != null ? String(r['updated_by']) : null,
    updatedAt: String(r['updated_at'] ?? ''),
  };
}

let warnedMissing = false;

/** The limit rows for these scopes. A missing table reads as no limits (and logs once). */
export async function readRunLimits(scopes: readonly RunScope[]): Promise<RunLimitRow[]> {
  if (scopes.length === 0) return [];
  if (config.mock.aurora) {
    return runLimits.rows().filter((r) => scopes.some((x) => x.kind === r.scopeKind && x.id === r.scopeId)).map((r) => ({ ...r }));
  }
  try {
    const where = scopes.map((_, i) => `(scope_kind = :k${i} AND scope_id = :i${i})`).join(' OR ');
    const params = scopes.flatMap((x, i) => [s(`k${i}`, x.kind), s(`i${i}`, x.id)]);
    const rows = await exec(`SELECT * FROM run_limits WHERE ${where}`, params);
    return (rows ?? []).map(rowToLimit);
  } catch (err) {
    if (!missingRunControls(err)) throw err;
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn('[run-limits] run_limits is not applied here; only the global bot-run ceiling applies');
    }
    return [];
  }
}

export async function getRunLimit(kind: ScopeKind, id: string): Promise<RunLimitRow | null> {
  return (await readRunLimits([{ kind, id }]))[0] ?? null;
}

export interface RunLimitPatch {
  maxConcurrent?: number | null;
  maxRunsPerDay?: number | null;
  maxUsdPerHour?: number | null;
}

/** Write one scope's limits (absent keys keep their value; null clears). Returns the row. */
export async function upsertRunLimit(kind: ScopeKind, id: string, patch: RunLimitPatch, actor: string | null): Promise<RunLimitRow> {
  const prior = await getRunLimit(kind, id);
  const next: RunLimitRow = {
    scopeKind: kind, scopeId: id,
    maxConcurrent: patch.maxConcurrent !== undefined ? patch.maxConcurrent : prior?.maxConcurrent ?? null,
    maxRunsPerDay: patch.maxRunsPerDay !== undefined ? patch.maxRunsPerDay : prior?.maxRunsPerDay ?? null,
    maxUsdPerHour: patch.maxUsdPerHour !== undefined ? patch.maxUsdPerHour : prior?.maxUsdPerHour ?? null,
    updatedBy: actor, updatedAt: clock.nowIso(),
  };
  if (config.mock.aurora) {
    const rows = runLimits.rows();
    const at = rows.findIndex((r) => r.scopeKind === kind && r.scopeId === id);
    if (at >= 0) rows[at] = next; else rows.push(next);
    return { ...next };
  }
  const rows = await exec(
    `INSERT INTO run_limits (scope_kind, scope_id, max_concurrent, max_runs_per_day, max_usd_per_hour, updated_by, updated_at)
     VALUES (:kind, :id, :mc, :rpd, :uph::numeric, :actor, NOW())
     ON CONFLICT (scope_kind, scope_id) DO UPDATE
        SET max_concurrent = EXCLUDED.max_concurrent, max_runs_per_day = EXCLUDED.max_runs_per_day,
            max_usd_per_hour = EXCLUDED.max_usd_per_hour, updated_by = EXCLUDED.updated_by, updated_at = NOW()
     RETURNING *`,
    [
      s('kind', kind), s('id', id), intOrNull('mc', next.maxConcurrent), intOrNull('rpd', next.maxRunsPerDay),
      numOrNull('uph', next.maxUsdPerHour), actor ? s('actor', actor) : { name: 'actor', value: { isNull: true } },
    ],
  );
  return rows[0] ? rowToLimit(rows[0]) : next;
}

// ─── Slots ────────────────────────────────────────────────────────────────────

/** The liveness rule, in SQL: not expired, and no closed hold owns it. */
const LIVE_SLOT = `s.expires_at > NOW() AND NOT EXISTS (
  SELECT 1 FROM spend_holds h WHERE h.id::text = s.holder AND h.status <> 'held')`;

async function mockLive(slot: RunSlotRow): Promise<boolean> {
  if (Date.parse(slot.expiresAt) <= clock.now().getTime()) return false;
  const { spendHolds } = await import('../mock/spend-holds.js');
  const hold = spendHolds.rows().find((h) => h.id === slot.holder);
  return !hold || hold.status === 'held';
}

/** Live slots at one scope key. */
export async function liveSlotCount(key: string): Promise<number> {
  if (config.mock.aurora) {
    let n = 0;
    for (const slot of runSlots.rows()) if (slot.scopeKey === key && await mockLive(slot)) n++;
    return n;
  }
  try {
    const rows = await exec(`SELECT COUNT(*)::int AS n FROM run_slots s WHERE s.scope_key = :k AND ${LIVE_SLOT}`, [s('k', key)]);
    return toNum(rows?.[0]?.['n']);
  } catch (err) {
    if (missingRunControls(err)) return 0;
    throw err;
  }
}

/** The advisory lock key for a slot scope (taken after the money locks). */
export function slotLockKey(key: string): string {
  return `slots:${key}`;
}

/**
 * Take one slot at `key` for `holder`, inside the caller's transaction (which
 * already holds `slotLockKey(key)`). Dead slots at the key are cleared first,
 * then the lowest free slot number is written. Returns false when the primary
 * key refused it (another writer took that number), which the caller treats as
 * a refusal.
 */
export async function insertRunSlot(tx: TxExec | null, key: string, holder: string, expiresAt: string): Promise<boolean> {
  if (config.mock.aurora || !tx) {
    const rows = runSlots.rows();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.scopeKey === key && !await mockLive(rows[i]!)) rows.splice(i, 1);
    }
    const taken = new Set(rows.filter((r) => r.scopeKey === key).map((r) => r.slotNo));
    let n = 0;
    while (taken.has(n)) n++;
    rows.push({ scopeKey: key, slotNo: n, holder, expiresAt, createdAt: clock.nowIso() });
    return true;
  }
  await tx(`DELETE FROM run_slots s WHERE s.scope_key = :k AND NOT (${LIVE_SLOT})`, [s('k', key)]);
  const out = await tx(
    `INSERT INTO run_slots (scope_key, slot_no, holder, expires_at)
     SELECT :k, COALESCE((SELECT MIN(n) FROM generate_series(0, 100000) n
                           WHERE NOT EXISTS (SELECT 1 FROM run_slots x WHERE x.scope_key = :k AND x.slot_no = n)), 0),
            :holder, :exp::timestamptz
     ON CONFLICT (scope_key, slot_no) DO NOTHING
     RETURNING slot_no`,
    [s('k', key), s('holder', holder), s('exp', expiresAt)],
  );
  return out.length > 0;
}

/**
 * Take a slot at every key whose limit has room, all or nothing, in its own
 * transaction under each key's advisory lock (keys in the order given). The
 * standalone form of what reserveSpend does under its money lock; exported for
 * callers without a hold and for the Postgres acceptance test.
 */
export async function acquireRunSlots(
  holder: string, keys: ReadonlyArray<{ key: string; max: number }>, expiresAt: string,
): Promise<{ ok: true } | { ok: false; key: string; max: number; live: number }> {
  if (config.mock.aurora) {
    for (const k of keys) {
      const live = await liveSlotCount(k.key);
      if (live >= k.max) return { ok: false, key: k.key, max: k.max, live };
    }
    for (const k of keys) await insertRunSlot(null, k.key, holder, expiresAt);
    return { ok: true };
  }
  return withTransaction(async (tx) => {
    for (const k of keys) await tx(`SELECT pg_advisory_xact_lock(hashtext(:k))`, [s('k', slotLockKey(k.key))]);
    for (const k of keys) {
      const rows = await tx(`SELECT COUNT(*)::int AS n FROM run_slots s WHERE s.scope_key = :k AND ${LIVE_SLOT}`, [s('k', k.key)]);
      const live = toNum(rows[0]?.['n']);
      if (live >= k.max) return { ok: false as const, key: k.key, max: k.max, live };
    }
    for (const k of keys) {
      if (!await insertRunSlot(tx, k.key, holder, expiresAt)) {
        throw new Error(`run slot at ${k.key} was taken concurrently`);
      }
    }
    return { ok: true as const };
  });
}

/** The run is over: its slots are free now, not at expiry. Best effort. */
export async function releaseRunSlots(holder: string | null | undefined): Promise<void> {
  if (!holder) return;
  try {
    if (config.mock.aurora) {
      const rows = runSlots.rows();
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.holder === holder) rows.splice(i, 1);
      return;
    }
    await exec(`DELETE FROM run_slots WHERE holder = :h`, [s('h', holder)]);
  } catch (err) {
    if (!missingRunControls(err)) console.warn(`[run-limits] could not release slots for ${holder}: ${(err as Error).message}`);
  }
}

/** The reaper's sweep: expired slots and slots whose hold closed are deleted. Returns how many. */
export async function freeDeadSlots(): Promise<number> {
  if (config.mock.aurora) {
    const rows = runSlots.rows();
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (!await mockLive(rows[i]!)) { rows.splice(i, 1); n++; }
    }
    return n;
  }
  try {
    const rows = await exec(`DELETE FROM run_slots s WHERE NOT (${LIVE_SLOT}) RETURNING s.holder`);
    return rows?.length ?? 0;
  } catch (err) {
    if (missingRunControls(err)) return 0;
    throw err;
  }
}

/** Initiatives whose concurrency limit is used up: the dispatcher claims none of their jobs. */
export async function saturatedInitiatives(): Promise<string[]> {
  if (config.mock.aurora) {
    const out: string[] = [];
    for (const l of runLimits.rows()) {
      if (l.scopeKind !== 'initiative' || l.maxConcurrent == null) continue;
      if (await liveSlotCount(`initiative:${l.scopeId}`) >= l.maxConcurrent) out.push(l.scopeId);
    }
    return out;
  }
  try {
    const rows = await exec(
      `SELECT l.scope_id FROM run_limits l
        WHERE l.scope_kind = 'initiative' AND l.max_concurrent IS NOT NULL
          AND l.max_concurrent <= (SELECT COUNT(*) FROM run_slots s
                                    WHERE s.scope_key = 'initiative:' || l.scope_id AND ${LIVE_SLOT})`,
    );
    return (rows ?? []).map((r) => String(r['scope_id']));
  } catch (err) {
    if (missingRunControls(err)) return [];
    throw err;
  }
}

// ─── Usage the rate limits read ──────────────────────────────────────────────

export interface ScopeUsage {
  /** Ledger entries in the last 24 h plus runs holding a slot now. */
  runsToday: number;
  /** Ledger dollars in the last hour plus money held open now. */
  usdLastHour: number;
  /** Live concurrency slots. */
  liveSlots: number;
}

/**
 * Runs per day and dollars per hour for a scope, from the ledger (DE-30) plus
 * what is in flight: a running task counts as one run now, and its held money
 * counts once reserved. `tenant` and `global` scopes read every entry (the
 * orgiq tenant is the only one that dispatches devbox work).
 */
export async function scopeUsage(scope: RunScope): Promise<ScopeUsage> {
  const key = scopeKey(scope);
  const liveSlots = await liveSlotCount(key);
  const byInitiative = scope.kind === 'initiative';
  if (config.mock.aurora) {
    const { spendEntries } = await import('../mock/spend-ledger.js');
    const { spendHolds } = await import('../mock/spend-holds.js');
    const now = clock.now().getTime();
    const mine = <T extends { initiativeId: string | null }>(r: T) => !byInitiative || r.initiativeId === scope.id;
    const entries = spendEntries.rows().filter(mine);
    const runsToday = entries.filter((e) => now - Date.parse(e.occurredAt) < 86_400_000).length;
    const ledgerHour = entries.filter((e) => now - Date.parse(e.occurredAt) < 3_600_000).reduce((a, e) => a + (e.costUsd ?? 0), 0);
    const held = spendHolds.rows().filter((h) => h.status === 'held' && mine(h)).reduce((a, h) => a + h.amountUsd, 0);
    return { runsToday: runsToday + liveSlots, usdLastHour: Math.round((ledgerHour + held) * 10_000) / 10_000, liveSlots };
  }
  const where = byInitiative ? 'initiative_id = :pid AND ' : '';
  const params = byInitiative ? [s('pid', scope.id)] : [];
  let runsToday = 0;
  let usdLastHour = 0;
  try {
    const rows = await exec(
      `SELECT COUNT(*) FILTER (WHERE occurred_at > NOW() - INTERVAL '1 day')::int AS runs,
              COALESCE(SUM(cost_usd) FILTER (WHERE occurred_at > NOW() - INTERVAL '1 hour'), 0)::float8 AS usd
         FROM spend_entries WHERE ${where}occurred_at > NOW() - INTERVAL '1 day'`,
      params,
    );
    runsToday = toNum(rows?.[0]?.['runs']);
    usdLastHour = toNum(rows?.[0]?.['usd']);
  } catch (err) {
    if (!missingRunControls(err)) throw err;
  }
  try {
    const held = await exec(
      `SELECT COALESCE(SUM(amount_usd), 0)::float8 AS held FROM spend_holds WHERE ${where}status = 'held'`,
      params,
    );
    usdLastHour += toNum(held?.[0]?.['held']);
  } catch (err) {
    if (!missingRunControls(err)) throw err;
  }
  return { runsToday: runsToday + liveSlots, usdLastHour: Math.round(usdLastHour * 10_000) / 10_000, liveSlots };
}
