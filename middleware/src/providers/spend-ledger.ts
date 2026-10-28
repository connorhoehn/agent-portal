// The spend ledger (DE-30): one append-only row per finished task attempt, on
// every path that spends model money — bot runs, queued work jobs, ad-hoc box
// tasks and platform-api's agent loop. schema/spend_ledger_schema.sql has the
// table; docs/deployment-enhancements/DE-30-spend-ledger.md the design.
//
// Writers are best-effort. A ledger that cannot be written must never fail
// the run that spent the money, so every write here logs and returns. The
// unique (source, source_id) key makes a retried write a no-op.
//
// The unit is a task attempt, never a box: bot runs execute on boxes too, so
// the ad-hoc box writer runs only on the two routes no bot or job owns.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { hasColumns } from './column-probe.js';
import { clock } from '../mock/core/index.js';
import { spendEntries } from '../mock/spend-ledger.js';
import type { CostBasis } from '../lib/run-cost.js';

export type SpendSource = 'bot_run' | 'job' | 'box_task' | 'agent_loop' | 'agent_project_run';
export type { CostBasis };

export interface SpendEntry {
  source: SpendSource;
  sourceId: string;
  initiativeId: string | null;
  grantId: string | null;
  boxId: string | null;
  actorId: string | null;
  trigger: string | null;
  model: string | null;
  /** Null = unknown, never coerced to 0. */
  costUsd: number | null;
  costBasis: CostBasis;
  /**
   * The price table's figure beside the recorded one (DE-32 drift check):
   * equal to `costUsd` when the basis is `estimated`, the table's number when
   * a reported figure won, null when the table could not price the run.
   */
  estimatedCostUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  occurredAt: string;
}

export type SpendInput = Omit<SpendEntry, 'costBasis' | 'occurredAt' | 'grantId' | 'trigger' | 'inputTokens' | 'outputTokens' | 'estimatedCostUsd'> & {
  costBasis?: CostBasis;
  estimatedCostUsd?: number | null;
  grantId?: string | null;
  trigger?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  occurredAt?: string;
};

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : { name, value: { isNull: true } };
}
function maybeNum(name: string, v: number | null | undefined): SqlParameter {
  return v != null && Number.isFinite(v) ? { name, value: { doubleValue: v } } : { name, value: { isNull: true } };
}

/** The basis a cost implies when the caller does not say: null is unknown. */
function basisFor(costUsd: number | null, given?: CostBasis): CostBasis {
  if (costUsd == null) return 'unknown';
  return given && given !== 'unknown' ? given : 'reported';
}

function missingTable(err: unknown): boolean {
  return /does not exist|relation/i.test((err as Error)?.message ?? '');
}

// An entry first written with an unknown cost may learn its figure later (a
// bot run settled before its job reported). Known costs never move: that is
// what makes a retried write a no-op rather than a second, different charge.
const UPSERT_TAIL = `
  ON CONFLICT (source, source_id) DO UPDATE
     SET cost_usd = EXCLUDED.cost_usd, cost_basis = EXCLUDED.cost_basis
   WHERE spend_entries.cost_basis = 'unknown' AND EXCLUDED.cost_basis <> 'unknown'`;
const UPSERT_TAIL_WITH_ESTIMATE = `
  ON CONFLICT (source, source_id) DO UPDATE
     SET cost_usd = EXCLUDED.cost_usd, cost_basis = EXCLUDED.cost_basis,
         estimated_cost_usd = EXCLUDED.estimated_cost_usd
   WHERE spend_entries.cost_basis = 'unknown' AND EXCLUDED.cost_basis <> 'unknown'`;

/**
 * Append one entry. Best-effort: logs and returns on failure.
 *
 * `unlessBotRunOwnsJob`: skip the write when a bot_run already carries this
 * job (a bot firing or a marketplace dispatch). That run's settle writes the
 * money; a second entry from the job would count the same dollar twice. The
 * mock has no job queue (enqueue answers 503 offline), so only Aurora checks.
 */
