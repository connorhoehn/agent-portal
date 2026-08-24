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
  /** Genuinely last, not last-this-period — the only unwindowed field on this
   *  row. Matches ProjectSummary.lastAgentActivityAt exactly. */
  lastAgentActivityAt: string | null;
  /** The cron-triggered subset of this period's spend: the recurring floor of
   *  keeping this initiative's repos alive (dependency bumps, drift checks,
   *  evidence sweeps). A subset of spentThisPeriodUsd, never additional to it.
   *  Read an allocation against this — only the remainder is available for new
   *  work, and a floor approaching the allocation means the initiative cannot
   *  take anything on. See docs/program-operating-model.md. */
  maintenanceUsd: number;
}

export interface OrgBudgetSummary {
  totalAllocatedUsd: number;
  totalSpentThisPeriodUsd: number;
  /** Org-wide cron spend this period — the baseline cost of ownership across
   *  every initiative. Subset of totalSpentThisPeriodUsd. */
  totalMaintenanceUsd: number;
  byModel: Array<{ model: string; spentUsd: number; runCount: number }>;
  byTrigger: Array<{ trigger: string; spentUsd: number; runCount: number }>;
}

// ─── Period window + attribution (pure SQL builders, unit-tested) ────────────

/** Start of the current budget period. v1 is monthly-only (the schema CHECK
 *  agrees), so every spend read windows on the calendar month.
 *
 *  This is the single window for agent spend across the whole app, not just
 *  this module: providers/projects.ts imports it for the Initiatives rollup.
 *  It used to sum lifetime cost there while the ledger summed month-to-date,
 *  so the same initiative showed two different "agent spend" figures on two
 *  unlabelled surfaces (p-llm-platform: $4.10 on Initiatives, $3.75 here) and
 *  clicking between them looked like the number had moved. Lifetime spend also
 *  answers nothing this product asks: the only ceiling that exists is
 *  initiative_budgets.allocated_usd, which is monthly, so a monotonically
 *  growing total can never be judged against anything. One window, everywhere,
 *  labelled with the month on both pages. */
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

// ─── Mock fixtures (config.mock.aurora === true) ─────────────────────────────
//
// These used to return empty, which made the whole program surface — the
// ledger, the maintenance floor, the sprint envelopes — look broken rather
// than offline whenever Aurora was unavailable. The figures mirror
// schema/seed_program.sql: allocations derived from the sprint grants they
// fund, spend dominated by the cron maintenance floor, and one initiative
// spending with no allocation so the blind-spot signal is demonstrable.

export interface MockBudget {
  id: string; name: string; allocated: number | null; spent: number; runs: number; maintenance: number;
  /** Hours since this initiative's last attributed run. Per-initiative rather
   *  than one flat stub because providers/projects.ts renders the same
   *  timestamp as the Initiatives page's liveness — a constant here would make
   *  every card on that page claim the identical last-activity. Mirrors
   *  MOCK_INITIATIVES.activeHoursAgo there; the parity test pins the pair. */
  activityHoursAgo: number;
}

/** Exported so providers/projects.ts can render the SAME spend figure on the
 *  Initiatives rollup that this ledger renders. Mock mode used to return
 *  `agentSpendUsd: null` there while showing money here, so `dev:mock` said
 *  "no agent runs yet" on one page beside $19.77 spent on the other. */
export const MOCK_BUDGETS: MockBudget[] = [
  { id: 'p-observability',     name: 'Observability Platform',   allocated: 60, spent: 4.12, runs: 14, maintenance: 2.74, activityHoursAgo: 1 },
  { id: 'p-llm-platform',      name: 'LLM Application Platform', allocated: 45, spent: 6.38, runs: 11, maintenance: 4.10, activityHoursAgo: 2 },
  { id: 'p-auth-migration',    name: 'Auth Migration',           allocated: 35, spent: 2.91, runs: 9,  maintenance: 1.70, activityHoursAgo: 3 },
  { id: 'p-cost-opt',          name: 'Cost Optimization',        allocated: 30, spent: 2.05, runs: 12, maintenance: 1.83, activityHoursAgo: 5 },
  { id: 'p-soc2',              name: 'SOC2 Compliance',          allocated: 18, spent: 0.94, runs: 8,  maintenance: 0.94, activityHoursAgo: 14 },
  { id: 'p-feature-store',     name: 'ML Feature Store',         allocated: 18, spent: 1.55, runs: 7,  maintenance: 1.39, activityHoursAgo: 12 },
  // Spending with no allocation — the blind spot the ledger exists to surface.
  { id: 'p-inference-platform', name: 'Inference Platform',      allocated: null, spent: 1.82, runs: 7, maintenance: 1.82, activityHoursAgo: 7 },
];

