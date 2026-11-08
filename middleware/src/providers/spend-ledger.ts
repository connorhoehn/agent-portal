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
import { exec, withTransaction, type TxExec } from './aurora.js';
import { config } from '../config.js';
import { hasColumns } from './column-probe.js';
import { clock } from '../mock/core/index.js';
import { spendEntries } from '../mock/spend-ledger.js';
import type { CostBasis, ModelProvider } from '../lib/run-cost.js';
import { settleHold, SETTLE_HOLD_SQL } from './spend-holds.js';
import { emitSpendMetric } from '../lib/fleet-metrics.js';
import { estimateUsageCost } from '../lib/model-prices.js';
import { randomUUID } from 'node:crypto';

// 'agent_invoke' (work item 16): a chat invoke or a /summarize run, keyed by its run id (lib/agent-invoke-spend.ts).
// 'microvm': one microVM runner attempt, keyed `<job>:<attempt>` (lib/microvm-dispatcher.ts).
export type SpendSource = 'bot_run' | 'job' | 'box_task' | 'agent_loop' | 'agent_project_run' | 'bff_call' | 'agent_invoke' | 'microvm';
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
  /**
   * Who served the tokens (DE-33): `local` makes a route-decided $0
   * distinguishable from a Bedrock run that reported $0. Null when the
   * writer does not know; never defaulted, never backfilled.
   */
  provider?: ModelProvider | null;
  /**
   * The compute half of a microVM run (docs/microvm-runner-design.md §6):
   * seconds the session billed (stopped − booted), what that cost at
   * MICROVM_COMPUTE_USD_PER_SECOND, and the runtime session. Null elsewhere.
   */
  computeSeconds?: number | null;
  computeUsd?: number | null;
  sessionId?: string | null;
}

export type SpendInput = Omit<SpendEntry, 'costBasis' | 'occurredAt' | 'grantId' | 'trigger' | 'inputTokens' | 'outputTokens' | 'estimatedCostUsd' | 'provider' | 'computeSeconds' | 'computeUsd' | 'sessionId'> & {
  computeSeconds?: number | null;
  computeUsd?: number | null;
  sessionId?: string | null;
  provider?: ModelProvider | null;
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
    provider: input.provider ?? null,
    ...(input.computeSeconds != null || input.computeUsd != null || input.sessionId
      ? { computeSeconds: input.computeSeconds ?? null, computeUsd: input.computeUsd ?? null, sessionId: input.sessionId ?? null }
      : {}),
  };
  // DE-50: the spend-rate metric line, with InitiativeId/ActorId dimensions.
  emitSpendMetric(entry);
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
      const stored = prior ?? entry;
      // The hold for the same attempt settles with the entry (DE-34).
      await settleHold(entry.source, entry.sourceId, exec, stored.costUsd != null);
    } catch (err) {
      console.warn(`[spend-ledger] mock write failed: ${(err as Error).message}`);
    }
    return;
  }
  try {
    // `estimated_cost_usd` (DE-32) and `provider` (DE-33) are additive
    // columns; a cluster that has not re-applied them still takes the row.
    const withEstimate = await hasColumns('spend_entries', ['estimated_cost_usd']).catch(() => false);
    const withProvider = entry.provider != null && await hasColumns('spend_entries', ['provider']).catch(() => false);
    // The microVM runner's compute columns (schema/microvm_sessions.sql), only when given.
    const withCompute = (entry.computeSeconds != null || entry.computeUsd != null || !!entry.sessionId)
      && await hasColumns('spend_entries', ['compute_seconds', 'compute_usd', 'session_id']).catch(() => false);
    const insert = `INSERT INTO spend_entries
         (source, source_id, initiative_id, grant_id, box_id, actor_id, trigger, model,
          cost_usd, cost_basis, input_tokens, output_tokens, occurred_at${withEstimate ? ', estimated_cost_usd' : ''}${withProvider ? ', provider' : ''}${withCompute ? ', compute_seconds, compute_usd, session_id' : ''})
       SELECT :source, :sid, :init, :grant, :box, :actor, :trigger, :model,
              :cost::numeric, :basis, :itok::bigint, :otok::bigint, :at::timestamptz${withEstimate ? ', :est::numeric' : ''}${withProvider ? ', :provider' : ''}${withCompute ? ', :csec::int, :cusd::numeric, :csid' : ''}
       ${opts.unlessBotRunOwnsJob ? 'WHERE NOT EXISTS (SELECT 1 FROM bot_runs WHERE job_id = :ownedjob)' : ''}${withEstimate ? UPSERT_TAIL_WITH_ESTIMATE : UPSERT_TAIL}`;
    const params: SqlParameter[] = [
      s('source', entry.source), s('sid', entry.sourceId), maybe('init', entry.initiativeId),
      maybe('grant', entry.grantId), maybe('box', entry.boxId), maybe('actor', entry.actorId),
      maybe('trigger', entry.trigger), maybe('model', entry.model), maybeNum('cost', entry.costUsd),
      s('basis', entry.costBasis), maybeNum('itok', entry.inputTokens), maybeNum('otok', entry.outputTokens),
      s('at', entry.occurredAt),
      ...(withEstimate ? [maybeNum('est', entry.estimatedCostUsd)] : []),
      ...(withProvider ? [s('provider', entry.provider!)] : []),
      ...(withCompute ? [maybeNum('csec', entry.computeSeconds), maybeNum('cusd', entry.computeUsd), maybe('csid', entry.sessionId)] : []),
      ...(opts.unlessBotRunOwnsJob ? [s('ownedjob', opts.unlessBotRunOwnsJob)] : []),
    ];
    await writeAndSettle(entry.source, entry.sourceId, (run) => run(insert, params));
  } catch (err) {
    if (missingTable(err)) return;
    console.warn(`[spend-ledger] write failed for ${entry.source}:${entry.sourceId}: ${(err as Error).message}`);
  }
}

