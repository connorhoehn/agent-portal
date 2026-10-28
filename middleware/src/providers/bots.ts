// Bots — durable, mission-configured agents, and the record of every firing.
//
// A bot is the front half of the agentic loop: what to work on, when, under
// which guardrails. The back half is untouched — a repo-target bot dispatches
// through dispatchGovernedRun and an initiative-target bot enqueues a queue
// job, so nothing a bot starts is less governed than a hand-driven run.
//
// This module is persistence only. The guard ordering (disabled → run cap →
// budget) lives in lib/bot-runner.ts, the cron registry in lib/bot-scheduler.ts.
// Schema: schema/agent_bots_schema.sql.

import { randomUUID } from 'node:crypto';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { noteSearchWrite } from '../lib/search-index/writes.js';
import { hasColumns } from './column-probe.js';
// The vocabulary for "who served this inference". Imported rather than
// re-declared: bot_runs.model_provider and agent_project_runs.model_provider
// must mean the same three things, and a second copy of the union is how two
// tables come to disagree about what 'local' costs.
import type { ModelProvider } from '../lib/run-cost.js';
// The attribution model of record for "which initiative did this run spend
// against" (imported, never re-derived — two copies of that predicate is how
// two surfaces come to disagree about the same dollar).
import { spendPredicateSql } from './budgets.js';
// Mock-mode only, and read-only: listMarketplaceRuns keys a bot-less run to an
// initiative THROUGH its work item, exactly as the Aurora statement's subquery
// does. work-items.ts does not import this module, so this is a one-way edge.
import { getWorkItem, mockWorkItemProjectId } from './work-items.js';
// Mock-mode only, and read-only: the initiative join createBot's Aurora
// read-back gets for free. One initiative table, so a bot created offline names
// its initiative the same way every other mock surface does.
import { mockProjectName } from './projects.js';
// The one clock. Every fixture timestamp and every mock-branch stamp below is
// read through it, so freezeClock works and a run stamped "earlier today"
// cannot land in yesterday when the process boots near UTC midnight.
import { clock, DAY_MS, HOUR_MS } from '../mock/core/index.js';
import type { RunPercentiles } from '../lib/bot-estimate.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
// One vocabulary for "this answer is not a reading of the world", shared with
// providers/agentcore.ts and with the `degraded` marker routes/cost.ts put on
// the wire. See lib/upstream.ts for why an envelope and not a throw.
import { reached, unreachable, type Upstream } from '../lib/upstream.js';
import { recordBotRunSpend, spendLedgerMode, mockStoredSpend } from './spend-ledger.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : nul(name);
}
function num(name: string, v: number | null | undefined): SqlParameter {
  return v == null ? nul(name) : { name, value: { doubleValue: v } };
}
function int(name: string, v: number): SqlParameter { return { name, value: { longValue: v } }; }
function bool(name: string, v: boolean): SqlParameter { return { name, value: { booleanValue: v } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toBool(v: unknown): boolean { return v === true || v === 'true' || v === 1; }
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

function parseJson<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback;
  if (typeof v !== 'string') return v as T;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

export type BotTemplate = 'epic' | 'story' | 'bug';
export type BotTrigger = 'manual' | 'cron' | 'pr_watch';

export interface Bot {
  id: string;
  name: string;
  template: BotTemplate;
  /** The written mission (prompt_template), rendered per run. */
  prompt: string;
  agentProjectId: string | null;
  /** Joined repo_full_name of the target codebase — null for initiative bots. */
  agentProjectRepo: string | null;
  orgProjectId: string | null;
  orgProjectName: string | null;
  model: string;
  trigger: BotTrigger;
  cronExpr: string | null;
  enabled: boolean;
  budgetPerRunUsd: number | null;
  budgetPerDayUsd: number | null;
  maxRunsPerDay: number;
  requiresReview: boolean;
  /** Opt-in initiative-allocation brake, OFF by default. When true, a CRON
   *  firing whose p75 projection would push the initiative past its remaining
   *  monthly allocation is skipped (decideBotFireAllocation). False preserves
   *  the documented design where a bot's spend is the maintenance floor. */
  enforceAllocation: boolean;
  createdBy: string | null;
  createdAt: string;
  lastRunAt: string | null;
  pausedReason: string | null;
  /** Today's summed bot_runs cost — what the daily budget brake compares against. */
  todaySpendUsd: number;
  todayRunCount: number;
}

export interface BotRun {
  id: string;
  /** Null for marketplace runs — a firing with no bot behind it. */
  botId: string | null;
  trigger: string;
  runId: string | null;
  jobId: string | null;
  workItemId: string | null;
  status: 'running' | 'done' | 'failed' | 'skipped';
  costUsd: number | null;
  /**
   * What served the inference: `bedrock`, `local`, `simulated`.
   *
   * Null on every run that predates schema/local_compute_worker_schema.sql, and
   * deliberately NOT backfilled — see the column comment there. Read it as "not
   * recorded", never as "bedrock": a `costUsd` of 0 means something entirely
   * different depending on which of those two it is.
   */
  modelProvider: ModelProvider | null;
  startedAt: string;
  finishedAt: string | null;
  outcome: Record<string, unknown>;
  /** The session subject that authorized this run, when one did and the
   *  attribution column exists. Null for cron firings and for every run that
   *  predates schema/agent_run_attribution_schema.sql. */
  dispatchedBy: string | null;
}

function rowToBot(r: Record<string, unknown>): Bot {
  return {
    id: toStr(r['id']),
    name: toStr(r['name']),
    template: toStr(r['template'], 'story') as BotTemplate,
    prompt: toStr(r['prompt_template']),
    agentProjectId: r['agent_project_id'] ? toStr(r['agent_project_id']) : null,
    agentProjectRepo: r['agent_project_repo'] ? toStr(r['agent_project_repo']) : null,
    orgProjectId: r['org_project_id'] ? toStr(r['org_project_id']) : null,
    orgProjectName: r['org_project_name'] ? toStr(r['org_project_name']) : null,
    model: toStr(r['model']),
    trigger: toStr(r['trigger'], 'manual') as BotTrigger,
    cronExpr: r['cron_expr'] ? toStr(r['cron_expr']) : null,
    enabled: toBool(r['enabled']),
    budgetPerRunUsd: r['budget_per_run_usd'] == null ? null : toNum(r['budget_per_run_usd']),
    budgetPerDayUsd: r['budget_per_day_usd'] == null ? null : toNum(r['budget_per_day_usd']),
    // Null-coalesce, not || — 0 is a real value meaning "never fires"; the
    // default of 4 applies only when the column itself is NULL.
    maxRunsPerDay: r['max_runs_per_day'] == null ? 4 : toNum(r['max_runs_per_day']),
    requiresReview: toBool(r['requires_review']),
    // Absent on a pre-migration cluster (SELECT * has no such key) → false, the
    // column's own default, so the brake stays off until it is really set.
    enforceAllocation: toBool(r['enforce_allocation']),
    createdBy: r['created_by'] ? toStr(r['created_by']) : null,
    createdAt: toStr(r['created_at']),
    lastRunAt: r['last_run_at'] ? toStr(r['last_run_at']) : null,
    pausedReason: r['paused_reason'] ? toStr(r['paused_reason']) : null,
    todaySpendUsd: toNum(r['today_spend_usd']),
    todayRunCount: toNum(r['today_run_count']),
  };
}

function rowToRun(r: Record<string, unknown>): BotRun {
  return {
    id: toStr(r['id']),
    botId: r['bot_id'] ? toStr(r['bot_id']) : null,
    trigger: toStr(r['trigger']),
    runId: r['run_id'] ? toStr(r['run_id']) : null,
    jobId: r['job_id'] ? toStr(r['job_id']) : null,
    workItemId: r['work_item_id'] ? toStr(r['work_item_id']) : null,
    status: toStr(r['status'], 'running') as BotRun['status'],
    costUsd: r['cost_usd'] == null ? null : toNum(r['cost_usd']),
    // Absent on a pre-migration cluster, exactly like dispatched_by below.
    modelProvider: r['model_provider'] ? toStr(r['model_provider']) as ModelProvider : null,
    startedAt: toStr(r['started_at']),
    finishedAt: r['finished_at'] ? toStr(r['finished_at']) : null,
    outcome: parseJson<Record<string, unknown>>(r['outcome'], {}),
    // Absent on a pre-migration cluster: `SELECT *` simply has no such key.
    dispatchedBy: r['dispatched_by'] ? toStr(r['dispatched_by']) : null,
  };
}

// The lateral computes today's spend and firing count per bot in the same
// statement — every read of a bot carries the numbers its budget brakes are
// judged against, so the roster and the guard can never disagree.
const BOT_SELECT = `
  SELECT b.*, ap.repo_full_name AS agent_project_repo, p.name AS org_project_name,
         t.today_spend_usd, t.today_run_count
    FROM bots b
    LEFT JOIN agent_projects ap ON ap.id = b.agent_project_id
    LEFT JOIN projects p ON p.id = b.org_project_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(r.cost_usd), 0)::float8 AS today_spend_usd,
             COUNT(*) FILTER (WHERE r.status <> 'skipped')::int AS today_run_count
        FROM bot_runs r
       WHERE r.bot_id = b.id AND r.started_at >= date_trunc('day', NOW())
    ) t ON TRUE`;

/**
 * A read that survives a cluster which predates `agent_bots_schema.sql`.
 *
 * WHAT IT IS AND IS NOT. Read the filter before judging it: this swallows ONE
 * class of error — the relation not existing — and rethrows everything else.
 * A timeout, a permission failure, a syntax error and a dead cluster all still
 * propagate. That narrowness is why the helper is worth keeping; the name
 * `safeExec` oversells it, and the contract below is the real one.
 *
 * WHAT WAS STILL WRONG. Even the one swallowed class produced two answers
 * spelled the same way. `[]` from here meant "no bots are configured" and
 * "this cluster has no bots table", and the roster rendered both as an empty
 * page with an invitation to create a bot — on a cluster where creating one
 * will fail. So the honest primitive is `safeExecResult`, which says which
 * happened; `safeExec` is the lossy view, kept for the callers that have
 * nowhere to put the marker.
 *
 * WHERE IT MUST NOT BE USED. Anywhere the rows become a NUMBER a decision is
 * made against. `countRunningRuns` used this and turned a missing table into
 * "0 runs in flight", which is the value the global concurrency ceiling is
 * judged against — a brake reading its own blindness as headroom. It uses
 * `exec` now and fails loudly; see that function.
 */
async function safeExecResult(
  sql: string,
  params: SqlParameter[] = [],
): Promise<Upstream<Record<string, unknown>[]>> {
  try {
    return reached(await exec(sql, params));
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/does not exist|relation/i.test(msg)) {
      return unreachable([] as Record<string, unknown>[], err, 'bots schema not applied');
    }
    throw err;
  }
}

/** The lossy view of `safeExecResult` — an empty result that cannot say
 *  whether the table was empty or absent. Only for reads whose caller has no
 *  response field to carry the marker. */
async function safeExec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  return (await safeExecResult(sql, params)).items;
}