export function mockBudgetRow(m: MockBudget): BudgetRow {
  return {
    orgProjectId: m.id,
    orgProjectName: m.name,
    allocatedUsd: m.allocated,
    period: m.allocated == null ? null : 'monthly',
    updatedBy: m.allocated == null ? null : 'u-release',
    updatedAt: m.allocated == null ? null : new Date(Date.now() - 6 * 86_400_000).toISOString(),
    spentThisPeriodUsd: m.spent,
    runCountThisPeriod: m.runs,
    lastAgentActivityAt: new Date(Date.now() - m.activityHoursAgo * 3_600_000).toISOString(),
    maintenanceUsd: m.maintenance,
  };
}

/** Exported so providers/sprints.ts reads envelope figures from here rather
 *  than restating them — one envelope, one number, on both surfaces. */
export const MOCK_GRANTS: Array<Omit<GrantRow, 'orgProjectName'>> = [
  { id: 'bg-obs-3', orgProjectId: 'p-observability', granteePersonId: 'p-008', granteeName: 'Layla Hassan',
    sprintId: 'spr-obs-s3', sprintName: 'Sprint 98 — Span metrics + decom', startsOn: null, endsOn: null,
    sprintStatus: 'active', allocatedUsd: 30, grantedBy: 'u-release', initiativeSpendInWindowUsd: 2.74 },
  { id: 'bg-llm-2', orgProjectId: 'p-llm-platform', granteePersonId: 'p-013', granteeName: 'Caleb Turner',
    sprintId: 'spr-llm-s2', sprintName: 'Sprint 8 — Judge + evals', startsOn: null, endsOn: null,
    sprintStatus: 'active', allocatedUsd: 35, grantedBy: 'u-release', initiativeSpendInWindowUsd: 4.10 },
  { id: 'bg-auth-2', orgProjectId: 'p-auth-migration', granteePersonId: 'p-051', granteeName: 'Nora Chang',
    sprintId: 'spr-auth-s2', sprintName: 'Sprint 42 — Session hygiene', startsOn: null, endsOn: null,
    sprintStatus: 'active', allocatedUsd: 20, grantedBy: 'u-release', initiativeSpendInWindowUsd: 1.70 },
  { id: 'bg-cost-2', orgProjectId: 'p-cost-opt', granteePersonId: 'p-017', granteeName: 'Daniel Chang',
    sprintId: 'spr-cost-s2', sprintName: 'Sprint 24 — Attribution', startsOn: null, endsOn: null,
    sprintStatus: 'active', allocatedUsd: 20, grantedBy: 'u-release', initiativeSpendInWindowUsd: 1.83 },
];

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
    maintenanceUsd: toNum(r['maintenance_usd']),
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
             -- The cron subset: the maintenance floor, not a separate bucket.
             COALESCE(SUM(br.cost_usd) FILTER (WHERE br.trigger = 'cron'), 0)::float8
               AS maintenance_usd
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
           -- Liveness is UNwindowed, deliberately, and must stay that way:
           -- "when did an agent last touch this" is not a money question, and
           -- taking it from the month-windowed CTE above made an initiative
           -- dormant since last month read "26d ago" here and "never" on the
           -- Initiatives rollup (providers/projects.ts), which computes the
           -- same fact lifetime. Same attribution predicate, no period bound —
           -- so the two pages now answer identically. The spend columns beside
           -- it stay month-to-date; that split is the point.
           (SELECT MAX(br.started_at) FROM bot_runs br
             WHERE (${spendPredicateSql('ids.org_project_id')})) AS last_agent_activity_at,
           COALESCE(ps.maintenance_usd, 0)::float8 AS maintenance_usd
      FROM ids
      LEFT JOIN initiative_budgets ib ON ib.org_project_id = ids.org_project_id
      LEFT JOIN period_spend ps ON ps.org_project_id = ids.org_project_id
      LEFT JOIN projects p ON p.id = ids.org_project_id
      ${scope}
     ORDER BY COALESCE(ps.spent_this_period_usd, 0) DESC, ids.org_project_id`;
}

// ─── Provider functions ──────────────────────────────────────────────────────

export async function listBudgets(): Promise<BudgetRow[]> {
  if (config.mock.aurora) return MOCK_BUDGETS.map(mockBudgetRow);
  const rows = await safeExec(budgetSelectSql(false));
  return rows.map(rowToBudget);
}

export async function getBudget(orgProjectId: string): Promise<BudgetRow | null> {
  if (config.mock.aurora) {
    const m = MOCK_BUDGETS.find((b) => b.id === orgProjectId);
    return m ? mockBudgetRow(m) : null;
  }
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

// ─── Sprint envelopes ────────────────────────────────────────────────────────

export interface GrantRow {
  id: string;
  orgProjectId: string;
  orgProjectName: string | null;
  granteePersonId: string;
  granteeName: string | null;
  sprintId: string | null;
  sprintName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  sprintStatus: string | null;
  allocatedUsd: number;
  grantedBy: string | null;
  /** Spend attributed to the INITIATIVE inside this envelope's sprint window.
   *  Deliberately not called the grantee's burn: bot_runs record which
   *  initiative and which bot, never which person's envelope paid for them, so
   *  attributing this to the SME would be a number we cannot support. */
  initiativeSpendInWindowUsd: number;
}

/** Envelopes, newest sprint first. Scoped to one initiative when given. */
export async function listGrants(orgProjectId?: string): Promise<GrantRow[]> {
  if (config.mock.aurora) {
    const named = MOCK_GRANTS.map((g) => ({
      ...g,
      orgProjectName: MOCK_BUDGETS.find((b) => b.id === g.orgProjectId)?.name ?? null,
    }));
    return orgProjectId ? named.filter((g) => g.orgProjectId === orgProjectId) : named;
  }
  const params: SqlParameter[] = [];
  let scope = '';
  if (orgProjectId) {
    scope = 'WHERE g.org_project_id = :pid';
    params.push(s('pid', orgProjectId));
  }
  const rows = await safeExec(
    `SELECT g.id, g.org_project_id, p.name AS org_project_name,
            g.grantee_person_id, pe.name AS grantee_name,
            g.sprint_id, sp.name AS sprint_name,
            sp.starts_on::text AS starts_on, sp.ends_on::text AS ends_on,
            sp.status AS sprint_status,
            g.allocated_usd::float8 AS allocated_usd, g.granted_by,
            COALESCE((
              SELECT SUM(br.cost_usd)::float8 FROM bot_runs br
               WHERE (${spendPredicateSql('g.org_project_id')})
                 AND (sp.starts_on IS NULL OR br.started_at >= sp.starts_on)
                 AND (sp.ends_on   IS NULL OR br.started_at < sp.ends_on + 1)
            ), 0)::float8 AS window_spend_usd
       FROM budget_grants g
       LEFT JOIN projects p  ON p.id = g.org_project_id
       LEFT JOIN people  pe  ON pe.id = g.grantee_person_id
       LEFT JOIN sprints sp  ON sp.id = g.sprint_id
       ${scope}
      ORDER BY sp.starts_on DESC NULLS LAST, g.created_at DESC`,
    params,
  );
  return rows.map((r) => ({
    id: toStr(r['id']),
    orgProjectId: toStr(r['org_project_id']),
    orgProjectName: r['org_project_name'] != null ? toStr(r['org_project_name']) : null,
    granteePersonId: toStr(r['grantee_person_id']),
    granteeName: r['grantee_name'] != null ? toStr(r['grantee_name']) : null,
    sprintId: r['sprint_id'] != null ? toStr(r['sprint_id']) : null,
    sprintName: r['sprint_name'] != null ? toStr(r['sprint_name']) : null,
    startsOn: r['starts_on'] != null ? toStr(r['starts_on']) : null,
    endsOn: r['ends_on'] != null ? toStr(r['ends_on']) : null,
    sprintStatus: r['sprint_status'] != null ? toStr(r['sprint_status']) : null,
    allocatedUsd: toNum(r['allocated_usd']),
    grantedBy: r['granted_by'] != null ? toStr(r['granted_by']) : null,
    initiativeSpendInWindowUsd: toNum(r['window_spend_usd']),
  }));
}

// ─── Org summary ─────────────────────────────────────────────────────────────

export async function orgSummary(): Promise<OrgBudgetSummary> {
  const empty: OrgBudgetSummary = {
    totalAllocatedUsd: 0, totalSpentThisPeriodUsd: 0, totalMaintenanceUsd: 0,
    byModel: [], byTrigger: [],
  };
  if (config.mock.aurora) {
    // Totals sum the same fixtures, so the tiles and the table agree. Both
    // breakdowns sum to totalSpentThisPeriodUsd as well — they are two cuts of
    // one set of runs, and a demo where the by-model card and the by-trigger
    // card add up to different money is the same defect this module exists to
    // avoid. (The by-trigger manual row absorbs the remainder for that reason.)
    const sum = (f: (b: MockBudget) => number) => MOCK_BUDGETS.reduce((n, b) => n + f(b), 0);
    const spent = Number(sum((b) => b.spent).toFixed(2));
    const cron = Number(sum((b) => b.maintenance).toFixed(2));
    const marketplace = 4.31;
    return {
      totalAllocatedUsd: sum((b) => b.allocated ?? 0),
      totalSpentThisPeriodUsd: spent,
      totalMaintenanceUsd: cron,
      byModel: [
        { model: 'us.amazon.nova-lite-v1:0', spentUsd: Number((spent * 0.72).toFixed(2)), runCount: 54 },
        { model: 'us.amazon.nova-pro-v1:0', spentUsd: Number((spent - Number((spent * 0.72).toFixed(2))).toFixed(2)), runCount: 14 },
      ],
      byTrigger: [
        { trigger: 'cron', spentUsd: cron, runCount: 52 },
        { trigger: 'marketplace', spentUsd: marketplace, runCount: 11 },
        { trigger: 'manual', spentUsd: Number((spent - cron - marketplace).toFixed(2)), runCount: 5 },
      ],
    };
  }

  // Totals: allocation from the ledger; spend is ALL bot_runs cost this
  // period, attributed or not — the org total must not hide spend that no
  // initiative predicate happens to claim.
  const totals = await safeExec(
    `SELECT
       (SELECT COALESCE(SUM(allocated_usd), 0)::float8 FROM initiative_budgets) AS total_allocated,
       (SELECT COALESCE(SUM(cost_usd), 0)::float8 FROM bot_runs
         WHERE started_at >= ${PERIOD_START_SQL}) AS total_spent,
       (SELECT COALESCE(SUM(cost_usd), 0)::float8 FROM bot_runs
         WHERE started_at >= ${PERIOD_START_SQL} AND trigger = 'cron') AS total_maintenance`,
  );

  // By-model used to INNER JOIN agent_project_runs on br.run_id, on the
  // reasoning that "agent_jobs carries no reliable model column". That is no
  // longer true, and the join made the card permanently empty: every seeded
  // bot_run is a cron firing linked by job_id, so run_id was null on all of
  // them and the query returned [] beside a fully-populated by-trigger card.
  //
  // The model is recoverable for a job-backed run from two places that are
  // written, not inferred:
  //   1. agent_jobs.payload->>'model' — bot-runner.ts enqueues the bot's model
  //      into the payload precisely so the dispatcher cannot silently
  //      substitute its default (lib/bot-runner.ts, `model: bot.model`);
  //   2. bots.model — NOT NULL in agent_bots_schema.sql, so every run with a
  //      bot behind it has one.
  // agent_project_runs.model still wins where present: it records what the
  // governed run actually used, rather than what it was asked to use.
  //
  // Every joined table is LEFT and nothing is filtered on the resolved model,
  // so by-model now covers the same rows as by-trigger and the two cards sum
  // to the same total. Spend whose model cannot be resolved from any of the
  // three (a firing with no bot, no run and no job) groups as 'unknown' rather
  // than vanishing — an unattributable dollar is a thing to show, not hide.
  const byModel = await safeExec(
    `SELECT COALESCE(apr.model, aj.payload->>'model', b.model, 'unknown') AS model,
            COALESCE(SUM(br.cost_usd), 0)::float8 AS spent_usd,
            COUNT(*)::int AS run_count
       FROM bot_runs br
       LEFT JOIN agent_project_runs apr ON apr.id = br.run_id
       LEFT JOIN agent_jobs aj ON aj.id = br.job_id
       LEFT JOIN bots b ON b.id = br.bot_id
      WHERE br.started_at >= ${PERIOD_START_SQL}
        AND br.cost_usd IS NOT NULL
      GROUP BY 1
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
    totalMaintenanceUsd: toNum(totals[0]?.['total_maintenance']),
    byModel: byModel.map((r) => ({
      model: toStr(r['model']), spentUsd: toNum(r['spent_usd']), runCount: toNum(r['run_count']),
    })),
    byTrigger: byTrigger.map((r) => ({
      trigger: toStr(r['trigger']), spentUsd: toNum(r['spent_usd']), runCount: toNum(r['run_count']),
    })),
  };
}