/** A Bedrock usage block as the SDKs report it (Converse or InvokeModel). */
export interface BffUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
}

/**
 * Meter one of the BFF's own Bedrock calls (reviewers, judges, embeddings,
 * titles, extractors). One row per call, source 'bff_call', a fresh uuid as
 * source_id. Cost comes from the price table; an unpriced model keeps its
 * token counts with a null cost ('unknown'), never 0. Best-effort: never
 * throws, so a ledger failure cannot fail the feature. A call with no usage
 * block records nothing.
 */
export async function recordBffCall(call: {
  feature: string;
  model: string;
  usage: BffUsage | null | undefined;
  actorId?: string | null;
  initiativeId?: string | null;
}): Promise<void> {
  try {
    const u = call.usage;
    if (!u) return;
    const inputTokens = Number.isFinite(u.inputTokens) ? Number(u.inputTokens) : 0;
    const outputTokens = Number.isFinite(u.outputTokens) ? Number(u.outputTokens) : 0;
    const costUsd = estimateUsageCost(call.model, {
      inputTokens,
      outputTokens,
      ...(u.cacheWriteInputTokens ? { cacheWriteTokens: u.cacheWriteInputTokens } : {}),
      ...(u.cacheReadInputTokens ? { cacheReadTokens: u.cacheReadInputTokens } : {}),
    });
    await recordSpend({
      source: 'bff_call',
      sourceId: randomUUID(),
      initiativeId: call.initiativeId ?? null,
      boxId: null,
      actorId: call.actorId ?? null,
      trigger: call.feature,
      model: call.model,
      costUsd,
      costBasis: costUsd == null ? 'unknown' : 'estimated',
      estimatedCostUsd: costUsd,
      inputTokens,
      outputTokens,
      provider: 'bedrock',
    });
  } catch (err) {
    console.warn(`[spend-ledger] bff_call ${call.feature} not recorded: ${(err as Error).message}`);
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
export function botRunSpendSql(withDispatchedBy: boolean, where = 'br.id = :id::uuid', withEstimate = false, withProvider = false): string {
  // box_id (DE-31): the box the run claimed, from the outcome the dispatch
  // wrote (governed runs: outcome.boxId) or the job it rode (agent_jobs.box_id),
  // so one box's spend sums across bot runs, jobs and ad-hoc tasks without a
  // second copy. provider (DE-33) is the run row's own, never inferred.
  return `
    INSERT INTO spend_entries
      (source, source_id, initiative_id, actor_id, trigger, model, cost_usd, cost_basis, occurred_at, box_id${withEstimate ? ', estimated_cost_usd' : ''}${withProvider ? ', provider' : ''})
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
           br.started_at,
           COALESCE(br.outcome->>'boxId', aj.box_id)
           ${withEstimate ? ", COALESCE((to_jsonb(apr)->>'estimated_cost_usd')::numeric, (aj.result->>'estimatedCostUsd')::numeric)" : ''}
           ${withProvider ? ', br.model_provider' : ''}
      FROM bot_runs br
      LEFT JOIN bots b ON b.id = br.bot_id
      LEFT JOIN agent_project_runs apr ON apr.id = br.run_id
      LEFT JOIN agent_jobs aj ON aj.id = br.job_id
     WHERE ${where} AND br.status IN ('done', 'failed')${withEstimate ? UPSERT_TAIL_WITH_ESTIMATE : UPSERT_TAIL}`;
}

/**
 * Run a ledger write and settle the spend hold for the same attempt in ONE
 * transaction (DE-34): held money becomes spent money in one commit, never
 * both, never neither. SETTLE_HOLD_SQL settles only when the entry's cost is
 * known; an unknown-cost entry leaves its hold to expire. A cluster without
 * spend_holds writes the entry alone, exactly as before.
 */
async function writeAndSettle(source: SpendSource, sourceId: string, write: (run: TxExec) => Promise<Record<string, any>[]>): Promise<Record<string, any>[]> {
  const withHolds = await hasColumns('spend_holds', ['source_id']).catch(() => false);
  if (!withHolds) return write(exec);
  return withTransaction(async (tx) => {
    const rows = await write(tx);
    await tx(SETTLE_HOLD_SQL, [s('source', source), s('sid', sourceId)]);
    return rows;
  });
}

/** The columns the SQL ledger writers hand back, for the spend-rate metric. */
const SPEND_RETURNING = ' RETURNING cost_usd, initiative_id, actor_id';

/**
 * The spend-rate line (DE-50) for a ledger row written through SQL, which
 * recordSpend never sees. RETURNING yields a row only when the statement
 * inserted or completed it, so a retried write that changed nothing emits
 * nothing. Best-effort: never throws.
 */
function emitSqlSpendMetric(source: SpendSource, rows: Record<string, any>[], provider?: string | null): void {
  try {
    const r = rows[0];
    if (!r) return;
    const cost = r['cost_usd'] == null ? null : Number(r['cost_usd']);
    emitSpendMetric({
      costUsd: cost != null && Number.isFinite(cost) ? cost : null,
      initiativeId: r['initiative_id'] == null ? null : String(r['initiative_id']),
      actorId: r['actor_id'] == null ? null : String(r['actor_id']),
      source,
      provider: provider ?? (r['provider'] == null ? null : String(r['provider'])),
    });
  } catch { /* a metric must never fail the ledger write */ }
}

/** Write (or complete) the ledger entry for a settled bot run. Best-effort. */
export async function recordBotRunSpend(runId: string): Promise<void> {
  if (config.mock.aurora) return; // derived from the bot_runs fixture
  try {
    const withBy = await hasColumns('bot_runs', ['dispatched_by']);
    const withEstimate = await hasColumns('spend_entries', ['estimated_cost_usd']);
    const withProvider = await hasColumns('spend_entries', ['provider']) && await hasColumns('bot_runs', ['model_provider']);
    const rows = await writeAndSettle('bot_run', runId, (run) => run(botRunSpendSql(withBy, undefined, withEstimate, withProvider) + SPEND_RETURNING + (withProvider ? ', provider' : ''), [s('id', runId)]));
    emitSqlSpendMetric('bot_run', rows);
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
    const rows = await writeAndSettle('agent_project_run', runId, (run) => run(agentProjectRunSpendSql(withBy, withEstimate) + SPEND_RETURNING, [s('id', runId)]));
    emitSqlSpendMetric('agent_project_run', rows);
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

// ─── Box and actor rollups (DE-31) ───────────────────────────────────────────

export interface BoxSpend {
  /** Sum of the box's entries with a known cost. */
  knownUsd: number;
  /** Entries on the box whose cost is unknown — in neither sum, never zero. */
  unknownCount: number;
  /** Known dollars per source, so a box's spend reads as bot runs + jobs + tasks. */
  bySource: Partial<Record<SpendSource, number>>;
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function rollup(entries: ReadonlyArray<Pick<SpendEntry, 'source' | 'costUsd'>>): BoxSpend {
  const out: BoxSpend = { knownUsd: 0, unknownCount: 0, bySource: {} };
  for (const e of entries) {
    if (e.costUsd == null) { out.unknownCount++; continue; }
    out.knownUsd += e.costUsd;
    out.bySource[e.source] = round4((out.bySource[e.source] ?? 0) + e.costUsd);
  }
  out.knownUsd = round4(out.knownUsd);
  return out;
}

/**
 * Offline, a bot_run entry is derived from the bot_runs fixture (never
 * stored), booked to the box its outcome names. Same shape the Aurora
 * writer resolves with `COALESCE(br.outcome->>'boxId', aj.box_id)`.
 */
async function mockBotRunEntriesOnBoxes(boxIds: ReadonlySet<string>): Promise<Array<Pick<SpendEntry, 'source' | 'costUsd' | 'boxId'>>> {
  const { allMockRuns } = await import('../mock/bots.js');
  return allMockRuns()
    .filter((r) => (r.status === 'done' || r.status === 'failed')
      && typeof r.outcome?.['boxId'] === 'string' && boxIds.has(String(r.outcome['boxId'])))
    .map((r) => ({ source: 'bot_run' as const, costUsd: r.costUsd ?? null, boxId: String(r.outcome!['boxId']) }));
}

/**
 * Each box's spend from the ledger, in one read for the whole list (DE-31):
 * `spend_entries WHERE box_id IN (…)` across all three sources, so a bot run
 * that teed into a box is counted once, as its bot_run entry, never again as
 * box spend. A missing table answers an empty map (the caller keeps the
 * in-memory figure).
 */
export async function getBoxSpend(boxIds: readonly string[]): Promise<Map<string, BoxSpend>> {
  const out = new Map<string, BoxSpend>();
  if (boxIds.length === 0) return out;
  if (config.mock.aurora) {
    const want = new Set(boxIds);
    let stored: SpendEntry[] = [];
    try { stored = spendEntries.rows().filter((e) => e.boxId != null && want.has(e.boxId)); } catch { stored = []; }
    const all = [...stored, ...await mockBotRunEntriesOnBoxes(want)];
    for (const id of boxIds) out.set(id, rollup(all.filter((e) => e.boxId === id)));
    return out;
  }
  const params = boxIds.map((id, i) => s(`b${i}`, id));
  try {
    const rows = await exec(
      `SELECT box_id, source,
              COALESCE(SUM(cost_usd), 0)::float8 AS known,
              COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unknown
         FROM spend_entries
        WHERE box_id IN (${params.map((p) => `:${p.name}`).join(', ')})
        GROUP BY box_id, source`,
      params,
    );
    for (const id of boxIds) out.set(id, { knownUsd: 0, unknownCount: 0, bySource: {} });
    for (const r of rows) {
      const b = out.get(String(r['box_id']));
      if (!b) continue;
      const known = Number(r['known'] ?? 0);
      b.knownUsd = round4(b.knownUsd + known);
      b.unknownCount += Number(r['unknown'] ?? 0);
      if (known) b.bySource[String(r['source']) as SpendSource] = round4(known);
    }
  } catch (err) {
    if (missingTable(err)) return new Map();
    throw err;
  }
  return out;
}

export interface ActorSpendRow {
  initiativeId: string | null;
  knownUsd: number;
  unknownCount: number;
  entries: number;
  bySource: Partial<Record<SpendSource, number>>;
}

/** `?period=` for the per-person rollup: this calendar month (the budget window), or a trailing window. */
export type SpendPeriod = 'month' | '7d' | '30d';

export function periodStartIso(period: SpendPeriod, now: Date = clock.now()): string {
  if (period === '7d') return new Date(now.getTime() - 7 * 86_400_000).toISOString();
  if (period === '30d') return new Date(now.getTime() - 30 * 86_400_000).toISOString();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/**
 * What one person spent, per initiative, over the period (DE-31): every
 * entry whose `actor_id` is them — the sender of a task on a shared box, the
 * dispatcher of a run, the creator of a job — never the box owner by
 * inference. `initiativeId: null` is their unattributed spend.
 */
export async function getActorSpend(actorId: string, period: SpendPeriod): Promise<ActorSpendRow[]> {
  const since = periodStartIso(period);
  const group = (entries: ReadonlyArray<Pick<SpendEntry, 'initiativeId' | 'source' | 'costUsd'>>): ActorSpendRow[] => {
    const by = new Map<string | null, Array<Pick<SpendEntry, 'initiativeId' | 'source' | 'costUsd'>>>();
    for (const e of entries) by.set(e.initiativeId, [...(by.get(e.initiativeId) ?? []), e]);
    return [...by].map(([initiativeId, es]) => {
      const r = rollup(es);
      return { initiativeId, knownUsd: r.knownUsd, unknownCount: r.unknownCount, entries: es.length, bySource: r.bySource };
    }).sort((a, b) => b.knownUsd - a.knownUsd || String(a.initiativeId).localeCompare(String(b.initiativeId)));
  };
  if (config.mock.aurora) {
    const from = Date.parse(since);
    let stored: SpendEntry[] = [];
    try { stored = spendEntries.rows().filter((e) => e.actorId === actorId && Date.parse(e.occurredAt) >= from); } catch { stored = []; }
    // bot_run entries offline are derived from the fixture, attributed by the
    // same arms the Aurora writer resolves (work item, then bot target).
    const { allMockRuns } = await import('../mock/bots.js');
    const { mockBotRunInitiative } = await import('./bots.js');
    const derived = allMockRuns()
      .filter((r) => r.dispatchedBy === actorId && (r.status === 'done' || r.status === 'failed') && Date.parse(r.startedAt) >= from)
      .map((r) => ({ source: 'bot_run' as const, costUsd: r.costUsd ?? null, initiativeId: mockBotRunInitiative(r) }));
    return group([...stored, ...derived]);
  }
  try {
    const rows = await exec(
      `SELECT initiative_id, source,
              COALESCE(SUM(cost_usd), 0)::float8 AS known,
              COUNT(*) FILTER (WHERE cost_usd IS NULL)::int AS unknown,
              COUNT(*)::int AS n
         FROM spend_entries
        WHERE actor_id = :actor AND occurred_at >= :since::timestamptz
        GROUP BY initiative_id, source`,
      [s('actor', actorId), s('since', since)],
    );
    const by = new Map<string | null, ActorSpendRow>();
    for (const r of rows) {
      const pid = r['initiative_id'] == null ? null : String(r['initiative_id']);
      const row = by.get(pid) ?? { initiativeId: pid, knownUsd: 0, unknownCount: 0, entries: 0, bySource: {} };
      const known = Number(r['known'] ?? 0);
      row.knownUsd = round4(row.knownUsd + known);
      row.unknownCount += Number(r['unknown'] ?? 0);
      row.entries += Number(r['n'] ?? 0);
      if (known) row.bySource[String(r['source']) as SpendSource] = round4(known);
      by.set(pid, row);
    }
    return [...by.values()].sort((a, b) => b.knownUsd - a.knownUsd || String(a.initiativeId).localeCompare(String(b.initiativeId)));
  } catch (err) {
    if (missingTable(err)) return [];
    throw err;
  }
}

/** Offline the fixtures ARE the ledger, so readers that switch on SPEND_LEDGER read it regardless. */
export function ledgerIsFixture(): boolean {
  return config.mock.aurora === true;
}
