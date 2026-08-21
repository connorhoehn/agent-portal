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

import { exec } from './aurora.js';
import { config } from '../config.js';
import type { RunPercentiles } from '../lib/bot-estimate.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

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
  startedAt: string;
  finishedAt: string | null;
  outcome: Record<string, unknown>;
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
    startedAt: toStr(r['started_at']),
    finishedAt: r['finished_at'] ? toStr(r['finished_at']) : null,
    outcome: parseJson<Record<string, unknown>>(r['outcome'], {}),
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

/** Reads degrade to empty until the bots schema is applied — a cluster that
 * predates agent_bots_schema.sql should render an empty roster, not a 500.
 * Writes stay loud: creating a bot against a missing table is a real error. */
async function safeExec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  try {
    return await exec(sql, params);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/does not exist|relation/i.test(msg)) return [];
    throw err;
  }
}

export async function listBots(): Promise<Bot[]> {
  if (config.mock.aurora) return [];
  const rows = await safeExec(`${BOT_SELECT} ORDER BY b.created_at DESC LIMIT 200`);
  return rows.map(rowToBot);
}

export async function getBot(id: string): Promise<Bot | null> {
  if (config.mock.aurora || !isUuid(id)) return null;
  const rows = await safeExec(`${BOT_SELECT} WHERE b.id = :id::uuid`, [s('id', id)]);
  return rows[0] ? rowToBot(rows[0]) : null;
}

