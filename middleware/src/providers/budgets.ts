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
// The mock ledger's rows. Imported for VALUES, but only ever read inside a
// function body — bots.ts imports spendPredicateSql back out of this module, so
// the two form an ES module cycle and a module-scope read here would hit the
// other side's temporal dead zone depending on which was loaded first. Every
// use below is lazy for that reason. (spendPredicateSql is a hoisted function
// declaration, which is why the edge in the other direction is already safe.)
import { MOCK_BOTS, mockAllRuns, mockRunsAttributedTo, type BotRun } from './bots.js';
// The sprint calendar. Its own module (not sprints.ts) because sprints.ts
// already imports this one — see providers/sprintWindows.ts's header.
import { mockSprintDates } from './sprintWindows.js';
import { clock, sumBy, groupBy } from '../mock/core/index.js';
// The registered fixtures behind this module's mock branches. `MOCK_BUDGETS` is
// re-exported from mock/budgets.ts below; the grant rows are projected through
// `mockGrant` on the way out, so only columns are ever stored.
import { budgetGrants, initiativeBudgets, MOCK_BUDGETS } from '../mock/budgets.js';
import { liveArrayView } from '../mock/live-view.js';
// Mock-mode only, and read-only: the projects join an allocation's read-back
// gets for free. Lazy like every other use in this module — see the note on the
// bots.ts import above for why nothing here may read at module scope.
import { mockProjectName } from './projects.js';
import { displayNameForSubject } from './identity.js';

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
  /** The person behind `updatedBy`, resolved from app_users (Aurora) or the
   *  seed cast (mock). Null when the subject is unknown — the ledger then
   *  shows the raw subject rather than inventing a name. */
  updatedByName: string | null;
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
  /** ALLOCATION ONLY. Spend, run count and the maintenance floor are NOT
   *  fields here: they are summed from bot_runs at read time
   *  (`mockInitiativeSpend` below), because a total written beside the rows it
   *  claims to count is right the day it is typed and wrong the first time
   *  either side moves. This fixture carried `spent`/`runs`/`maintenance` for
   *  months and every one of them had drifted off its own run history — see the
   *  section header below. An allocation is genuinely stored (it is a column in
   *  initiative_budgets), so it stays. */
  id: string; name: string; allocated: number | null;
  /** Hours since this initiative's last attributed run. Per-initiative rather
   *  than one flat stub because providers/projects.ts renders the same
   *  timestamp as the Initiatives page's liveness — a constant here would make
   *  every card on that page claim the identical last-activity. Mirrors
   *  MOCK_INITIATIVES.activeHoursAgo there; the parity test pins the pair. */
  /** Who last moved the allocation and when. Unset on a seeded row (the seed
   *  reads as the release manager, six days ago); set by `upsertAllocation`
   *  so a write reads back attributed to the session that made it — the
   *  Aurora path stores `updated_by`/`updated_at` and the ledger renders them,
   *  so an offline write that kept naming the seed author was a lie. */
  updatedBy?: string | null;
  updatedAt?: string | null;
}

/**
 * The allocations, live.
 *
 * The rows are the REGISTERED `initiative-budgets` fixture (mock/budgets.ts).
 * They were an array literal here, and nothing could put them back — so
 * `PUT /api/budgets/:id` had no mock branch at all (it 503'd) and there was no
 * honest way to give it one: a write that mutates a module array cannot be
 * undone by `POST /api/__mock/reset`, which is why every offline audit that
 * touched the ledger had to warn the next auditor in its log.
 *
 * The NAME stays, because it is a real cross-module API — providers/projects.ts
 * renders the SAME spend figure on the Initiatives rollup that this ledger
 * renders (mock mode used to return `agentSpendUsd: null` there while showing
 * money here, so dev:mock said "no agent runs yet" on one page beside $19.77
 * spent on the other). It is a live VIEW onto the fixture now; see
 * mock/live-view.ts for why a captured array would go stale after a reset.
 */
export { MOCK_BUDGETS } from '../mock/budgets.js';


