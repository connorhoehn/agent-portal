// Org-sweep runs as data (docs/voice-navigator-spec.md §4 `bot_sweep_status`): storage only.
//
// `agent_findings` records what a sweep found; this records that it ran, so
// "has a sweep failed since yesterday" has an answer. Everything here is best
// effort: a store failure is logged and swallowed, never thrown into a sweep.
// `error` is a message only, never a stack, a query or content.

import { randomUUID } from 'node:crypto';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { clock } from '../mock/core/index.js';
import { sweepRuns } from '../mock/sweep-runs.js';

export type SweepRunStatus = 'running' | 'ok' | 'failed' | 'cancelled';

export interface SweepRunRow {
  id: string;
  tenant: string;
  sweep: string;
  botId: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: SweepRunStatus;
  error: string | null;
  findings: number | null;
  durationMs: number | null;
}

/** The scheduled org sweeps belong to the orgiq tenant. */
export const SWEEP_TENANT = 'orgiq';
const MAX_ERROR = 500;

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function n(name: string, value: number): SqlParameter { return { name, value: { longValue: Math.round(value) } }; }
function cleanError(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.split('\n')[0]!.slice(0, MAX_ERROR);
}
function warn(what: string, err: unknown): void {
  console.warn(`[sweeps] sweep_runs ${what} failed:`, err instanceof Error ? err.message : String(err));
}

/** Record a run starting. Returns its id, or null when the store could not take it. */
export async function startSweepRun(sweep: string, opts: { tenant?: string; botId?: string | null } = {}): Promise<string | null> {
  const tenant = opts.tenant ?? SWEEP_TENANT;
  try {
    if (config.mock.aurora) {
      const id = randomUUID();
      sweepRuns.rows().push({
        id, tenant, sweep, botId: opts.botId ?? null, startedAt: clock.nowIso(), finishedAt: null,
        status: 'running', error: null, findings: null, durationMs: null,
      });
      return id;
    }
    const rows = await exec(
      `INSERT INTO sweep_runs (tenant, sweep, bot_id, status) VALUES (:tenant, :sweep, :bot, 'running') RETURNING id::text AS id`,
      [s('tenant', tenant), s('sweep', sweep),
        opts.botId ? s('bot', opts.botId) : { name: 'bot', value: { isNull: true } }],
    );
    return rows[0] ? String(rows[0]['id']) : null;
  } catch (err) { warn('start', err); return null; }
}

/** Close a run: ok with its findings count, or failed with the error's message. */
export async function finishSweepRun(
  id: string | null,
  outcome: { status: 'ok'; findings: number } | { status: 'failed' | 'cancelled'; error: unknown },
): Promise<void> {
  if (!id) return;
  const error = outcome.status === 'ok' ? null : cleanError(outcome.error);
  const findings = outcome.status === 'ok' ? outcome.findings : null;
  try {
    if (config.mock.aurora) {
      const row = sweepRuns.rows().find((r) => r.id === id);
      if (!row) return;
      const now = clock.nowIso();
      row.finishedAt = now;
      row.status = outcome.status;
      row.error = error;
      row.findings = findings;
      row.durationMs = Math.max(0, Date.parse(now) - Date.parse(row.startedAt));
      return;
    }
    await exec(
      `UPDATE sweep_runs
          SET finished_at = NOW(), status = :status, error = :error, findings = :findings,
              duration_ms = (EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000)::int
        WHERE id = :id::uuid`,
      [s('status', outcome.status), s('id', id),
        error == null ? { name: 'error', value: { isNull: true } } : s('error', error),
        findings == null ? { name: 'findings', value: { isNull: true } } : n('findings', findings)],
    );
  } catch (err) { warn('finish', err); }
}

export interface ListSweepRunsOptions {
  tenant: string;
  /** ISO instant: only runs started at or after it. */
  since?: string;
  failedOnly?: boolean;
  limit?: number;
}

export function clampSweepRunLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(200, Number.isFinite(limit) ? Math.floor(limit as number) : 50));
}

/** Newest first, one tenant, capped at 200. */
export async function listSweepRuns(opts: ListSweepRunsOptions): Promise<SweepRunRow[]> {
  const limit = clampSweepRunLimit(opts.limit);
  if (config.mock.aurora) {
    const sinceMs = opts.since ? Date.parse(opts.since) : null;
    return sweepRuns.rows()
      .filter((r) => r.tenant === opts.tenant
        && (sinceMs == null || Date.parse(r.startedAt) >= sinceMs)
        && (!opts.failedOnly || r.status === 'failed'))
      .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, limit)
      .map((r) => ({ ...r }));
  }
  const params: SqlParameter[] = [s('tenant', opts.tenant)];
  let where = 'tenant = :tenant';
  if (opts.since) { where += ' AND started_at >= :since::timestamptz'; params.push(s('since', opts.since)); }
  if (opts.failedOnly) where += " AND status = 'failed'";
  const rows = await exec(
    `SELECT id::text AS id, tenant, sweep, bot_id, started_at::text AS started_at, finished_at::text AS finished_at,
            status, error, findings, duration_ms
       FROM sweep_runs WHERE ${where} ORDER BY started_at DESC LIMIT ${limit}`,
    params,
  );
  return rows.map((r) => ({
    id: String(r['id']), tenant: String(r['tenant']), sweep: String(r['sweep']),
    botId: r['bot_id'] == null ? null : String(r['bot_id']),
    startedAt: String(r['started_at']), finishedAt: r['finished_at'] == null ? null : String(r['finished_at']),
    status: String(r['status']) as SweepRunStatus,
    error: r['error'] == null ? null : String(r['error']),
    findings: r['findings'] == null ? null : Number(r['findings']),
    durationMs: r['duration_ms'] == null ? null : Number(r['duration_ms']),
  }));
}
