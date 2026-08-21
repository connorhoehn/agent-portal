// Budgets — per-initiative agent-spend allocations, and the actuals they are
// judged against.
//
// Allocation is the only thing stored (schema/agent_budgets_schema.sql);
// spend is derived at read time from bot_runs.cost_usd so the ledger and the
// actuals can never disagree. The cost philosophy (docs/bots-and-work-
// marketplace.md §7) puts the per-run and per-day brakes on the bot; this
// surface is the program-manager's layer above them: how much each initiative
// may spend per month, and where money is going with no allocation behind it.
//
// This module is persistence only. Gating lives in routes/budgets.ts.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : nul(name);
}
function num(name: string, v: number): SqlParameter { return { name, value: { doubleValue: v } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export interface BudgetRow {
  orgProjectId: string;
  orgProjectName: string | null;
  /** Null for an initiative that is spending with no allocation — exactly the
   *  blind spot the list surfaces. */
  allocatedUsd: number | null;
  period: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  spentThisPeriodUsd: number;
  runCountThisPeriod: number;
  lastAgentActivityAt: string | null;
}

export interface OrgBudgetSummary {
  totalAllocatedUsd: number;
  totalSpentThisPeriodUsd: number;
  byModel: Array<{ model: string; spentUsd: number; runCount: number }>;
  byTrigger: Array<{ trigger: string; spentUsd: number; runCount: number }>;
}

// ─── Period window + attribution (pure SQL builders, unit-tested) ────────────

/** Start of the current budget period. v1 is monthly-only (the schema CHECK
 *  agrees), so every spend read windows on the calendar month. */
export const PERIOD_START_SQL = `date_trunc('month', NOW())`;

/**
 * The three-way attribution predicate — copied from listProjects in
 * providers/projects.ts (the Projects rollup), which is the attribution model
 * of record: a bot_run belongs to an initiative via
 *   1. its work item (br.work_item_id → work_items.project_id),
 *   2. a bot targeting the initiative directly (bots.org_project_id), or
 *   3. a bot targeting a codebase that delivers it
 *      (bots.agent_project_id → agent_projects.org_project_id).
 * `projectRef` is the SQL expression for the initiative id being matched.
 */
export function spendPredicateSql(projectRef: string): string {
  return `
        br.cost_usd IS NOT NULL AND (
          br.work_item_id IN (SELECT w2.id FROM work_items w2 WHERE w2.project_id = ${projectRef})
          OR br.bot_id IN (
            SELECT b.id FROM bots b
             WHERE b.org_project_id = ${projectRef}
                OR b.agent_project_id IN (SELECT ap.id FROM agent_projects ap WHERE ap.org_project_id = ${projectRef})
          )
        )`;
}

// ─── Read plumbing ───────────────────────────────────────────────────────────

/** Reads degrade to empty until the budgets/bots schema is applied — a cluster
 * that predates agent_budgets_schema.sql should render an empty ledger, not a
 * 500. Writes stay loud: allocating against a missing table is a real error. */
async function safeExec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  try {
    return await exec(sql, params);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/does not exist|relation/i.test(msg)) return [];
    throw err;
  }
}

function rowToBudget(r: Record<string, unknown>): BudgetRow {
  return {
    orgProjectId: toStr(r['org_project_id']),
    orgProjectName: r['org_project_name'] != null ? toStr(r['org_project_name']) : null,
    allocatedUsd: r['allocated_usd'] == null ? null : toNum(r['allocated_usd']),
    period: r['period'] != null ? toStr(r['period']) : null,
    updatedBy: r['updated_by'] != null ? toStr(r['updated_by']) : null,
    updatedAt: r['updated_at'] != null ? toStr(r['updated_at']) : null,
    spentThisPeriodUsd: toNum(r['spent_this_period_usd']),
    runCountThisPeriod: toNum(r['run_count_this_period']),
    lastAgentActivityAt: r['last_agent_activity_at'] != null ? toStr(r['last_agent_activity_at']) : null,
  };
}

// Every initiative that has an allocation OR any attributed spend this period.
// The id set is the UNION of both sources (FULL-OUTER-ish), so an initiative
// spending with no allocation still surfaces — that unallocated-but-spending
// row is exactly the program-manager's blind spot.
function budgetSelectSql(scopeToId: boolean): string {
  const scope = scopeToId ? 'WHERE ids.org_project_id = :pid' : '';
  return `
    WITH period_spend AS (
      SELECT p.id AS org_project_id,
             SUM(br.cost_usd)::float8 AS spent_this_period_usd,
             COUNT(*)::int AS run_count_this_period,
             MAX(br.started_at) AS last_agent_activity_at
        FROM projects p
        JOIN bot_runs br
          ON br.started_at >= ${PERIOD_START_SQL}
         AND (${spendPredicateSql('p.id')})
       GROUP BY p.id
    ),
    ids AS (
      SELECT org_project_id FROM initiative_budgets
      UNION
      SELECT org_project_id FROM period_spend
    )
    SELECT ids.org_project_id,
           p.name AS org_project_name,
           ib.allocated_usd::float8 AS allocated_usd,
           ib.period,
           ib.updated_by,
           ib.updated_at,
           COALESCE(ps.spent_this_period_usd, 0)::float8 AS spent_this_period_usd,
           COALESCE(ps.run_count_this_period, 0)::int AS run_count_this_period,
           ps.last_agent_activity_at
      FROM ids
      LEFT JOIN initiative_budgets ib ON ib.org_project_id = ids.org_project_id
      LEFT JOIN period_spend ps ON ps.org_project_id = ids.org_project_id
      LEFT JOIN projects p ON p.id = ids.org_project_id
      ${scope}
     ORDER BY COALESCE(ps.spent_this_period_usd, 0) DESC, ids.org_project_id`;
}