// ─── Mock spend, DERIVED from bot_runs (never stored) ────────────────────────
//
// `spentThisPeriodUsd`, `runCountThisPeriod` and `maintenanceUsd` used to be
// typed onto each MOCK_BUDGETS row. Every one of them had drifted off the run
// history the Bots pages render from the same process: p-observability claimed
// $4.12 over nine runs summing $1.91, p-cost-opt claimed 12 runs over a bot
// with two. Nothing could have caught it, because the number and the rows were
// never compared. They are now the same arithmetic Aurora does, over the same
// rows — bots.ts's MOCK_BOT_RUNS — so they cannot disagree again.
//
// Three deliberate fidelity choices:
//
//  1. The window is the CALENDAR MONTH, matching PERIOD_START_SQL. That is what
//     `…ThisPeriod` means, and it is what a real cluster carrying
//     schema/seed_program.sql returns: the seed dates its bot_runs `NOW() -
//     INTERVAL 'N days'` across ~30 days, so on the 7th of a month most of that
//     history is last month's money and does not count here. The mock's stored
//     totals were month-independent, which is a shape Aurora cannot produce.
//  2. Attribution is spendPredicateSql's arms, resolved row by row, in
//     bots.ts's `mockRunsAttributedTo` — one resolver, shared with the activity
//     graph, rather than a copy per surface. Arm 1 (via the run's work item)
//     matches every marketplace dispatch this process recorded; no seeded run
//     carries a work_item_id, so on a freshly booted process only arm 2 fires.
//     Arm 3 (bot → agent_project → initiative) can match nothing here — no mock
//     bot carries an agentProjectId — and is written out rather than silently
//     dropped, so the difference from the SQL is visible.
//  3. `cost_usd IS NOT NULL` is the predicate's own first clause: a run still in
//     flight has posted no cost and has spent nothing yet.
//
// Scope: the seeded history AND every run this process recorded — attribution
// is resolved once, in bots.ts's `mockRunsAttributedTo`, which both this module
// and the activity graph read. It used to read the seeded history only, on the
// reasoning that live rows were reachable only through async readers while
// providers/projects.ts rendered `agentSpendUsd` from `mockBudgetRow` inside a
// synchronous `.map`. The consequence was two answers again, just quieter than
// before: dispatch a run in dev:mock and the initiative's activity graph moved
// (providers/activity.ts DID count marketplace runs) while Initiatives and
// Budgets sat still. One bot_runs table, three readers, three totals.
// `mockRunsAttributedTo` is synchronous — see its header for why that is a
// requirement rather than a shortcut — so the "Initiatives and Budgets report
// the same money" invariant holds with live spend included, not instead of it.

/** `bot_runs.cost_usd` is NUMERIC(10,4). Every mock sum rounds to that scale
 *  and no further: four decimals is the precision the column actually holds,
 *  so it is the precision Postgres returns and the only one at which the mock
 *  and the real query can agree. */
const COST_SCALE = 4;

/** Start of the current budget period — the fixture analogue of
 *  PERIOD_START_SQL (`date_trunc('month', NOW())`, in a UTC session). Read
 *  through the mock clock so a frozen test sees a frozen period. */
function periodStartMs(): number {
  const now = clock.now();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
}

/** Costed runs only — `cost_usd IS NOT NULL`. */
function costed(runs: readonly BotRun[]): BotRun[] {
  return runs.filter((r) => r.costUsd != null);
}

export interface MockInitiativeSpend {
  spentUsd: number;
  runCount: number;
  maintenanceUsd: number;
}

/** This period's spend, run count and cron floor for one initiative, summed
 *  from its own runs. The mock analogue of budgetSelectSql's `period_spend`. */
/**
 * The last moment an agent run was attributed to this initiative, or null.
 *
 * Mirrors the live query's `(SELECT MAX(br.started_at) FROM bot_runs br WHERE
 * <attribution>)` in `providers/projects.ts` — note it is deliberately NOT
 * period-filtered, exactly as that subquery is not. An initiative whose last
 * run was in August honestly reports an August date beside a zero count for
 * September; what it can no longer do is report activity no run backs.
 *
 * This replaced a hand-typed `activityHoursAgo` on each fixture row, which is
 * the mock floor's rule 2 — "a fixture exports rows and selectors, never a
 * number it could have counted from rows it also exports". Because it was
 * typed rather than counted, it drifted from the runs beside it: two
 * initiatives rendered "0 runs this period" next to "last activity 2d ago",
 * with 2d ago inside the period and no run anywhere behind it.
 */
export function mockLastAgentActivityAt(orgProjectId: string): string | null {
  const runs = mockRunsAttributedTo(orgProjectId);
  if (runs.length === 0) return null;
  return runs.reduce(
    (latest, r) => (Date.parse(r.startedAt) > Date.parse(latest) ? r.startedAt : latest),
    runs[0]!.startedAt,
  );
}

