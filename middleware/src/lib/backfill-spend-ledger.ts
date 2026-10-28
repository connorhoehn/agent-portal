// Backfill the spend ledger (DE-30) from what was recorded before it existed.
//
//     npx tsx src/lib/backfill-spend-ledger.ts [--dry-run]
//
// Order on a cluster: apply schema/spend_ledger_schema.sql, run this with
// --dry-run, run it, deploy with SPEND_LEDGER=dual and read the drift log,
// then SPEND_LEDGER=ledger. Idempotent: the (source, source_id) key makes a
// rerun write nothing new.
//
// Two sources are recoverable: settled bot_runs, and finished agent_jobs that
// no bot run owns (their result carries costUsd). Ad-hoc box tasks before the
// cutover cannot be split per task (the box kept one lifetime total), so they
// stay out — a known gap, not a zero. All history is backfilled; readers
// window by period themselves.

import { exec } from '../providers/aurora.js';
import { hasColumns } from '../providers/column-probe.js';
import { botRunSpendSql } from '../providers/spend-ledger.js';

/** Finished jobs no bot run owns, as ledger rows. Mirrors job-dispatcher's writer. */
export function jobBackfillSql(withEstimate = false): string { return `
  INSERT INTO spend_entries
    (source, source_id, initiative_id, box_id, actor_id, model, cost_usd, cost_basis, occurred_at${withEstimate ? ', estimated_cost_usd' : ''})
  SELECT 'job', aj.id || ':' || aj.attempts,
         (SELECT p.id FROM projects p WHERE p.id = aj.payload->>'initiativeId'),
         aj.box_id, aj.created_by, aj.payload->>'model',
         (aj.result->>'costUsd')::numeric,
         CASE WHEN aj.result->>'costUsd' IS NULL THEN 'unknown'
              WHEN aj.result->>'costBasis' = 'estimated' THEN 'estimated'
              ELSE 'reported' END,
         COALESCE(aj.finished_at, aj.created_at)
         ${withEstimate ? ", (aj.result->>'estimatedCostUsd')::numeric" : ''}
    FROM agent_jobs aj
   WHERE aj.status IN ('awaiting_review', 'done', 'failed')
     AND aj.started_at IS NOT NULL
     AND aj.bot_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM bot_runs br WHERE br.job_id = aj.id)
  ON CONFLICT (source, source_id) DO NOTHING`; }

export const JOB_BACKFILL_SQL = jobBackfillSql();

const BOT_RUN_WHERE = 'TRUE';

/** What a run would add: rows not yet in the ledger, per source. */
export const DRY_RUN_SQL = `
  SELECT 'bot_run' AS source, COUNT(*)::int AS rows, COALESCE(SUM(br.cost_usd), 0)::float8 AS usd
    FROM bot_runs br
   WHERE br.status IN ('done', 'failed')
     AND NOT EXISTS (SELECT 1 FROM spend_entries se WHERE se.source = 'bot_run' AND se.source_id = br.id::text)
  UNION ALL
  SELECT 'job', COUNT(*)::int, COALESCE(SUM((aj.result->>'costUsd')::numeric), 0)::float8
    FROM agent_jobs aj
   WHERE aj.status IN ('awaiting_review', 'done', 'failed')
     AND aj.started_at IS NOT NULL
     AND aj.bot_id IS NULL
     AND NOT EXISTS (SELECT 1 FROM bot_runs br WHERE br.job_id = aj.id)
     AND NOT EXISTS (SELECT 1 FROM spend_entries se WHERE se.source = 'job' AND se.source_id = aj.id || ':' || aj.attempts)`;

export interface BackfillReport { dryRun: boolean; pending: Array<{ source: string; rows: number; usd: number }> }

export async function backfillSpendLedger(opts: { dryRun: boolean }): Promise<BackfillReport> {
  const pending = (await exec(DRY_RUN_SQL)).map((r) => ({
    source: String(r['source']), rows: Number(r['rows'] ?? 0), usd: Number(r['usd'] ?? 0),
  }));
  if (!opts.dryRun) {
    const withBy = await hasColumns('bot_runs', ['dispatched_by']);
    const withEstimate = await hasColumns('spend_entries', ['estimated_cost_usd']);
    await exec(botRunSpendSql(withBy, BOT_RUN_WHERE, withEstimate));
    await exec(jobBackfillSql(withEstimate));
  }
  return { dryRun: opts.dryRun, pending };
}

async function main(argv: string[]): Promise<void> {
  const report = await backfillSpendLedger({ dryRun: argv.includes('--dry-run') });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && /backfill-spend-ledger\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => { console.error((err as Error).message); process.exitCode = 1; });
}