// ─── Dispatch attribution (bot_runs.dispatched_by) ────────────────────────────
//
// Who authorized a run. Added by schema/agent_run_attribution_schema.sql and
// deliberately additive: every read and write below works on a cluster that has
// not had that migration applied yet, because the middleware ships ahead of the
// schema and a missing column must degrade to "unknown", never to a 500 and
// never to a fabricated zero that a budget brake would treat as headroom.

let _attribution: boolean | null = null;

/**
 * Does bot_runs carry dispatched_by here? Probed once per process against
 * information_schema rather than inferred from a failed INSERT — a failed
 * insert is an ambiguous signal (constraint? column? connection?) and retrying
 * writes on it is how a run gets recorded twice.
 */
export async function attributionAvailable(): Promise<boolean> {
  // Mock mode stands in for a cluster that HAS had the migration applied — the
  // migration is checked in, and createBotRun below records dispatchedBy on
  // every row it writes offline. This used to answer false, which made the
  // envelope brake's burn permanently "unknown" in dev:mock: an SME could
  // dispatch against a $15 envelope all day and hear the identical verdict at
  // every level of spend, because the only number the brake had was the
  // envelope's own size.
  if (config.mock.aurora) return true;
  if (_attribution !== null) return _attribution;
  try {
    const rows = await exec(
      `SELECT 1 AS ok FROM information_schema.columns
        WHERE table_name = 'bot_runs' AND column_name = 'dispatched_by' LIMIT 1`,
    );
    _attribution = rows.length > 0;
  } catch {
    _attribution = false;
  }
  return _attribution;
}

/** Test seam: forget the probe so the next call re-asks. */
export function resetAttributionProbe(): void { _attribution = null; }

export interface DispatchedSpend {
  /** Cost of runs this subject is RECORDED as having dispatched. 0 when the
   *  column is absent — read it together with attributionAvailable, never
   *  alone. */
  spentUsd: number;
  /** false → the burn is UNKNOWN, not zero. */
  attributionAvailable: boolean;
}

/**
 * What one person has spent inside a sprint envelope: the runs THEY dispatched
 * (bot_runs.dispatched_by), attributed to this initiative by the same predicate
 * the Budgets ledger uses, inside the sprint's dates.
 *
 * This is narrower than GrantRow.initiativeSpendInWindowUsd on purpose. That
 * figure is the INITIATIVE's spend in the window and is explicitly not called
 * anyone's burn; this one names a person, so it may only count runs that
 * actually carry that person's subject. Runs from before the column existed,
 * cron firings, and other people's dispatches count against nobody.
 *
 * A null/absent window bound is unbounded on that side — a standing grant with
 * no sprint sums everything this subject dispatched here.
 */
export async function dispatchedSpendInWindow(input: {
  orgProjectId: string;
  dispatchedBy: string;
  startsOn: string | null;
  endsOn: string | null;
}): Promise<DispatchedSpend> {
  if (config.mock.aurora) return mockDispatchedSpend(input);
  if (!(await attributionAvailable())) return { spentUsd: 0, attributionAvailable: false };

  const params: SqlParameter[] = [s('pid', input.orgProjectId), s('by', input.dispatchedBy)];
  let window = '';
  if (input.startsOn) {
    window += ' AND br.started_at >= :from::date';
    params.push(s('from', input.startsOn));
  }
  if (input.endsOn) {
    // ends_on is inclusive (a sprint ends ON that day), so the exclusive upper
    // bound is the day after — same convention as listGrants' window.
    window += ' AND br.started_at < :to::date + 1';
    params.push(s('to', input.endsOn));
  }
  try {
    // Ledger mode (DE-30) counts every path this person spent through on the
    // initiative — ad-hoc box tasks and queued jobs as well as dispatches.
    const rows = await exec(
      spendLedgerMode() === 'ledger'
        ? `SELECT COALESCE(SUM(se.cost_usd), 0)::float8 AS spent
             FROM spend_entries se
            WHERE se.actor_id = :by
              AND se.initiative_id = :pid${window.replace(/br\.started_at/g, 'se.occurred_at')}`
        : `SELECT COALESCE(SUM(br.cost_usd), 0)::float8 AS spent
         FROM bot_runs br
        WHERE br.dispatched_by = :by
          AND (${spendPredicateSql(':pid')})${window}`,
      params,
    );
    return { spentUsd: toNum(rows[0]?.['spent']), attributionAvailable: true };
  } catch (err) {
    // Schema-tolerant, like the safeExec reads: a cluster that raced ahead of
    // the migration reports an unknown burn rather than failing the dispatch.
    // Re-probe next time in case the migration lands mid-process.
    if (/does not exist|relation|column/i.test((err as Error).message ?? '')) {
      _attribution = null;
      return { spentUsd: 0, attributionAvailable: false };
    }
    throw err;
  }
}