export async function recordSpend(input: SpendInput, opts: { unlessBotRunOwnsJob?: string } = {}): Promise<void> {
  const entry: SpendEntry = {
    ...input,
    grantId: input.grantId ?? null,
    trigger: input.trigger ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    costBasis: basisFor(input.costUsd, input.costBasis),
    estimatedCostUsd: input.estimatedCostUsd ?? null,
    occurredAt: input.occurredAt ?? clock.nowIso(),
  };
  if (config.mock.aurora) {
    // bot_run entries are derived from the bot_runs fixture, never stored.
    if (entry.source === 'bot_run') return;
    try {
      const rows = spendEntries.rows();
      const prior = rows.find((r) => r.source === entry.source && r.sourceId === entry.sourceId);
      if (!prior) rows.push(entry);
      else if (prior.costBasis === 'unknown' && entry.costBasis !== 'unknown') {
        prior.costUsd = entry.costUsd;
        prior.costBasis = entry.costBasis;
        prior.estimatedCostUsd = entry.estimatedCostUsd;
      }
    } catch (err) {
      console.warn(`[spend-ledger] mock write failed: ${(err as Error).message}`);
    }
    return;
  }
  try {
    // `estimated_cost_usd` is an additive column (DE-32); a cluster that has
    // not re-applied spend_ledger_schema.sql still takes the row without it.
    const withEstimate = await hasColumns('spend_entries', ['estimated_cost_usd']).catch(() => false);
    await exec(
      `INSERT INTO spend_entries
         (source, source_id, initiative_id, grant_id, box_id, actor_id, trigger, model,
          cost_usd, cost_basis, input_tokens, output_tokens, occurred_at${withEstimate ? ', estimated_cost_usd' : ''})
       SELECT :source, :sid, :init, :grant, :box, :actor, :trigger, :model,
              :cost::numeric, :basis, :itok::bigint, :otok::bigint, :at::timestamptz${withEstimate ? ', :est::numeric' : ''}
       ${opts.unlessBotRunOwnsJob ? 'WHERE NOT EXISTS (SELECT 1 FROM bot_runs WHERE job_id = :ownedjob)' : ''}${withEstimate ? UPSERT_TAIL_WITH_ESTIMATE : UPSERT_TAIL}`,
      [
        s('source', entry.source), s('sid', entry.sourceId), maybe('init', entry.initiativeId),
        maybe('grant', entry.grantId), maybe('box', entry.boxId), maybe('actor', entry.actorId),
        maybe('trigger', entry.trigger), maybe('model', entry.model), maybeNum('cost', entry.costUsd),
        s('basis', entry.costBasis), maybeNum('itok', entry.inputTokens), maybeNum('otok', entry.outputTokens),
        s('at', entry.occurredAt),
        ...(withEstimate ? [maybeNum('est', entry.estimatedCostUsd)] : []),
        ...(opts.unlessBotRunOwnsJob ? [s('ownedjob', opts.unlessBotRunOwnsJob)] : []),
      ],
    );
  } catch (err) {
    if (missingTable(err)) return;
    console.warn(`[spend-ledger] write failed for ${entry.source}:${entry.sourceId}: ${(err as Error).message}`);
  }
}

/**
 * The bot-run entry, resolved from the settled row in one statement.
 *
 * Attribution is resolved ONCE here, with spendPredicateSql's three arms in
 * order (work item, bot target, bot's codebase), so readers stop re-deriving
 * it per query. Where the legacy OR-predicate would let one run count under
 * two initiatives, the ledger picks the first arm; the dual-read in
 * providers/budgets.ts reports any initiative where that changes a total.
 * `occurred_at` is the run's start, the instant the legacy readers window on.
 * Skipped runs never ran and write nothing.
 */
export function botRunSpendSql(withDispatchedBy: boolean, where = 'br.id = :id::uuid', withEstimate = false): string {
  return `
    INSERT INTO spend_entries
      (source, source_id, initiative_id, actor_id, trigger, model, cost_usd, cost_basis, occurred_at${withEstimate ? ', estimated_cost_usd' : ''})
    SELECT 'bot_run', br.id::text,
           COALESCE(
             (SELECT w.project_id FROM work_items w WHERE w.id = br.work_item_id),
             b.org_project_id,
             (SELECT ap.org_project_id FROM agent_projects ap WHERE ap.id = b.agent_project_id)
           ),
           ${withDispatchedBy ? 'br.dispatched_by' : 'NULL'},
           br.trigger,
           COALESCE(apr.model, aj.payload->>'model', b.model),
           br.cost_usd,
           CASE WHEN br.cost_usd IS NULL THEN 'unknown'
                WHEN COALESCE(to_jsonb(apr)->>'cost_basis', aj.result->>'costBasis') = 'estimated' THEN 'estimated'
                ELSE 'reported' END,
           br.started_at
           ${withEstimate ? ", COALESCE((to_jsonb(apr)->>'estimated_cost_usd')::numeric, (aj.result->>'estimatedCostUsd')::numeric)" : ''}
      FROM bot_runs br
      LEFT JOIN bots b ON b.id = br.bot_id
      LEFT JOIN agent_project_runs apr ON apr.id = br.run_id
      LEFT JOIN agent_jobs aj ON aj.id = br.job_id
     WHERE ${where} AND br.status IN ('done', 'failed')${withEstimate ? UPSERT_TAIL_WITH_ESTIMATE : UPSERT_TAIL}`;
}

/** Write (or complete) the ledger entry for a settled bot run. Best-effort. */
export async function recordBotRunSpend(runId: string): Promise<void> {
  if (config.mock.aurora) return; // derived from the bot_runs fixture
  try {
    const withBy = await hasColumns('bot_runs', ['dispatched_by']);
    const withEstimate = await hasColumns('spend_entries', ['estimated_cost_usd']);
    await exec(botRunSpendSql(withBy, undefined, withEstimate), [s('id', runId)]);
  } catch (err) {
    if (missingTable(err)) return;
    console.warn(`[spend-ledger] bot run ${runId} not recorded: ${(err as Error).message}`);
  }
}