// ─── Provider functions ──────────────────────────────────────────────────────

export async function listBudgets(): Promise<BudgetRow[]> {
  if (config.mock.aurora) return [];
  const rows = await safeExec(budgetSelectSql(false));
  return rows.map(rowToBudget);
}

export async function getBudget(orgProjectId: string): Promise<BudgetRow | null> {
  if (config.mock.aurora) return null;
  const rows = await safeExec(budgetSelectSql(true), [s('pid', orgProjectId)]);
  return rows[0] ? rowToBudget(rows[0]) : null;
}

/** Does the initiative exist? Mock mode answers true and lets the write path
 *  return its 503 — a 404 would misreport "no Aurora" as "no such project". */
export async function initiativeExists(orgProjectId: string): Promise<boolean> {
  if (config.mock.aurora) return true;
  const rows = await exec('SELECT id FROM projects WHERE id = :pid LIMIT 1', [s('pid', orgProjectId)]);
  return rows.length > 0;
}

export async function upsertAllocation(
  orgProjectId: string,
  allocatedUsd: number,
  updatedBy: string | null,
): Promise<BudgetRow | null> {
  if (config.mock.aurora) return null;
  await exec(
    `INSERT INTO initiative_budgets (org_project_id, allocated_usd, updated_by)
     VALUES (:pid, :alloc, :by)
     ON CONFLICT (org_project_id) DO UPDATE
       SET allocated_usd = EXCLUDED.allocated_usd,
           updated_by = EXCLUDED.updated_by,
           updated_at = NOW()`,
    [s('pid', orgProjectId), num('alloc', allocatedUsd), maybe('by', updatedBy)],
  );
  // Re-read through the list shape so the returned budget carries its joined
  // name and this-period spend — the insert alone cannot compute them.
  return getBudget(orgProjectId);
}

export async function deleteAllocation(orgProjectId: string): Promise<boolean> {
  if (config.mock.aurora) return false;
  const rows = await exec(
    `DELETE FROM initiative_budgets WHERE org_project_id = :pid RETURNING org_project_id`,
    [s('pid', orgProjectId)],
  );
  return rows.length > 0;
}

// ─── Org summary ─────────────────────────────────────────────────────────────

export async function orgSummary(): Promise<OrgBudgetSummary> {
  const empty: OrgBudgetSummary = {
    totalAllocatedUsd: 0, totalSpentThisPeriodUsd: 0, byModel: [], byTrigger: [],
  };
  if (config.mock.aurora) return empty;

  // Totals: allocation from the ledger; spend is ALL bot_runs cost this
  // period, attributed or not — the org total must not hide spend that no
  // initiative predicate happens to claim.
  const totals = await safeExec(
    `SELECT
       (SELECT COALESCE(SUM(allocated_usd), 0)::float8 FROM initiative_budgets) AS total_allocated,
       (SELECT COALESCE(SUM(cost_usd), 0)::float8 FROM bot_runs
         WHERE started_at >= ${PERIOD_START_SQL}) AS total_spent`,
  );

  // By-model is scoped to run-backed spend (bot_runs.run_id →
  // agent_project_runs.model). Job-backed rows are deliberately excluded:
  // agent_jobs carries no reliable model column (the model lives, at best,
  // inside result JSON), so a by-model split over jobs would be guesswork.
  // byModel therefore sums ≤ totalSpentThisPeriodUsd.
  const byModel = await safeExec(
    `SELECT apr.model,
            COALESCE(SUM(br.cost_usd), 0)::float8 AS spent_usd,
            COUNT(*)::int AS run_count
       FROM bot_runs br
       JOIN agent_project_runs apr ON apr.id = br.run_id
      WHERE br.started_at >= ${PERIOD_START_SQL}
        AND br.cost_usd IS NOT NULL AND apr.model IS NOT NULL
      GROUP BY apr.model
      ORDER BY spent_usd DESC`,
  );

  const byTrigger = await safeExec(
    `SELECT br.trigger,
            COALESCE(SUM(br.cost_usd), 0)::float8 AS spent_usd,
            COUNT(*)::int AS run_count
       FROM bot_runs br
      WHERE br.started_at >= ${PERIOD_START_SQL}
        AND br.cost_usd IS NOT NULL
      GROUP BY br.trigger
      ORDER BY spent_usd DESC`,
  );

  return {
    totalAllocatedUsd: toNum(totals[0]?.['total_allocated']),
    totalSpentThisPeriodUsd: toNum(totals[0]?.['total_spent']),
    byModel: byModel.map((r) => ({
      model: toStr(r['model']), spentUsd: toNum(r['spent_usd']), runCount: toNum(r['run_count']),
    })),
    byTrigger: byTrigger.map((r) => ({
      trigger: toStr(r['trigger']), spentUsd: toNum(r['spent_usd']), runCount: toNum(r['run_count']),
    })),
  };
}