export function mockInitiativeSpend(orgProjectId: string): MockInitiativeSpend {
  const start = periodStartMs();
  const runs = costed(mockRunsAttributedTo(orgProjectId))
    .filter((r) => Date.parse(r.startedAt) >= start);
  return {
    // COST_SCALE, not 2. `cost_usd` is NUMERIC(10,4) and the seed writes four
    // decimals (0.1739, 0.0341), so Postgres sums them EXACTLY and returns
    // four; rounding to cents here would report $0.31 where Aurora reports
    // $0.3148, and — worse — would make a sum of rounded rows disagree with a
    // rounded sum of rows by up to half a cent per initiative, so the ledger's
    // rows would stop adding up to its own org total. The rounding still earns
    // its place: it strips float noise (0.1739 + 0.1409 is 0.31480000000000002
    // in binary), which is all it was ever for. Same scale bots.ts's
    // mockDispatchedSpend already uses. Presentation rounding is the portal's.
    spentUsd: sumBy(runs, 'costUsd', { digits: COST_SCALE }),
    runCount: runs.length,
    // The cron SUBSET of the same rows, never a separate bucket —
    // `SUM(cost_usd) FILTER (WHERE trigger = 'cron')`.
    maintenanceUsd: sumBy(runs.filter((r) => r.trigger === 'cron'), 'costUsd', { digits: COST_SCALE }),
  };
}

/**
 * Initiative spend inside an arbitrary window — what a sprint envelope's
 * `initiativeSpendInWindowUsd` is. Bounds mirror listGrants' subquery exactly:
 * `starts_on` inclusive, `ends_on` exclusive at +1 day (ends_on is a DATE and a
 * sprint ends ON that day), and a null bound is unbounded on that side.
 */
export function mockInitiativeWindowSpendUsd(
  orgProjectId: string,
  startsOn: string | null,
  endsOn: string | null,
): number {
  const from = startsOn ? Date.parse(`${startsOn}T00:00:00Z`) : null;
  const toExclusive = endsOn ? Date.parse(`${endsOn}T00:00:00Z`) + 86_400_000 : null;
  const runs = costed(mockRunsAttributedTo(orgProjectId)).filter((r) => {
    const at = Date.parse(r.startedAt);
    if (from != null && at < from) return false;
    if (toExclusive != null && at >= toExclusive) return false;
    return true;
  });
  return sumBy(runs, 'costUsd', { digits: COST_SCALE });
}

/**
 * Every costed run in the current period, carrying the model it should be
 * grouped under — the rows behind the org-wide summary's two breakdown cards.
 *
 * UNattributed, deliberately: the Aurora total is `SUM(cost_usd) FROM bot_runs
 * WHERE started_at >= period`, with no initiative predicate at all, because
 * the org total must not hide spend that no initiative happens to claim. A
 * marketplace dispatch for an initiative absent from the ledger still cost
 * money.
 *
 * The model resolves the way the SQL's COALESCE does: the bot's model where a
 * bot is behind the run, and `'unknown'` otherwise. A marketplace dispatch has
 * no bot, and the mock records no per-run model, so it groups as unknown —
 * which is the same answer the real query's last fallback gives, and an
 * unattributable dollar is a thing to show rather than hide.
 */
function mockPeriodRuns(): Array<{ run: BotRun; model: string }> {
  const start = periodStartMs();
  const modelByBot = new Map(MOCK_BOTS.map((b) => [b.id, b.model]));
  return costed(mockAllRuns())
    .filter((run) => Date.parse(run.startedAt) >= start)
    .map((run) => ({ run, model: (run.botId && modelByBot.get(run.botId)) || 'unknown' }));
}

export function mockBudgetRow(m: MockBudget): BudgetRow {
  const spend = mockInitiativeSpend(m.id);
  return {
    orgProjectId: m.id,
    orgProjectName: m.name,
    allocatedUsd: m.allocated,
    period: m.allocated == null ? null : 'monthly',
    updatedBy: m.allocated == null ? null : (m.updatedBy ?? 'u-release'),
    updatedByName: m.allocated == null ? null : displayNameForSubject(m.updatedBy ?? 'u-release'),
    updatedAt: m.allocated == null ? null : (m.updatedAt ?? new Date(clock.now().getTime() - 6 * 86_400_000).toISOString()),
    spentThisPeriodUsd: spend.spentUsd,
    runCountThisPeriod: spend.runCount,
    lastAgentActivityAt: mockLastAgentActivityAt(m.id),
    maintenanceUsd: spend.maintenanceUsd,
  };
}

/** The seed shape: everything a `budget_grants` row actually stores. The burn
 *  is NOT in here — see `mockGrant` below. Neither are the window dates: a
 *  grant row in Aurora has no start or end of its own, it JOINS the sprint for
 *  them (`sp.starts_on`, `sp.ends_on` in listGrants), so the fixture reads them
 *  from the sprint calendar rather than restating them per grant. */