/**
 * The mock analogue of the statement above, row for row.
 *
 * Both halves of the ledger are here — the seeded cron history (`botRuns`)
 * and every run this process recorded (`liveBotRuns`) — because Aurora sums
 * one `bot_runs` table and does not care which of them wrote a row. The seeded
 * firings carry `dispatchedBy: null`, so in practice they match nobody: a cron
 * firing is authorized by no envelope, and the sum stays "only the runs
 * recorded as dispatched by you".
 *
 * Attribution to the initiative is `spendPredicateSql`'s three arms, in the
 * same order:
 *   1. through the run's WORK ITEM (every marketplace dispatch is one of
 *      these — bot_id null, work_item_id set);
 *   2. through a bot targeting the initiative directly;
 *   3. through a bot targeting a codebase that delivers it. No mock bot
 *      carries an agentProjectId, so the third arm can match nothing here;
 *      it is written out rather than silently dropped so the difference from
 *      the SQL is visible rather than assumed.
 *
 * `cost_usd IS NOT NULL` is the predicate's own first clause: a run still in
 * flight has posted no cost and burns nothing yet. The window bounds are the
 * sprint's dates, exclusive-upper at ends_on + 1 day, matching both the SQL
 * above and listGrants; a null bound is unbounded on that side.
 *
 * The total is rounded to `cost_usd`'s own scale rather than left as raw
 * float noise — Postgres sums NUMERIC exactly, and a burn reading
 * 0.06820000000000001 is a mock artefact, not a number the real path can
 * produce.
 */
async function mockDispatchedSpend(input: {
  orgProjectId: string;
  dispatchedBy: string;
  startsOn: string | null;
  endsOn: string | null;
}): Promise<DispatchedSpend> {
  const from = input.startsOn ? Date.parse(`${input.startsOn}T00:00:00Z`) : null;
  const toExclusive = input.endsOn ? Date.parse(`${input.endsOn}T00:00:00Z`) + 86_400_000 : null;

  const runs = allMockRuns().filter((r) => {
    if (r.dispatchedBy !== input.dispatchedBy) return false;
    if (r.costUsd == null) return false;
    const at = Date.parse(r.startedAt);
    if (from != null && at < from) return false;
    if (toExclusive != null && at >= toExclusive) return false;
    return true;
  });

  let spent = 0;
  for (const run of runs) {
    let attributed = false;
    if (run.workItemId) {
      const item = await getWorkItem(run.workItemId);
      attributed = item?.projectId === input.orgProjectId;
    }
    if (!attributed && run.botId) {
      const bot = MOCK_BOTS.find((b) => b.id === run.botId);
      // Arm 3 (bot → agent_project → initiative) would go here; every mock bot
      // targets its initiative directly, so arm 2 is the only one that fires.
      attributed = bot?.orgProjectId === input.orgProjectId;
    }
    if (attributed) spent += run.costUsd ?? 0;
  }

  if (spendLedgerMode() === 'ledger') {
    for (const e of mockStoredSpend((x) => x.actorId === input.dispatchedBy && x.initiativeId === input.orgProjectId)) {
      const at = Date.parse(e.occurredAt);
      if (from != null && at < from) continue;
      if (toExclusive != null && at >= toExclusive) continue;
      spent += e.costUsd ?? 0;
    }
  }

  return { spentUsd: Math.round(spent * 10_000) / 10_000, attributionAvailable: true };
}

// ─── Mock roster (config.mock.aurora) ──────────────────────────────
//
// The roster, the seeded cron history and the runs this process recorded are
// REGISTERED FIXTURES now, in mock/bots.ts. They were three module-level arrays
// right here (`MOCK_BOTS`, `MOCK_BOT_RUNS`, `MOCK_LIVE_RUNS`) and nothing could
// put them back: `POST /api/__mock/reset` walks the fixture registry, and none
// of the three was in it. So pausing a bot, resuming one or dispatching a run
// changed dev:mock permanently, and a write-capture sweep had to refuse those
// routes or replay them as echo-backs — a test that proves nothing. The array
// literals also baked their timestamps at import, so "2 runs today" meant two
// runs on the day the process booted, not on the day of the request.
//
// The exported names are unchanged, because they are a real API read across
// module boundaries (providers/agent-jobs.ts, providers/budgets.ts,
// providers/activity.ts and several suites). They are LIVE VIEWS onto the
// fixtures now — see mock/live-view.ts for why a captured array goes stale the
// moment a reset rebuilds it.
export { MOCK_BOTS, MOCK_BOT_RUNS, deriveBotStats, SEED_PAUSED_REASON } from '../mock/bots.js';

import {
  allMockRuns,
  bots as botsFixture,
  deriveBotStats,
  liveBotRuns,
  liveRunsFor,
  MOCK_BOTS,
  seededRunsFor,
} from '../mock/bots.js';

/**
 * The offline analogue of reconcileBotRuns' run-backed SELECT (lib/bot-runner.ts),
 * row for row and in the same column names, so the settle loop that consumes it
 * is the one the real path runs.
 *
 * Why it exists: offline the reconcile was a flat no-op, so a governed
 * marketplace dispatch in `dev:mock` never settled — its bot_run stayed
 * `running` forever (holding a slot of the concurrency ceiling), its work item
 * stayed `in_progress` even after its change was captured for review, and the
 * dispatcher's sprint envelope never burned, because burn counts only settled
 * cost. Joins are the SQL's: the run row by `run_id`, the newest change request
 * captured from that run, the bot's per-run budget.
 */