/**
 * The entry for a direct agent-project run (POST /api/agent-projects/:id/runs),
 * resolved from the finished row. Skipped when a bot_run owns the run (a bot
 * firing or a marketplace dispatch): that run's settle writes the money.
 * Initiative: the run's work item, else the codebase's initiative.
 */
export function agentProjectRunSpendSql(withDispatchedBy: boolean, withEstimate = false): string {
  return `
    INSERT INTO spend_entries
      (source, source_id, initiative_id, actor_id, model, cost_usd, cost_basis, occurred_at${withEstimate ? ', estimated_cost_usd' : ''})
    SELECT 'agent_project_run', apr.id::text,
           COALESCE(
             (SELECT w.project_id FROM work_items w WHERE w.id = apr.work_item_id),
             ap.org_project_id
           ),
           ${withDispatchedBy ? 'apr.dispatched_by' : 'NULL'},
           apr.model,
           apr.cost_usd,
           CASE WHEN apr.cost_usd IS NULL THEN 'unknown'
                WHEN to_jsonb(apr)->>'cost_basis' = 'estimated' THEN 'estimated'
                ELSE 'reported' END,
           apr.started_at
           ${withEstimate ? ", (to_jsonb(apr)->>'estimated_cost_usd')::numeric" : ''}
      FROM agent_project_runs apr
      JOIN agent_projects ap ON ap.id = apr.project_id
     WHERE apr.id = :id::uuid AND apr.status IN ('done', 'failed')
       AND NOT EXISTS (SELECT 1 FROM bot_runs br WHERE br.run_id = apr.id)${withEstimate ? UPSERT_TAIL_WITH_ESTIMATE : UPSERT_TAIL}`;
}

/** Write the ledger entry for a finished agent-project run. Best-effort. */
export async function recordAgentProjectRunSpend(runId: string): Promise<void> {
  // Offline these runs live in mock/agent-project-runs.ts and are not yet in
  // the mock ledger's view (a known gap; ledger mode is off by default).
  if (config.mock.aurora) return;
  try {
    const withBy = await hasColumns('agent_project_runs', ['dispatched_by']);
    const withEstimate = await hasColumns('spend_entries', ['estimated_cost_usd']);
    await exec(agentProjectRunSpendSql(withBy, withEstimate), [s('id', runId)]);
  } catch (err) {
    if (missingTable(err)) return;
    console.warn(`[spend-ledger] agent-project run ${runId} not recorded: ${(err as Error).message}`);
  }
}

/** The stored (non-derived) mock rows. Exported for providers/budgets.ts and tests. */
export function mockStoredEntries(): SpendEntry[] {
  return spendEntries.rows();
}

// ─── Read mode ───────────────────────────────────────────────────────────────
//
// The budget readers move onto the ledger in three steps, so a deploy can
// prove the ledger before trusting it (DE-30 "Migration"):
//   off    — readers sum bot_runs, as before (the default);
//   dual   — readers still answer from bot_runs, and also read the ledger and
//            log every initiative whose two totals differ;
//   ledger — readers answer from spend_entries.

export type SpendLedgerMode = 'off' | 'dual' | 'ledger';

export function spendLedgerMode(): SpendLedgerMode {
  const raw = (process.env['SPEND_LEDGER'] ?? '').trim().toLowerCase();
  if (raw === 'ledger') return 'ledger';
  if (raw === 'dual' || raw === 'read') return 'dual';
  return 'off';
}

/** Every pair of totals that disagrees by more than the column's scale. */
export function ledgerMismatches(
  legacy: ReadonlyArray<{ id: string; usd: number }>,
  ledger: ReadonlyArray<{ id: string; usd: number }>,
): Array<{ id: string; legacyUsd: number; ledgerUsd: number }> {
  const byId = new Map<string, { legacyUsd: number; ledgerUsd: number }>();
  for (const r of legacy) byId.set(r.id, { legacyUsd: r.usd, ledgerUsd: 0 });
  for (const r of ledger) {
    const prior = byId.get(r.id);
    if (prior) prior.ledgerUsd = r.usd;
    else byId.set(r.id, { legacyUsd: 0, ledgerUsd: r.usd });
  }
  return [...byId].filter(([, v]) => Math.abs(v.legacyUsd - v.ledgerUsd) >= 0.0001)
    .map(([id, v]) => ({ id, ...v }));
}

/** Stored mock entries that count as spend: costed, optionally narrowed. */
export function mockStoredSpend(filter: (e: SpendEntry) => boolean = () => true): SpendEntry[] {
  try {
    return spendEntries.rows().filter((e) => e.costUsd != null && filter(e));
  } catch {
    return [];
  }
}

/** Stored mock entries whose cost is unknown, optionally narrowed. */
export function mockUnknownSpend(filter: (e: SpendEntry) => boolean = () => true): SpendEntry[] {
  try {
    return spendEntries.rows().filter((e) => e.costUsd == null && filter(e));
  } catch {
    return [];
  }
}