export type MockGrantSeed =
  Omit<GrantRow, 'orgProjectName' | 'initiativeSpendInWindowUsd' | 'startsOn' | 'endsOn'>;

/**
 * A seed envelope, with `initiativeSpendInWindowUsd` attached as a **getter**
 * rather than a stored number.
 *
 * That field is derived on the Aurora side (a correlated SUM over bot_runs in
 * the sprint window — see listGrants), and it was typed by hand here: three of
 * the six rows claimed $1.70/$2.74/$4.10 against run histories that sum to
 * something else entirely, and bg-auth-2 and bg-auth-3 each claimed the SAME
 * $1.70 of p-auth-migration spend, which is one initiative's money counted
 * twice by anything that adds envelopes up.
 *
 * A getter and not a plain selector function because `mergedMockGrants()`
 * (providers/grantOverlay.ts) hands these rows on by spreading them, and a
 * spread reads a getter — so the number is recomputed at every read, through
 * every reader, without any of them having to know. Nothing is stored, so
 * nothing can drift.
 *
 * `startsOn`/`endsOn` are getters for a second reason: THE WINDOW WAS MISSING.
 * Every seed row carried `startsOn: null, endsOn: null`, and a null bound is
 * unbounded on that side — in the SQL and in the mock alike — so "spend inside
 * this envelope's sprint window" was really the initiative's LIFETIME spend.
 * The sprint page beside it windowed the same money correctly, so one envelope
 * reported two figures, and lib/bot-runner.ts's envelope brake burned an SME
 * down against a total that could only ever grow. The dates were never
 * missing; they were in the sprint fixture, one module away — now
 * providers/sprintWindows.ts, read here by sprint id. Derived at read time so
 * the window slides with the clock exactly as `NOW() - INTERVAL '14 days'`
 * does, instead of freezing at import.
 */
function mockGrant(seed: MockGrantSeed): Omit<GrantRow, 'orgProjectName'> {
  const dates = (): { startsOn: string; endsOn: string } | null => mockSprintDates(seed.sprintId);
  return {
    ...seed,
    get startsOn(): string | null { return dates()?.startsOn ?? null; },
    get endsOn(): string | null { return dates()?.endsOn ?? null; },
    get initiativeSpendInWindowUsd(): number {
      const d = dates();
      return mockInitiativeWindowSpendUsd(seed.orgProjectId, d?.startsOn ?? null, d?.endsOn ?? null);
    },
  };
}

/**
 * The seed envelopes, live and projected.
 *
 * The rows are the REGISTERED `budget-grants` fixture (mock/budgets.ts), which
 * stores COLUMNS only; `mockGrant` puts the derived fields back on as getters
 * on the way out. That is what makes a create, a patch and a revoke undoable:
 * they mutate the fixture directly (providers/grantOverlay.ts) instead of
 * writing into a side Map that a reset could never reach.
 *
 * Exported so providers/sprints.ts reads envelope figures from here rather than
 * restating them — one envelope, one number, on both surfaces.
 */
export const MOCK_GRANTS: Array<Omit<GrantRow, 'orgProjectName'>> =
  liveArrayView(() => budgetGrants.rows().map(mockGrant));


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
    updatedByName: r['updated_by_name'] != null ? toStr(r['updated_by_name']) : null,
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
           au.display_name AS updated_by_name,
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
      -- updated_by is a session subject; the ledger renders the person.
      LEFT JOIN app_users au ON au.id = ib.updated_by
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
  if (config.mock.aurora) {
    // Used to `return null`, which routes/budgets.ts reads as "no Aurora" and
    // answers 503 — so a release manager could not move an allocation offline
    // at all, and the ledger's central write was undemonstrable. The upsert is
    // the statement below, evaluated against the fixture: an existing row is
    // updated in place (ON CONFLICT DO UPDATE), a new initiative is appended
    // (INSERT). `POST /api/__mock/reset` puts the seeded allocations back.
    const rows = initiativeBudgets.rows();
    const existing = rows.find((b) => b.id === orgProjectId);
    const stamp = clock.now().toISOString();
    if (existing) {
      existing.allocated = allocatedUsd;
      existing.updatedBy = updatedBy;
      existing.updatedAt = stamp;
    } else {
      rows.push({
        id: orgProjectId,
        // The projects join the read-back does. Null rather than invented when
        // the initiative is outside the mock corpus — the ledger renders the id
        // in that case, which is the honest answer.
        name: mockProjectName(orgProjectId) ?? orgProjectId,
        allocated: allocatedUsd,
        updatedBy,
        updatedAt: stamp,
      });
    }
    // Re-read through the list shape, exactly as the Aurora path does, so the
    // response carries this-period spend rather than just the number written.
    return getBudget(orgProjectId);
  }
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
  if (config.mock.aurora) {
    // `false` here means "nothing matched", which the route answers 404 to — so
    // DELETE was indistinguishable from a bad id offline. The DELETE ...
    // RETURNING below returns rows only when one matched, and so does this.
    const rows = initiativeBudgets.rows();
    const at = rows.findIndex((b) => b.id === orgProjectId);
    if (at < 0) return false;
    rows.splice(at, 1);
    return true;
  }
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
  /** Optional free-text note on the grant (why this envelope). Optional so the
   *  many GrantRow literals (mocks) need not carry it; surfaced on read so the
   *  UI can display and correct it. */
  note?: string | null;
  /** Spend attributed to the INITIATIVE inside this envelope's sprint window.
   *  Deliberately not called the grantee's burn: bot_runs record which
   *  initiative and which bot, never which person's envelope paid for them, so
   *  attributing this to the SME would be a number we cannot support. */
  initiativeSpendInWindowUsd: number;
}