export async function mockRunBackedSettlements(): Promise<Record<string, unknown>[]> {
  const { agentProjectRuns } = await import('../mock/agent-project-runs.js');
  const { sdlcChanges } = await import('../mock/sdlc.js');
  const out: Record<string, unknown>[] = [];
  for (const br of liveBotRuns.rows()) {
    if (br.status !== 'running' || !br.runId) continue;
    const run = agentProjectRuns.rows().find((r) => r.id === br.runId);
    if (!run || (run.status !== 'done' && run.status !== 'failed')) continue;
    const change = sdlcChanges.rows()
      .filter((c) => c.runId === br.runId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const bot = br.botId ? MOCK_BOTS.find((b) => b.id === br.botId) : undefined;
    out.push({
      id: br.id,
      work_item_id: br.workItemId ?? null,
      run_status: run.status,
      cost_usd: run.costUsd ?? null,
      files_changed: run.filesChanged ?? null,
      run_error: run.error ?? null,
      change_id: change?.id ?? null,
      pr_url: change?.prUrl ?? null,
      budget_per_run_usd: bot?.budgetPerRunUsd ?? null,
    });
  }
  return out;
}

/** Test seam — drop everything this process recorded, leaving the seeded cron
 *  history alone. `fixtureRegistry.resetAll()` (POST /api/__mock/reset) does the
 *  same for both halves, which is what makes an offline dispatch undoable. */
export function __resetMockRuns(): void { liveBotRuns.reset(); }

/** Live rows for one bot — merged into the seeded history by listBotRuns so a
 *  bot fired by hand in dev:mock appears above its cron past. */
function liveRunsForBot(botId: string): BotRun[] {
  return liveRunsFor(botId);
}

/** The mock analogue of countRunningRuns' 24-hour window — see that function
 *  for why the window is there.
 *
 *  Over EVERY mock run — the seeded history and this process's rows — because
 *  Aurora's count is a bare `FROM bot_runs` that does not care who wrote a row.
 *  It read `liveBotRuns` only, which was harmless while the seed had no running
 *  row; once it seeded two in-flight marketplace runs (mock/bots.ts), a
 *  live-only count would have admitted three more dispatches past a ceiling of
 *  three with two already going. */
function countMockRunningRuns(): number {
  const cutoff = clock.now().getTime() - 24 * HOUR_MS;
  return allMockRuns().filter(
    (r) => r.status === 'running' && Date.parse(r.startedAt) > cutoff,
  ).length;
}

/**
 * The roster, and whether it is a reading of the bots table.
 *
 * An empty roster is a real and ordinary state — a fresh tenant has no bots —
 * and it is rendered with an invitation to create one. On a cluster that has
 * not had `agent_bots_schema.sql` applied the read ALSO produced an empty
 * roster, so the page invited the operator to create a bot into a table that
 * does not exist. Two answers, one shape; this is the one that says which.
 */
export async function listBotsResult(): Promise<Upstream<Bot[]>> {
  if (config.mock.aurora) return reached(MOCK_BOTS);
  const rows = await safeExecResult(`${BOT_SELECT} ORDER BY b.created_at DESC LIMIT 200`);
  const bots = rows.items.map(rowToBot);
  return rows.degraded ? unreachable(bots, rows.error) : reached(bots);
}

/** The lossy view. Kept for lib/bot-scheduler.ts (which registers cron bots at
 *  boot and has no response to mark) and for the parity harness. */
export async function listBots(): Promise<Bot[]> {
  return (await listBotsResult()).items;
}

export async function getBot(id: string): Promise<Bot | null> {
  if (config.mock.aurora) return MOCK_BOTS.find((b) => b.id === id) ?? null;
  if (!isUuid(id)) return null;
  const rows = await safeExec(`${BOT_SELECT} WHERE b.id = :id::uuid`, [s('id', id)]);
  return rows[0] ? rowToBot(rows[0]) : null;
}

export async function createBot(input: Parameters<typeof createBotRow>[0]): Promise<Bot | null> {
  const bot = await createBotRow(input);
  if (bot) await noteSearchWrite({ tenant: 'pipelines', type: 'bot', id: bot.id });
  return bot;
}

async function createBotRow(input: {
  name: string; template: BotTemplate; prompt: string; model: string; trigger: BotTrigger;
  cronExpr?: string | null; agentProjectId?: string | null; orgProjectId?: string | null;
  enabled?: boolean; budgetPerRunUsd?: number | null; budgetPerDayUsd?: number | null;
  maxRunsPerDay?: number; requiresReview?: boolean; enforceAllocation?: boolean;
  createdBy?: string | null;
}): Promise<Bot | null> {
  if (config.mock.aurora) {
    // Used to `return null`, and the route reads a null as "could not create"
    // and answers 503 — so authoring a bot was simply dead offline, which makes
    // an unbuilt feature and an unseeded one look identical (contract.ts bug
    // #5). A create has to mutate something; it mutates the REGISTERED roster
    // fixture, so `POST /api/__mock/reset` takes the new bot back out again.
    //
    // The defaults below are the bots table's own (schema/agent_bots_schema.sql)
    // and the same ones the INSERT binds, so a bot created offline carries the
    // same money gates a bot created against Aurora would.
    // gen_random_uuid()'s shape, so the isUuid() guards still mean something
    // offline, and so the run history can be asked about before the row exists.
    const id = randomUUID();
    const created: Bot = {
      id,
      name: input.name,
      template: input.template,
      prompt: input.prompt,
      agentProjectId: input.agentProjectId ?? null,
      agentProjectRepo: null,
      orgProjectId: input.orgProjectId ?? null,
      // The projects join the INSERT's read-back does, resolved against the
      // same initiative table the rest of mock mode renders — not restated.
      orgProjectName: input.orgProjectId ? mockProjectName(input.orgProjectId) : null,
      model: input.model,
      trigger: input.trigger,
      cronExpr: input.cronExpr ?? null,
      enabled: input.enabled !== false,
      budgetPerRunUsd: input.budgetPerRunUsd ?? null,
      budgetPerDayUsd: input.budgetPerDayUsd ?? null,
      maxRunsPerDay: input.maxRunsPerDay ?? 4,
      requiresReview: input.requiresReview !== false,
      enforceAllocation: input.enforceAllocation === true,
      createdBy: input.createdBy ?? null,
      // Through the clock, never `new Date()` — a created bot's age has to move
      // with a frozen test the same way the seeded roster's does.
      createdAt: clock.nowIso(),
      pausedReason: null,
      // Derived, not typed — the same expression every seeded roster entry
      // uses (mockBot in mock/bots.ts), over this bot's own history rather than
      // three zeros written by hand. A fresh uuid has no runs on either side, so
      // it reads null/0/0; writing that out by hand would be a typed aggregate
      // beside rows the fixture also exports (contract.ts rule 1).
      ...deriveBotStats([...seededRunsFor(id), ...liveRunsFor(id)]),
    };
    botsFixture.rows().push(created);
    return { ...created };
  }
  const rows = await exec(
    `INSERT INTO bots (name, template, prompt_template, model, trigger, cron_expr,
                       agent_project_id, org_project_id, enabled, budget_per_run_usd,
                       budget_per_day_usd, max_runs_per_day, requires_review,
                       enforce_allocation, created_by)
     VALUES (:name, :template, :prompt, :model, :trigger, :cron,
             :agent_project::uuid, :org_project, :enabled, :budget_run,
             :budget_day, :max_runs, :review, :enforce_alloc, :by)
     RETURNING id`,
    [
      s('name', input.name), s('template', input.template), s('prompt', input.prompt),
      s('model', input.model), s('trigger', input.trigger), maybe('cron', input.cronExpr ?? null),
      maybe('agent_project', input.agentProjectId ?? null), maybe('org_project', input.orgProjectId ?? null),
      bool('enabled', input.enabled !== false),
      num('budget_run', input.budgetPerRunUsd ?? null), num('budget_day', input.budgetPerDayUsd ?? null),
      int('max_runs', input.maxRunsPerDay ?? 4), bool('review', input.requiresReview !== false),
      // Default-off unless explicitly opted in — matches the column default.
      bool('enforce_alloc', input.enforceAllocation === true),
      maybe('by', input.createdBy ?? null),
    ],
  );
  const id = rows[0] ? toStr(rows[0]['id']) : '';
  // Re-read through BOT_SELECT so the returned bot carries its joins and today
  // stats — the insert alone cannot compute them.
  return id ? getBot(id) : null;
}

export interface BotPatch {
  name?: string; template?: BotTemplate; prompt?: string; model?: string; trigger?: BotTrigger;
  cronExpr?: string | null; agentProjectId?: string | null; orgProjectId?: string | null;
  enabled?: boolean; budgetPerRunUsd?: number | null; budgetPerDayUsd?: number | null;
  maxRunsPerDay?: number; requiresReview?: boolean; enforceAllocation?: boolean;
}

export async function updateBot(id: string, patch: BotPatch): Promise<Bot | null> {
  const bot = await updateBotRow(id, patch);
  if (bot) await noteSearchWrite({ tenant: 'pipelines', type: 'bot', id });
  return bot;
}

async function updateBotRow(id: string, patch: BotPatch): Promise<Bot | null> {
  if (config.mock.aurora) {
    // Mutates the shared MOCK_BOTS singleton in place — the same array
    // listBots()/getBot() read — so a toggle persists for the life of the
    // process instead of silently discarding the caller's patch (defect #10:
    // resume's `updateBot(id, { enabled: true })` used to no-op here, so the
    // route answered 200 with a bot that was never actually re-enabled).
    // Only `enabled` is wired up — the only field either mock caller sets —
    // other BotPatch keys remain unsupported in mock mode, same as before.
    const bot = MOCK_BOTS.find((b) => b.id === id);
    if (!bot) return null;
    if (patch.enabled !== undefined) bot.enabled = patch.enabled;
    return bot;
  }
  if (!isUuid(id)) return null;
  // Only the provided keys are written, so a PATCH that sets one field cannot
  // silently null out the rest — and `null` remains expressible for the
  // nullable columns (clearing a cron expr, detaching a target).
  const sets: string[] = [];
  const params: SqlParameter[] = [s('id', id)];
  const set = (clause: string, param: SqlParameter): void => { sets.push(clause); params.push(param); };

  if (patch.name !== undefined) set('name = :name', s('name', patch.name));
  if (patch.template !== undefined) set('template = :template', s('template', patch.template));
  if (patch.prompt !== undefined) set('prompt_template = :prompt', s('prompt', patch.prompt));
  if (patch.model !== undefined) set('model = :model', s('model', patch.model));
  if (patch.trigger !== undefined) set('trigger = :trigger', s('trigger', patch.trigger));
  if (patch.cronExpr !== undefined) set('cron_expr = :cron', maybe('cron', patch.cronExpr));
  if (patch.agentProjectId !== undefined) set('agent_project_id = :ap::uuid', maybe('ap', patch.agentProjectId));
  if (patch.orgProjectId !== undefined) set('org_project_id = :op', maybe('op', patch.orgProjectId));
  if (patch.enabled !== undefined) set('enabled = :enabled', bool('enabled', patch.enabled));
  if (patch.budgetPerRunUsd !== undefined) set('budget_per_run_usd = :brun', num('brun', patch.budgetPerRunUsd));
  if (patch.budgetPerDayUsd !== undefined) set('budget_per_day_usd = :bday', num('bday', patch.budgetPerDayUsd));
  if (patch.maxRunsPerDay !== undefined) set('max_runs_per_day = :mruns', int('mruns', patch.maxRunsPerDay));
  if (patch.requiresReview !== undefined) set('requires_review = :review', bool('review', patch.requiresReview));
  if (patch.enforceAllocation !== undefined) set('enforce_allocation = :enfalloc', bool('enfalloc', patch.enforceAllocation));

  if (sets.length > 0) {
    const rows = await exec(
      `UPDATE bots SET ${sets.join(', ')}, updated_at = NOW() WHERE id = :id::uuid RETURNING id`,
      params,
    );
    if (!rows[0]) return null;
  }
  return getBot(id);
}

export async function deleteBot(id: string): Promise<boolean> {
  const gone = await deleteBotRow(id);
  if (gone) await noteSearchWrite({ tenant: 'pipelines', type: 'bot', id });
  return gone;
}

async function deleteBotRow(id: string): Promise<boolean> {
  if (config.mock.aurora || !isUuid(id)) return false;
  const rows = await exec(`DELETE FROM bots WHERE id = :id::uuid RETURNING id`, [s('id', id)]);
  return rows.length > 0;
}

/** Set (or clear, with null) the self-pause. Cleared on resume. */
export async function setPausedReason(id: string, reason: string | null): Promise<void> {
  await setPausedReasonRow(id, reason);
  await noteSearchWrite({ tenant: 'pipelines', type: 'bot', id });
}

async function setPausedReasonRow(id: string, reason: string | null): Promise<void> {
  if (config.mock.aurora) {
    // Same fix as updateBot above: mutate the MOCK_BOTS singleton instead of
    // returning early. Before this, POST /:id/pause acknowledged a change it
    // never made — the route re-reads via getBot() right after, so the
    // response (and the portal's "✓ Paused" toast) reported the bot enabled
    // and unpaused no matter what the operator did (defect #10).
    const bot = MOCK_BOTS.find((b) => b.id === id);
    if (bot) bot.pausedReason = reason;
    return;
  }
  if (!isUuid(id)) return;
  await exec(
    `UPDATE bots SET paused_reason = :reason, updated_at = NOW() WHERE id = :id::uuid`,
    [s('id', id), maybe('reason', reason)],
  );
}

export async function markBotRan(id: string): Promise<void> {
  await markBotRanRow(id);
  await noteSearchWrite({ tenant: 'pipelines', type: 'bot', id });
}

async function markBotRanRow(id: string): Promise<void> {
  if (config.mock.aurora || !isUuid(id)) return;
  await exec(`UPDATE bots SET last_run_at = NOW(), updated_at = NOW() WHERE id = :id::uuid`, [s('id', id)]);
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function listBotRuns(botId: string, limit = 50): Promise<BotRun[]> {
  if (config.mock.aurora) {
    // The SAME array deriveBotStats() reads for lastRunAt/todayRunCount —
    // before this, the detail page's run list was hard-coded to `[]`
    // regardless of what the roster's summary numbers claimed (org-leader.md
    // defect #20).
    const runs = [...seededRunsFor(botId), ...liveRunsForBot(botId)]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return runs.slice(0, Math.min(Math.max(limit, 1), 200)).map((r) => ({ ...r }));
  }
  if (!isUuid(botId)) return [];
  const rows = await safeExec(
    `SELECT * FROM bot_runs WHERE bot_id = :bid::uuid
      ORDER BY started_at DESC LIMIT :lim`,
    [s('bid', botId), int('lim', Math.min(Math.max(limit, 1), 200))],
  );
  return rows.map(rowToRun);
}

/**
 * The same run history, saying whether it could be read.
 *
 * "This bot has never fired" is the single most common thing an operator comes
 * to the detail page to check, and a missing `bot_runs` table answered it with
 * a confident yes. Same envelope as `listBotsResult`; `listBotRuns` above
 * stays as the lossy view for the derivations that only want rows.
 */
export async function listBotRunsResult(botId: string, limit = 50): Promise<Upstream<BotRun[]>> {
  if (config.mock.aurora || !isUuid(botId)) return reached(await listBotRuns(botId, limit));
  const rows = await safeExecResult(
    `SELECT * FROM bot_runs WHERE bot_id = :bid::uuid
      ORDER BY started_at DESC LIMIT :lim`,
    [s('bid', botId), int('lim', Math.min(Math.max(limit, 1), 200))],
  );
  const runs = rows.items.map(rowToRun);
  return rows.degraded ? unreachable(runs, rows.error) : reached(runs);
}

/**
 * Run history for MULTIPLE bots in one call.
 *
 * `InitiativeAgentRail` used to fire one `GET /:id/runs` per bot targeting
 * an initiative — an N+1 that scaled with the roster, not with the page. This
 * merges those into one round trip while preserving what N separate calls
 * would have returned: each bot still caps at `limitPerBot` runs (a window
 * function partitioned by bot_id, mirroring the single-bot query's `LIMIT`),
 * so a busy bot cannot push a quiet bot's runs out of the merged list.
 */
export async function listBotRunsForBotsResult(botIds: string[], limitPerBot = 50): Promise<Upstream<BotRun[]>> {
  const ids = [...new Set(botIds)].filter(isUuid);
  if (ids.length === 0) return reached([]);

  if (config.mock.aurora) {
    const results = await Promise.all(ids.map((id) => listBotRunsResult(id, limitPerBot)));
    const degradedOne = results.find((r) => r.degraded);
    const runs = results.flatMap((r) => r.items);
    return degradedOne ? unreachable(runs, degradedOne.error) : reached(runs);
  }

  const lim = Math.min(Math.max(limitPerBot, 1), 200);
  const params: SqlParameter[] = [int('lim', lim)];
  const placeholders = ids.map((id, i) => {
    params.push(s(`bid${i}`, id));
    return `:bid${i}::uuid`;
  });
  const rows = await safeExecResult(
    `SELECT * FROM (
       SELECT *, ROW_NUMBER() OVER (PARTITION BY bot_id ORDER BY started_at DESC) AS rn
         FROM bot_runs WHERE bot_id IN (${placeholders.join(', ')})
     ) ranked
     WHERE rn <= :lim
     ORDER BY started_at DESC`,
    params,
  );
  const runs = rows.items.map(rowToRun);
  return rows.degraded ? unreachable(runs, rows.error) : reached(runs);
}

/**
 * Marketplace runs for one initiative: bot-less firings (bot_id IS NULL) whose
 * work item belongs to the initiative, newest first. Keyed through work_items
 * because the bot_run itself carries no project linkage.
 */
export async function listMarketplaceRuns(orgProjectId: string, limit = 100): Promise<BotRun[]> {
  if (config.mock.aurora) {
    // The same two conditions the statement below applies, resolved row by row,
    // over the whole table: the seeded history carries two in-flight
    // marketplace runs (mock/bots.ts `inFlightMarketplaceRuns`), this month's
    // finished dispatches (`finishedMarketplaceRuns`), and the rest is
    // what this process dispatched.
    const botless = allMockRuns().filter((r) => r.botId === null && r.workItemId);
    const matched: BotRun[] = [];
    for (const run of botless) {
      const item = await getWorkItem(run.workItemId as string);
      if (item?.projectId === orgProjectId) matched.push({ ...run });
    }
    return matched
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, Math.min(Math.max(limit, 1), 200));
  }
  const rows = await safeExec(
    `SELECT * FROM bot_runs
      WHERE bot_id IS NULL
        AND work_item_id IN (SELECT id FROM work_items WHERE project_id = :pid)
      ORDER BY started_at DESC LIMIT :lim`,
    [s('pid', orgProjectId), int('lim', Math.min(Math.max(limit, 1), 200))],
  );
  return rows.map(rowToRun);
}

/**
 * Every run that is still going, across the whole fleet.
 *
 * WHY THIS EXISTS. A dispatch was discoverable only from the initiative you
 * launched it from: `/api/bots/marketplace-runs` needs an orgProjectId, and
 * `/api/bots/:id/runs` needs a bot id, which a marketplace dispatch does not
 * have. Navigate away after pressing Run and the run was gone — still burning
 * money in a microVM, with no list anywhere that could lead you back to it.
 * The devbox quick-switch lists COMPUTERS, which is a different question: a box
 * with no run is idle, and a run whose box has been reaped is still a row.
 *
 * Scoped to RUNNING only and capped, because this backs a header widget that
 * polls: it must answer "what is live right now", not carry history.
 */
export async function listActiveRuns(limit = 25): Promise<BotRun[]> {
  const cap = Math.min(Math.max(limit, 1), 100);
  if (config.mock.aurora) {
    // Seeded and session rows alike — the SQL below reads one table, and the
    // seed's two in-flight marketplace runs are exactly what this widget is for.
    return allMockRuns()
      .filter((r) => r.status === 'running')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, cap)
      .map((r) => ({ ...r }));
  }
  // No attribution predicate: a run someone else dispatched is still a live
  // cost centre, and hiding it from the operator watching the fleet is how one
  // gets lost. Visibility of the BOX is filtered separately, at the lab.
  const rows = await safeExec(
    `SELECT * FROM bot_runs
      WHERE status = 'running'
      ORDER BY started_at DESC LIMIT :lim`,
    [int('lim', cap)],
  );
  return rows.map(rowToRun);
}

