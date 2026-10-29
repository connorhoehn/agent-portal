// Kill switches for the agent fleet (DE-50, docs/deployment-enhancements/DE-50-kill-switches-and-alerts.md).
//
// Two scopes: `fleet` (every new run everywhere) and `initiative:<id>`. A
// paused scope refuses every new spend at lib/spend-holds.ts `reserveSpend`
// — so every path that starts model spend (box tasks, the agent loop, bot
// fires, dispatches, governed runs, queued jobs, mid-run top-ups) is covered by
// one check — and the job dispatcher claims nothing for it. Running tasks
// finish, bounded by their ceilings (DE-35/DE-48).
//
// Reads are cached for 10 s per process; a flip through `setSwitch` clears
// this process's cache at once (another replica sees it within 10 s).
//
// ── Decisions this encodes (recorded in the goal doc) ────────────────────────
// - Flipping needs ManageBudgets; the fleet scope additionally needs an
//   org-wide role (org-leader, hr-admin, admin); an initiative scope needs
//   stewardship of it (org-wide roles pass). routes/ops-switches.ts.
// - Auto-pause at 100 % of an allocation is OFF by default
//   (`BUDGET_AUTO_PAUSE=on` turns it on; lib/fleet-alerts.ts) — a user decision.
// - An unreadable switch table (not applied) reads as not paused, and logs;
//   where budget state fails closed (BUDGET_FAIL_CLOSED, on in production) any
//   other read error refuses the spend (503).

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { fleetSwitches, fleetSwitchLog, type FleetSwitchRow } from '../mock/run-controls.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';

export type { FleetSwitchRow } from '../mock/run-controls.js';

export const FLEET_SCOPE = 'fleet';
export const initiativeScope = (id: string): string => `initiative:${id}`;

export function validSwitchScope(scope: string): boolean {
  return scope === FLEET_SCOPE || /^initiative:[A-Za-z0-9._-]{1,200}$/.test(scope);
}

const TTL_MS = 10_000;
let cache: { at: number; rows: FleetSwitchRow[] } | null = null;
let warnedMissing = false;

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }

function missingTable(err: unknown): boolean {
  return /does not exist|relation/i.test((err as Error)?.message ?? '');
}

function rowToSwitch(r: Record<string, unknown>): FleetSwitchRow {
  return {
    scope: String(r['scope']),
    paused: r['paused'] === true || r['paused'] === 't' || r['paused'] === 'true',
    reason: r['reason'] != null ? String(r['reason']) : null,
    setBy: r['set_by'] != null ? String(r['set_by']) : null,
    setAt: String(r['set_at'] ?? ''),
  };
}

/** Every switch row (paused or lifted), uncached. */
export async function listSwitches(): Promise<FleetSwitchRow[]> {
  if (config.mock.aurora) return fleetSwitches.rows().map((r) => ({ ...r }));
  try {
    return ((await exec(`SELECT * FROM fleet_switches ORDER BY scope`)) ?? []).map(rowToSwitch);
  } catch (err) {
    if (!missingTable(err)) throw err;
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn('[fleet-switches] fleet_switches is not applied here; nothing can be paused');
    }
    return [];
  }
}

async function cachedSwitches(): Promise<FleetSwitchRow[]> {
  // Offline there is no other replica and the fixture is the source of truth.
  if (config.mock.aurora) return listSwitches();
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rows;
  const rows = await listSwitches();
  cache = { at: now, rows };
  return rows;
}

export interface PauseHit { scope: string; reason: string | null; setBy: string | null; setAt: string }

/** The pause that refuses spend on this initiative (fleet first), or null. */
export async function pauseFor(initiativeId: string | null): Promise<PauseHit | null> {
  const rows = await cachedSwitches();
  const hit = rows.find((r) => r.paused && r.scope === FLEET_SCOPE)
    ?? (initiativeId ? rows.find((r) => r.paused && r.scope === initiativeScope(initiativeId)) : undefined);
  return hit ? { scope: hit.scope, reason: hit.reason, setBy: hit.setBy, setAt: hit.setAt } : null;
}

export async function fleetPaused(): Promise<boolean> {
  return (await pauseFor(null)) !== null;
}

/** The sentence a 423 carries. */
export function pauseMessage(hit: PauseHit): string {
  const what = hit.scope === FLEET_SCOPE ? 'The agent fleet is paused' : `Initiative ${hit.scope.slice('initiative:'.length)} is paused`;
  return `${what}${hit.reason ? ` (${hit.reason})` : ''}; no new work was started.`;
}

/** Flip a switch. Returns the row as written; clears this process's cache. */
export async function setSwitch(scope: string, paused: boolean, reason: string | null, actor: string | null): Promise<FleetSwitchRow> {
  const row: FleetSwitchRow = { scope, paused, reason, setBy: actor, setAt: clock.nowIso() };
  cache = null;
  if (config.mock.aurora) {
    const rows = fleetSwitches.rows();
    const at = rows.findIndex((r) => r.scope === scope);
    if (at >= 0) rows[at] = row; else rows.push(row);
    fleetSwitchLog.rows().push({ ...row });
    return { ...row };
  }
  // The audit row: every flip, append-only. Best effort on a cluster without it.
  await exec(
    `INSERT INTO fleet_switch_log (scope, paused, reason, set_by) VALUES (:scope, :paused, :reason, :actor)`,
    [
      s('scope', scope), { name: 'paused', value: { booleanValue: paused } },
      reason ? s('reason', reason) : { name: 'reason', value: { isNull: true } },
      actor ? s('actor', actor) : { name: 'actor', value: { isNull: true } },
    ],
  ).catch((err: unknown) => { if (!missingTable(err)) throw err; });
  const out = await exec(
    `INSERT INTO fleet_switches (scope, paused, reason, set_by, set_at) VALUES (:scope, :paused, :reason, :actor, NOW())
     ON CONFLICT (scope) DO UPDATE SET paused = EXCLUDED.paused, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = NOW()
     RETURNING *`,
    [
      s('scope', scope), { name: 'paused', value: { booleanValue: paused } },
      reason ? s('reason', reason) : { name: 'reason', value: { isNull: true } },
      actor ? s('actor', actor) : { name: 'actor', value: { isNull: true } },
    ],
  );
  return out?.[0] ? rowToSwitch(out[0]) : row;
}

/** The flips of one scope (or every scope), newest first. */
export async function switchHistory(scope?: string, limit = 50): Promise<FleetSwitchRow[]> {
  if (config.mock.aurora) {
    return fleetSwitchLog.rows().filter((r) => !scope || r.scope === scope)
      .sort((a, b) => b.setAt.localeCompare(a.setAt)).slice(0, limit).map((r) => ({ ...r }));
  }
  try {
    const rows = await exec(
      `SELECT * FROM fleet_switch_log ${scope ? 'WHERE scope = :scope ' : ''}ORDER BY set_at DESC LIMIT ${Math.max(1, Math.min(500, limit))}`,
      scope ? [s('scope', scope)] : [],
    );
    return (rows ?? []).map(rowToSwitch);
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

/** Test seam. */
export function _resetFleetSwitchCache(): void {
  cache = null;
}
