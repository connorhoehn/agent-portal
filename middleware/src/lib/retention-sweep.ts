// Retention sweep — terminal rows do not accumulate forever.
//
// The agentic tables grow one row per firing, per job, per finding, and
// nothing ever deleted them: a lab that runs bots on a cron writes rows
// around the clock and the roster queries slow down for history nobody will
// read. This sweep deletes terminal rows past the retention window, on the
// poller pattern the reaper and the PR-watch poller proved out: an unref'd
// interval, a kill switch, and logging only when something was deleted.
//
// What is deliberately KEPT:
//   - anything non-terminal — running/queued/open rows are live state, not
//     history, however old they are;
//   - agent_project_runs referenced by an agent_change_requests row — a run
//     backing a change request is the audit trail behind a review decision,
//     and deleting it would orphan the trail (NOT EXISTS, not a join, so the
//     predicate reads as the rule it is);
//   - rows with no finished_at — terminal-without-a-timestamp is a bug worth
//     seeing, not silently reaping.
//
// Each table is deleted in bounded passes (id IN (SELECT ... LIMIT N)) so the
// first sweep over a year of backlog cannot hold locks for one giant DELETE;
// the next sweep takes the next slice.
//
// RETENTION_SWEEP_DISABLED=1 is the kill switch; RETENTION_DAYS (default 30)
// sets the window; RETENTION_SWEEP_INTERVAL_H (default 6) the cadence.

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function toNum(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }

const HOUR_MS = 3_600_000;
const COLD_START_DELAY_MS = 60_000;

/** Rows deleted per pass, per table — the lock-time bound. */
export const BATCH_LIMIT = 500;
/** Passes per table per sweep — bounds one sweep over a deep backlog. */
export const MAX_PASSES = 20;

export function retentionDays(): number {
  const n = toNum(process.env['RETENTION_DAYS']);
  return n > 0 ? n : 30;
}

/** The cutoff instant: rows terminal before this are eligible. */
export function cutoffIso(days: number, now = Date.now()): string {
  return new Date(now - days * 24 * HOUR_MS).toISOString();
}

// ─── The rules, pure ─────────────────────────────────────────────────────────

export interface RetentionRule {
  table: string;
  /** SQL predicate selecting expired rows; :cutoff is the retention boundary. */
  predicate: string;
}

// bot_runs carry the same audit guard as agent_project_runs: a bot_run whose
// run_id backs a change request is half of the trail from a review decision
// back to the firing that caused it — deleting it would orphan that trail.
// (run_id NULL rows pass the NOT EXISTS trivially and expire normally.)
// agent_jobs are safe to drop even when a bot_run still points at one —
// bot_runs.job_id is ON DELETE SET NULL, and the reconciler has long since
// copied the terminal status across.
export const RETENTION_RULES: readonly RetentionRule[] = [
  {
    table: 'agent_jobs',
    predicate: `status IN ('done','failed','cancelled') AND finished_at IS NOT NULL AND finished_at < :cutoff::timestamptz`,
  },
  {
    table: 'bot_runs',
    predicate: `status IN ('done','failed','skipped') AND finished_at IS NOT NULL AND finished_at < :cutoff::timestamptz
        AND NOT EXISTS (SELECT 1 FROM agent_change_requests c WHERE c.run_id = bot_runs.run_id)`,
  },
  {
    table: 'agent_project_runs',
    predicate: `status IN ('done','failed') AND finished_at IS NOT NULL AND finished_at < :cutoff::timestamptz
        AND NOT EXISTS (SELECT 1 FROM agent_change_requests c WHERE c.run_id = agent_project_runs.id)`,
  },
  {
    table: 'agent_findings',
    predicate: `status IN ('resolved','dismissed') AND last_seen_at < :cutoff::timestamptz`,
  },
];

/** One bounded delete pass. RETURNING id so the caller counts what happened. */
export function deleteBatchSql(rule: RetentionRule, limit = BATCH_LIMIT): string {
  return `DELETE FROM ${rule.table}
     WHERE id IN (
       SELECT id FROM ${rule.table}
        WHERE ${rule.predicate}
        LIMIT ${limit}
     )
     RETURNING id`;
}

// ─── One sweep ────────────────────────────────────────────────────────────────

async function sweepTable(rule: RetentionRule, cutoff: string): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const rows = await exec(deleteBatchSql(rule), [s('cutoff', cutoff)]);
    total += rows.length;
    // A short pass means the backlog under the cutoff is drained.
    if (rows.length < BATCH_LIMIT) break;
  }
  return total;
}

/**
 * Run one sweep across every retention rule. A table that fails (e.g. its
 * schema is not applied yet) logs and does not stop the others.
 */
export async function sweepOnce(now = Date.now()): Promise<Record<string, number>> {
  if (config.mock.aurora) return {};
  const days = retentionDays();
  const cutoff = cutoffIso(days, now);

  const counts: Record<string, number> = {};
  for (const rule of RETENTION_RULES) {
    try {
      counts[rule.table] = await sweepTable(rule, cutoff);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      // Pre-schema clusters simply have nothing to retain yet.
      if (!/does not exist|relation/i.test(msg)) {
        console.warn(`[retention] sweep of ${rule.table} failed:`, msg);
      }
      counts[rule.table] = 0;
    }
  }

  const deleted = Object.entries(counts).filter(([, n]) => n > 0);
  if (deleted.length > 0) {
    console.log(
      `[retention] deleted ${deleted.map(([t, n]) => `${t}: ${n}`).join(', ')} (terminal, older than ${days}d)`,
    );
  }
  return counts;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

let _timer: NodeJS.Timeout | null = null;

/**
 * Start the background retention sweep. Idempotent — calling twice is a no-op.
 * Honours RETENTION_SWEEP_DISABLED=1 and stands down in mock mode.
 */
export function startRetentionSweep(): void {
  if (_timer) return;
  if (process.env['RETENTION_SWEEP_DISABLED'] === '1') {
    console.log('[retention] RETENTION_SWEEP_DISABLED=1 — skipping start');
    return;
  }
  if (config.mock.aurora) {
    console.log('[retention] skipped (mock aurora)');
    return;
  }

  const hoursRaw = toNum(process.env['RETENTION_SWEEP_INTERVAL_H']);
  const intervalMs = (hoursRaw > 0 ? hoursRaw : 6) * HOUR_MS;
  console.log(`[retention] starting sweep, every ${intervalMs / HOUR_MS}h, window ${retentionDays()}d`);

  // Cold-start sweep after a minute — cleanup is nowhere near boot's critical
  // path, and the delay lets schema loading settle first.
  setTimeout(() => {
    void sweepOnce().catch((err) => console.warn('[retention] sweep failed:', (err as Error).message));
  }, COLD_START_DELAY_MS).unref();

  _timer = setInterval(() => {
    void sweepOnce().catch((err) => console.warn('[retention] sweep failed:', (err as Error).message));
  }, intervalMs);
  _timer.unref();
}

/** Stop the background sweep. Safe to call when not running. */
export function stopRetentionSweep(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