/**
 * Every `bot_run` this process can see — the seeded cron history plus every
 * row `createBotRun` recorded. The mock analogue of a bare `FROM bot_runs`
 * with no attribution predicate at all, which is what the ORG-wide total sums
 * (providers/budgets.ts `orgSummary`): the org total must not hide spend that
 * no initiative predicate happens to claim.
 */
export function mockAllRuns(): BotRun[] {
  return allMockRuns();
}

/**
 * **The one place mock attribution is resolved**: every `bot_run` this process
 * can see that belongs to `orgProjectId`, seeded history and live rows alike.
 *
 * This is `spendPredicateSql` evaluated row by row instead of by Postgres, and
 * it exists because three surfaces were each doing a DIFFERENT subset of that
 * job. The Initiatives rollup and the Budgets ledger summed only the seeded
 * cron history; the activity graph summed the seeded history plus marketplace
 * runs; nobody summed a live firing of a seeded bot. So a dispatch offline
 * moved the activity graph and left the two money surfaces flat, and one
 * `bot_runs` table answered three ways depending on which page asked.
 *
 * The arms, in `spendPredicateSql`'s own order:
 *   1. through the run's WORK ITEM — every marketplace dispatch (bot_id NULL,
 *      work_item_id set), and any bot run that also carries a work item;
 *   2. through a bot targeting the initiative directly;
 *   3. through a bot targeting a codebase that delivers it — no mock bot
 *      carries an agentProjectId, so this arm matches nothing here. Written
 *      out rather than silently dropped, so the gap from the SQL is visible.
 *
 * Deduped by run id: a live run can satisfy arms 1 and 2 at once, and a dollar
 * counted twice is worse than a dollar counted late.
 *
 * Synchronous, deliberately. `listMarketplaceRuns` is async only because it
 * resolves work items through `getWorkItem`; the mock work-item table is in
 * memory, so `mockWorkItemProjectId` answers the same question without an
 * await. That matters beyond convenience: `GrantRow.initiativeSpendInWindowUsd`
 * is a **getter** on every mock grant row (providers/budgets.ts `mockGrant`,
 * providers/grants.ts `withDerivedWindowSpend`), which is what keeps a grant's
 * burn derived through every reader that merely spreads the row. A getter
 * cannot await, so an async derivation here would force those back into stored
 * numbers — reintroducing exactly the drift they were built to prevent.
 *
 * Cost is NOT filtered here: "which runs belong to this initiative" and "which
 * of them have posted a cost" are different questions, and the activity graph
 * wants the first. Callers summing money apply `cost_usd IS NOT NULL`
 * themselves.
 */