/** Envelopes, newest sprint first. Scoped to one initiative when given. */
export async function listGrants(orgProjectId?: string): Promise<GrantRow[]> {
  if (config.mock.aurora) {
    // Through the OVERLAY, not the raw seed. providers/grantOverlay.ts is the
    // record of every mock create/patch/revoke, and its own header says to
    // read it "anywhere a mutation should be visible" — this reader was left
    // behind when sprints.ts was fixed, and it is the one the sprint-envelope
    // brake consumes (lib/bot-runner.ts's loadEnvelope calls this function).
    // So a release manager could re-allocate an envelope in dev:mock, see the
    // new amount on /api/grants and /api/sprints, and have the brake keep
    // judging the SME against the seeded amount.
    //
    // Imported dynamically because grantOverlay.ts imports MOCK_GRANTS from
    // this module: a static edge back would close a cycle. Same reason the
    // overlay lives in its own file at all.
    const { mergedMockGrants } = await import('./grantOverlay.js');
    // Recomputed on the way out, not trusted from the row. A seed row carries
    // the burn as a getter (mockGrant above), but the overlay stores whatever
    // shape a create/patch produced — a plain spread flattens the getter into
    // a frozen number. Deriving here means every row on this path is summed
    // from bot_runs at read time, whichever half of the merge it came from.
    const named = mergedMockGrants().map((g) => ({
      ...g,
      initiativeSpendInWindowUsd: mockInitiativeWindowSpendUsd(g.orgProjectId, g.startsOn, g.endsOn),
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
            g.allocated_usd::float8 AS allocated_usd, g.granted_by, g.note,
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
    note: r['note'] != null ? toStr(r['note']) : null,
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
    // Every number here is now one cut or another of ONE row set — this
    // period's costed bot_runs — so the tiles, the by-model card and the
    // by-trigger card add up to the same money by construction rather than by
    // arithmetic that has to be kept in agreement. It used to be the latter:
    // the by-model split was `spent * 0.72`, marketplace was a flat $4.31, and
    // the manual row absorbed whatever was left over, with the run counts
    // (54/14, 52/11/5) typed beside totals derived from a different fixture
    // entirely. Deriving the totals from bot_runs would have driven that
    // leftover negative, which is how it came to light.
    //
    // Allocation stays a sum over MOCK_BUDGETS: an allocation is a stored
    // column (initiative_budgets.allocated_usd), not an aggregate of rows.
    const runs = mockPeriodRuns();
    const byModel = groupBy(runs, (r) => r.model);
    const byTrigger = groupBy(runs, (r) => r.run.trigger);
    const money = (rows: Array<{ run: BotRun }>): number =>
      sumBy(rows.map((r) => r.run), 'costUsd', { digits: COST_SCALE });
    return {
      totalAllocatedUsd: sumBy(MOCK_BUDGETS, (b) => b.allocated ?? 0, { digits: 2 }),
      totalSpentThisPeriodUsd: money(runs),
      totalMaintenanceUsd: money(runs.filter((r) => r.run.trigger === 'cron')),
      byModel: [...byModel].map(([model, rows]) => ({
        model, spentUsd: money(rows), runCount: rows.length,
      })).sort((a, b) => b.spentUsd - a.spentUsd),
      byTrigger: [...byTrigger].map(([trigger, rows]) => ({
        trigger, spentUsd: money(rows), runCount: rows.length,
      })).sort((a, b) => b.spentUsd - a.spentUsd),
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