export async function createBot(input: {
  name: string; template: BotTemplate; prompt: string; model: string; trigger: BotTrigger;
  cronExpr?: string | null; agentProjectId?: string | null; orgProjectId?: string | null;
  enabled?: boolean; budgetPerRunUsd?: number | null; budgetPerDayUsd?: number | null;
  maxRunsPerDay?: number; requiresReview?: boolean; createdBy?: string | null;
}): Promise<Bot | null> {
  if (config.mock.aurora) return null;
  const rows = await exec(
    `INSERT INTO bots (name, template, prompt_template, model, trigger, cron_expr,
                       agent_project_id, org_project_id, enabled, budget_per_run_usd,
                       budget_per_day_usd, max_runs_per_day, requires_review, created_by)
     VALUES (:name, :template, :prompt, :model, :trigger, :cron,
             :agent_project::uuid, :org_project, :enabled, :budget_run,
             :budget_day, :max_runs, :review, :by)
     RETURNING id`,
    [
      s('name', input.name), s('template', input.template), s('prompt', input.prompt),
      s('model', input.model), s('trigger', input.trigger), maybe('cron', input.cronExpr ?? null),
      maybe('agent_project', input.agentProjectId ?? null), maybe('org_project', input.orgProjectId ?? null),
      bool('enabled', input.enabled !== false),
      num('budget_run', input.budgetPerRunUsd ?? null), num('budget_day', input.budgetPerDayUsd ?? null),
      int('max_runs', input.maxRunsPerDay ?? 4), bool('review', input.requiresReview !== false),
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
  maxRunsPerDay?: number; requiresReview?: boolean;
}

export async function updateBot(id: string, patch: BotPatch): Promise<Bot | null> {
  if (config.mock.aurora || !isUuid(id)) return null;
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
  if (config.mock.aurora || !isUuid(id)) return false;
  const rows = await exec(`DELETE FROM bots WHERE id = :id::uuid RETURNING id`, [s('id', id)]);
  return rows.length > 0;
}

/** Set (or clear, with null) the self-pause. Cleared on resume. */
export async function setPausedReason(id: string, reason: string | null): Promise<void> {
  if (config.mock.aurora || !isUuid(id)) return;
  await exec(
    `UPDATE bots SET paused_reason = :reason, updated_at = NOW() WHERE id = :id::uuid`,
    [s('id', id), maybe('reason', reason)],
  );
}

export async function markBotRan(id: string): Promise<void> {
  if (config.mock.aurora || !isUuid(id)) return;
  await exec(`UPDATE bots SET last_run_at = NOW(), updated_at = NOW() WHERE id = :id::uuid`, [s('id', id)]);
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function listBotRuns(botId: string, limit = 50): Promise<BotRun[]> {
  if (config.mock.aurora || !isUuid(botId)) return [];
  const rows = await safeExec(
    `SELECT * FROM bot_runs WHERE bot_id = :bid::uuid
      ORDER BY started_at DESC LIMIT :lim`,
    [s('bid', botId), int('lim', Math.min(Math.max(limit, 1), 200))],
  );
  return rows.map(rowToRun);
}

/**
 * Marketplace runs for one initiative: bot-less firings (bot_id IS NULL) whose
 * work item belongs to the initiative, newest first. Keyed through work_items
 * because the bot_run itself carries no project linkage.
 */
export async function listMarketplaceRuns(orgProjectId: string, limit = 100): Promise<BotRun[]> {
  if (config.mock.aurora) return [];
  const rows = await safeExec(
    `SELECT * FROM bot_runs
      WHERE bot_id IS NULL
        AND work_item_id IN (SELECT id FROM work_items WHERE project_id = :pid)
      ORDER BY started_at DESC LIMIT :lim`,
    [s('pid', orgProjectId), int('lim', Math.min(Math.max(limit, 1), 200))],
  );
  return rows.map(rowToRun);
}

export async function createBotRun(input: {
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
}): Promise<BotRun | null> {
  if (config.mock.aurora) return null;
  const status = input.status ?? 'running';
  const params: SqlParameter[] = [
    maybe('bid', input.botId), s('trigger', input.trigger),
    maybe('run', input.runId ?? null), maybe('job', input.jobId ?? null),
    maybe('work_item', input.workItemId ?? null), s('status', status),
    s('outcome', JSON.stringify(input.outcome ?? {})),
  ];
  if (status === 'running' && input.ceiling != null) {
    // The TOCTOU-safe form: the count and the insert are one statement, so the
    // database — not a racy pre-check — is what holds the ceiling. Same 24h
    // window as countRunningRuns, so a stuck ancient row cannot wedge it shut.
    const rows = await exec(
      `INSERT INTO bot_runs (bot_id, trigger, run_id, job_id, work_item_id, status, outcome, finished_at)
       SELECT :bid::uuid, :trigger, :run::uuid, :job, :work_item, :status, :outcome::jsonb, NULL
        WHERE (SELECT COUNT(*) FROM bot_runs
                WHERE status = 'running' AND started_at > NOW() - INTERVAL '24 hours') < :ceiling
       RETURNING *`,
      [...params, int('ceiling', input.ceiling)],
    );
    return rows[0] ? rowToRun(rows[0]) : null;
  }
  const rows = await exec(
    `INSERT INTO bot_runs (bot_id, trigger, run_id, job_id, work_item_id, status, outcome, finished_at)
     VALUES (:bid::uuid, :trigger, :run::uuid, :job, :work_item, :status, :outcome::jsonb,
             CASE WHEN :status = 'running' THEN NULL ELSE NOW() END)
     RETURNING *`,
    params,
  );
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function finalizeBotRun(id: string, result: {
  status: 'done' | 'failed' | 'skipped';
  costUsd?: number | null;
  outcome?: Record<string, unknown>;
}): Promise<void> {
  if (config.mock.aurora || !isUuid(id)) return;
  await exec(
    `UPDATE bot_runs
        SET status = :status,
            cost_usd = COALESCE(:cost, cost_usd),
            outcome = COALESCE(outcome, '{}'::jsonb) || :outcome::jsonb,
            finished_at = NOW()
      WHERE id = :id::uuid`,
    [
      s('id', id), s('status', result.status),
      num('cost', result.costUsd ?? null),
      s('outcome', JSON.stringify(result.outcome ?? {})),
    ],
  );
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
  if (config.mock.aurora) return 0;
  const rows = await safeExec(
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