export function mockRunsAttributedTo(orgProjectId: string): BotRun[] {
  const byId = new Map<string, BotRun>();

  // Arm 1 — through the work item. Covers marketplace dispatches (no bot at
  // all) and any bot run carrying one.
  for (const run of allMockRuns()) {
    if (!run.workItemId) continue;
    if (mockWorkItemProjectId(run.workItemId) === orgProjectId) byId.set(run.id, run);
  }

  // Arm 2 — a bot targeting the initiative. Seeded history AND live firings:
  // Aurora sums one bot_runs table and does not care which of them wrote a row.
  for (const bot of MOCK_BOTS) {
    if (bot.orgProjectId !== orgProjectId) continue;
    for (const run of seededRunsFor(bot.id)) byId.set(run.id, run);
    for (const run of liveRunsForBot(bot.id)) byId.set(run.id, run);
  }

  return [...byId.values()];
}

/**
 * A bot_runs row was inserted or settled. Listeners get ids only (the work
 * graph's refetch hint, lib/work-graph/live.ts); they re-read through the
 * authorized REST/snapshot path, never from this payload.
 */
export interface BotRunChange { runId: string; botId: string | null; workItemId: string | null }
const botRunListeners = new Set<(change: BotRunChange) => void>();
export function onBotRunChange(listener: (change: BotRunChange) => void): () => void {
  botRunListeners.add(listener);
  return () => { botRunListeners.delete(listener); };
}
function emitBotRunChange(change: BotRunChange): void {
  for (const listener of botRunListeners) {
    try { listener(change); } catch { /* a listener never breaks the write */ }
  }
}

export async function createBotRun(input: Parameters<typeof insertBotRun>[0]): Promise<BotRun | null> {
  const run = await insertBotRun(input);
  if (run) {
    emitBotRunChange({ runId: run.id, botId: run.botId, workItemId: run.workItemId });
    await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: `bot-run:${run.id}` }, run.botId ? { tenant: 'pipelines', type: 'bot', id: run.botId } : null);
  }
  return run;
}

export async function finalizeBotRun(id: string, result: Parameters<typeof settleBotRun>[1]): Promise<void> {
  await settleBotRun(id, result);
  emitBotRunChange({ runId: id, botId: null, workItemId: null });
  await noteSearchWrite({ tenant: 'pipelines', type: 'run', id: `bot-run:${id}` });
}

async function insertBotRun(input: {
  /** Null for a marketplace run — the work item is the mission, no bot exists. */
  botId: string | null; trigger: string; runId?: string | null; jobId?: string | null;
  workItemId?: string | null;
  /** 'running' for a dispatched run; a terminal status records a firing that
   *  never dispatched (skipped by a guard, failed before dispatch). */
  status?: 'running' | 'failed' | 'skipped';
  outcome?: Record<string, unknown>;
  /** For 'running' inserts: the concurrency ceiling, enforced atomically in
   *  the INSERT itself (INSERT ... SELECT guarded on the live count) so two
   *  interleaved dispatches cannot both pass a read-then-write check. A null
   *  return with ceiling set means the ceiling refused the row. */
  ceiling?: number;
  /** The session subject that authorized this firing — what a sprint envelope
   *  burns down against. Null for cron/pr_watch: nobody authorized those from
   *  inside an envelope. Dropped silently on a cluster without the attribution
   *  migration; a run that cannot be attributed is still a run worth
   *  recording. */
  dispatchedBy?: string | null;
}): Promise<BotRun | null> {
  const status = input.status ?? 'running';
  if (config.mock.aurora) {
    // The ceiling, held the same way the Aurora INSERT holds it: the count and
    // the append are one synchronous step here (single process, single thread),
    // so there is no read-then-write window, and a refusal is the same `null`
    // the guarded INSERT ... SELECT returns. Without this the concurrency gate
    // could never fire offline — countRunningRuns answered 0 forever, so
    // dev:mock claimed a ceiling it did not hold.
    if (status === 'running' && input.ceiling != null && countMockRunningRuns() >= input.ceiling) {
      return null;
    }
    // Through the mock clock, not `new Date()`. This stamp decides which
    // calendar day and which calendar month a dispatch's money lands in, and
    // every reader of it — the bot's todaySpendUsd, the ledger's period spend,
    // the sprint envelope's window — buckets in UTC through that same clock.
    // A wall-clock mint here is also what makes a frozen-clock test impossible
    // to write: the run would ignore the instant the test froze.
    const startedAt = clock.nowIso();
    const run: BotRun = {
      id: randomUUID(),                     // gen_random_uuid()'s shape, so the
      botId: input.botId,                   // isUuid() guards below still mean
      trigger: input.trigger,               // something offline.
      runId: input.runId ?? null,
      jobId: input.jobId ?? null,
      workItemId: input.workItemId ?? null,
      status,
      costUsd: null,
      // Unknown at insert, on both paths and on purpose: a run is recorded when
      // it is dispatched and nothing has served any inference yet. The provider
      // is written by finalizeBotRun, by whoever actually ran it.
      modelProvider: null,
      startedAt,
      // Mirrors the INSERT's CASE: a run that never dispatched is finished the
      // moment it is recorded.
      finishedAt: status === 'running' ? null : startedAt,
      outcome: input.outcome ?? {},
      // Recorded unconditionally, unlike the Aurora path's attributionAvailable()
      // probe: that probe asks whether THIS cluster has had
      // schema/agent_run_attribution_schema.sql applied, and the mock stands in
      // for a cluster that has (the migration is checked in). The envelope
      // brake's READ side — dispatchedSpendInWindow — sums exactly these rows,
      // so a dispatch offline burns a real envelope down.
      dispatchedBy: input.dispatchedBy ?? null,
    };
    liveBotRuns.rows().push(run);
    return { ...run };
  }
  const params: SqlParameter[] = [
    maybe('bid', input.botId), s('trigger', input.trigger),
    maybe('run', input.runId ?? null), maybe('job', input.jobId ?? null),
    maybe('work_item', input.workItemId ?? null), s('status', status),
    s('outcome', JSON.stringify(input.outcome ?? {})),
  ];
  // Only widen the statement when the column is really there — the middleware
  // may be running ahead of schema/agent_run_attribution_schema.sql.
  const withBy = input.dispatchedBy != null && await attributionAvailable();
  if (withBy) params.push(s('by', input.dispatchedBy as string));
  const cols = `bot_id, trigger, run_id, job_id, work_item_id, status, outcome, finished_at${withBy ? ', dispatched_by' : ''}`;

  if (status === 'running' && input.ceiling != null) {
    // The TOCTOU-safe form: the count and the insert are one statement, so the
    // database — not a racy pre-check — is what holds the ceiling. Same 24h
    // window as countRunningRuns, so a stuck ancient row cannot wedge it shut.
    const rows = await exec(
      `INSERT INTO bot_runs (${cols})
       SELECT :bid::uuid, :trigger, :run::uuid, :job, :work_item, :status, :outcome::jsonb, NULL${withBy ? ', :by' : ''}
        WHERE (SELECT COUNT(*) FROM bot_runs
                WHERE status = 'running' AND started_at > NOW() - INTERVAL '24 hours') < :ceiling
       RETURNING *`,
      [...params, int('ceiling', input.ceiling)],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  }
  const rows = await exec(
    `INSERT INTO bot_runs (${cols})
     VALUES (:bid::uuid, :trigger, :run::uuid, :job, :work_item, :status, :outcome::jsonb,
             CASE WHEN :status = 'running' THEN NULL ELSE NOW() END${withBy ? ', :by' : ''})
     RETURNING *`,
    params,
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

async function settleBotRun(id: string, result: {
  status: 'done' | 'failed' | 'skipped';
  costUsd?: number | null;
  /**
   * Which kind of inference served the run — `bedrock`, `local`, `simulated`.
   *
   * Recorded because `cost_usd` alone cannot answer "why is this run's spend
   * zero", and the two answers are opposites: a local run is zero because the
   * electricity was somebody's own, and a cloud run reading zero is a run whose
   * figure was never reported. Without the column the only way to tell them
   * apart is to guess, and a rollup that guesses wrong understates the fleet's
   * real burn. See lib/run-cost.ts for the doctrine and
   * schema/local_compute_worker_schema.sql for the column.
   *
   * Omitted leaves the column alone (NULL on a row that predates the feature),
   * never defaulted to 'bedrock' — inventing a provenance is the failure this
   * column exists to prevent.
   */
  modelProvider?: ModelProvider | null;
  outcome?: Record<string, unknown>;
}): Promise<void> {
  if (config.mock.aurora) {
    // Either half of the table: a seeded in-flight run settles the same way a
    // dispatched one does (and a reset re-seeds it).
    const run = allMockRuns().find((r) => r.id === id);
    if (!run) return;
    run.status = result.status;
    // COALESCE and `||` respectively: a null cost leaves the recorded one
    // alone, and the outcome merges rather than replaces.
    if (result.costUsd != null) run.costUsd = result.costUsd;
    if (result.modelProvider != null) run.modelProvider = result.modelProvider;
    run.outcome = { ...run.outcome, ...(result.outcome ?? {}) };
    // NOW() in the UPDATE below; clock.nowIso() here, for the same reason the
    // insert's startedAt is — one clock, so a frozen test freezes both ends of
    // a run rather than half of it.
    run.finishedAt = clock.nowIso();
    return;
  }
  if (!isUuid(id)) return;
  // The provider column appears in the statement ONLY when there is a provider
  // to write and the cluster has the column. Every other finalize — which is
  // every cloud run today — keeps the previous statement byte-for-byte, because
  // this one runs on the push path that was working before local compute
  // existed. See providers/column-probe.ts.
  const provider = result.modelProvider != null && await hasColumns('bot_runs', ['model_provider'])
    ? result.modelProvider
    : null;
  await exec(
    `UPDATE bot_runs
        SET status = :status,
            cost_usd = COALESCE(:cost, cost_usd),
            ${provider ? 'model_provider = :provider,' : ''}
            outcome = COALESCE(outcome, '{}'::jsonb) || :outcome::jsonb,
            finished_at = NOW()
      WHERE id = :id::uuid`,
    [
      s('id', id), s('status', result.status),
      num('cost', result.costUsd ?? null),
      ...(provider ? [s('provider', provider)] : []),
      s('outcome', JSON.stringify(result.outcome ?? {})),
    ],
  );
  // The ledger entry (DE-30), resolved from the row just settled.
  await recordBotRunSpend(id);
}

/**
 * Every bot_run currently running — bot firings and marketplace dispatches
 * alike. The global concurrency ceiling in lib/bot-runner.ts is judged against
 * this one number, so the two dispatch paths cannot count differently.
 */
export async function countRunningRuns(): Promise<number> {
  // Rows older than 24h are ignored as a defence in depth: a bot_run stuck
  // 'running' (crashed reconcile, vanished linkage) must not eat a concurrency
  // slot forever. The boot sweep and reconcile arms fail such rows properly;
  // this window just caps the damage until they do.
  if (config.mock.aurora) return countMockRunningRuns();
  // `exec`, NOT `safeExec` — the one caller that must not swallow.
  //
  // This number is the global concurrency ceiling's whole input
  // (lib/bot-runner.ts `checkConcurrency` → `decideConcurrency`). Through
  // safeExec a missing `bot_runs` table returned no rows, `toNum(undefined)`
  // made that 0, and the ceiling read its own blindness as full headroom and
  // admitted every dispatch — a brake that disengages precisely when the
  // schema is in a state nobody has verified. There is no degraded answer to
  // return here: a count is a scalar and `unknown` is not a number, so the
  // read fails loudly and the dispatch fails with it, which is the same rule
  // this module already applies to writes. Cheap to be wrong about: if
  // bot_runs is missing, `createBotRun` cannot record the run either.
  const rows = await exec(
    `SELECT COUNT(*)::int AS n FROM bot_runs
      WHERE status = 'running' AND started_at > NOW() - INTERVAL '24 hours'`,
  );
  return toNum(rows[0]?.['n']);
}

export async function todayStats(botId: string): Promise<{ spendUsd: number; runCount: number }> {
  if (config.mock.aurora || !isUuid(botId)) return { spendUsd: 0, runCount: 0 };
  const rows = await exec(
    `SELECT COALESCE(SUM(cost_usd), 0)::float8 AS spend,
            COUNT(*) FILTER (WHERE status <> 'skipped')::int AS runs
       FROM bot_runs
      WHERE bot_id = :bid::uuid AND started_at >= date_trunc('day', NOW())`,
    [s('bid', botId)],
  );
  return { spendUsd: toNum(rows[0]?.['spend']), runCount: toNum(rows[0]?.['runs']) };
}

// ─── Estimator samples ────────────────────────────────────────────────────────

/**
 * Percentile cost/duration over completed governed runs, the estimator's data.
 * Repo-scoped when projectId is given, else model-wide. Returns null when no
 * run qualifies — the caller falls back per lib/bot-estimate.ts.
 */
export async function runCostSamples(model: string, projectId: string | null): Promise<RunPercentiles | null> {
  if (config.mock.aurora) return null;
  if (projectId && !isUuid(projectId)) return null;
  const params: SqlParameter[] = [s('model', model)];
  let scope = '';
  if (projectId) {
    scope = 'AND project_id = :pid::uuid';
    params.push(s('pid', projectId));
  }
  const rows = await exec(
    `SELECT COUNT(*)::int AS n,
            (percentile_cont(0.25) WITHIN GROUP (ORDER BY cost_usd))::float8 AS cost_p25,
            (percentile_cont(0.75) WITHIN GROUP (ORDER BY cost_usd))::float8 AS cost_p75,
            (percentile_cont(0.25) WITHIN GROUP (ORDER BY duration_ms / 60000.0))::float8 AS min_p25,
            (percentile_cont(0.75) WITHIN GROUP (ORDER BY duration_ms / 60000.0))::float8 AS min_p75
       FROM agent_project_runs
      WHERE status = 'done' AND cost_usd IS NOT NULL AND duration_ms IS NOT NULL
        AND model = :model ${scope}`,
    params,
  );
  const r = rows[0];
  const count = toNum(r?.['n']);
  if (!r || count === 0) return null;
  return {
    count,
    costUsdP25: toNum(r['cost_p25']),
    costUsdP75: toNum(r['cost_p75']),
    minutesP25: toNum(r['min_p25']),
    minutesP75: toNum(r['min_p75']),
  };
}

/**
 * Per-POINT percentiles: cost and minutes divided by the story points of the
 * work item each run delivered. Only runs bound to a sized work item qualify —
 * that binding is what lets a 5-pt estimate be 5 × the per-point history
 * rather than a blind run-level range. Same RunPercentiles shape as
 * runCostSamples, but the numbers mean $/point and minutes/point; the caller
 * multiplies by N (lib/marketplace-estimate.ts).
 */
export async function perPointCostSamples(model: string, projectId: string | null): Promise<RunPercentiles | null> {
  if (config.mock.aurora) return null;
  if (projectId && !isUuid(projectId)) return null;
  const params: SqlParameter[] = [s('model', model)];
  let scope = '';
  if (projectId) {
    scope = 'AND r.project_id = :pid::uuid';
    params.push(s('pid', projectId));
  }
  const rows = await exec(
    `SELECT COUNT(*)::int AS n,
            (percentile_cont(0.25) WITHIN GROUP (ORDER BY r.cost_usd / wi.story_points))::float8 AS cost_p25,
            (percentile_cont(0.75) WITHIN GROUP (ORDER BY r.cost_usd / wi.story_points))::float8 AS cost_p75,
            (percentile_cont(0.25) WITHIN GROUP (ORDER BY r.duration_ms / 60000.0 / wi.story_points))::float8 AS min_p25,
            (percentile_cont(0.75) WITHIN GROUP (ORDER BY r.duration_ms / 60000.0 / wi.story_points))::float8 AS min_p75
       FROM agent_project_runs r
       JOIN work_items wi ON wi.id = r.work_item_id
      WHERE r.status = 'done' AND r.cost_usd IS NOT NULL AND r.duration_ms IS NOT NULL
        AND r.work_item_id IS NOT NULL AND wi.story_points > 0
        AND r.model = :model ${scope}`,
    params,
  );
  const r = rows[0];
  const count = toNum(r?.['n']);
  if (!r || count === 0) return null;
  return {
    count,
    costUsdP25: toNum(r['cost_p25']),
    costUsdP75: toNum(r['cost_p75']),
    minutesP25: toNum(r['min_p25']),
    minutesP75: toNum(r['min_p75']),
  };
}
