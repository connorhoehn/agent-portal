// Budget periods (DE-38, docs/deployment-enhancements/DE-38-budget-periods.md):
// the ONE definition of "the current budget window" for every money reader.
//
// Before this module the app had three windows that nothing aligned
// (docs/budget-system-analysis-2026-10-28.md §1): allocation spend was the
// calendar month, a sprint envelope burned over [starts_on, ends_on + 1), and
// the maintenance floor read a trailing 30 days. Now an initiative's
// allocation names its period, and every reader asks this module for it:
//
//   allocation brakes   providers/budgets.ts period_spend (via the SQL twin)
//   envelope burn       sprintBounds / sprintLowerSql / sprintUpperSql
//   reserve and floor   providers/budgets.ts floorHistorySql (this and the previous window)
//   user budgets        monthWindow / PERIOD_START_SQL (users stay calendar month)
//   spend report        the initiative's window for its drill-in; the month org-wide
//   Projects rollup     periodStartForSql (the same CTE as the ledger)
//
// Periods:
//   monthly    [date_trunc('month', now), +1 month), key YYYY-MM. The default,
//              and the window of every initiative with no allocation row.
//   quarterly  [date_trunc('quarter', now), +3 months), key YYYY-Qn.
//   sprint     the initiative's sprint whose [starts_on, ends_on + 1) contains
//              now, preferring status 'active', then the latest starts_on (then
//              the larger id, so the SQL and this module break ties alike). Key
//              = the sprint id. Between sprints there is NO current period: the
//              allocation is not in force (unbudgeted, no brake) and spend is
//              still summed over the calendar month so the figure stays
//              comparable — `state: 'between-sprints'`.
//   rolling    [now - rolling_days, now), no key, no close, no carry-over.
//
// Pure: no I/O and no clock reads. `now` is always an argument, so the mock
// (through mock/core/clock.ts) and the tests pin it. The SQL builders at the
// bottom are the twin of currentPeriod/previousPeriod and are checked against
// them on a real PostgreSQL in providers/__tests__/budget-periods-postgres.test.ts.

export const BUDGET_PERIODS = ['monthly', 'quarterly', 'sprint', 'rolling'] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

export const CARRY_OVER_POLICIES = ['none', 'unspent', 'overspend', 'both'] as const;
export type CarryOver = (typeof CARRY_OVER_POLICIES)[number];

/** The period of an initiative that has no allocation row, or never chose one. */
export const DEFAULT_PERIOD: BudgetPeriod = 'monthly';
/** Decision taken by default (DE-38): overspend and unspent money carry nowhere until a release manager opts in. */
export const DEFAULT_CARRY_OVER: CarryOver = 'none';

export const MIN_ROLLING_DAYS = 1;
export const MAX_ROLLING_DAYS = 366;

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

export function isBudgetPeriod(v: unknown): v is BudgetPeriod {
  return typeof v === 'string' && (BUDGET_PERIODS as readonly string[]).includes(v);
}
export function isCarryOver(v: unknown): v is CarryOver {
  return typeof v === 'string' && (CARRY_OVER_POLICIES as readonly string[]).includes(v);
}

export interface PeriodPolicy {
  period: BudgetPeriod;
  /** Required for 'rolling', ignored otherwise. */
  rollingDays?: number | null;
}

/** A sprint row as the window needs it (`sprints` columns; dates are DATE strings). */
export interface SprintSpan {
  id: string;
  startsOn: string | null;
  endsOn: string | null;
  status?: string | null;
}

export type WindowState = 'open' | 'between-sprints';

export interface BudgetWindow {
  /** The policy that produced this window. */
  period: BudgetPeriod;
  /** Inclusive. */
  start: Date;
  /** Exclusive. For rolling this is `now`. */
  end: Date;
  /** The close-row key: 'YYYY-MM', 'YYYY-Qn' or a sprint id. Null for rolling and between sprints. */
  key: string | null;
  state: WindowState;
}

// ─── Sprint bounds: the one convention every sprint-shaped window uses ──────

/**
 * A sprint's window in epoch ms: `starts_on` inclusive, `ends_on` inclusive as
 * a DATE and therefore exclusive at the next midnight. A null bound is
 * unbounded on that side (a standing grant). The envelope burn, the grant's
 * initiative spend and a sprint-period allocation all use this, so an envelope
 * and its initiative's allocation cover identical days.
 */
export function sprintBounds(startsOn: string | null, endsOn: string | null): { fromMs: number | null; toMs: number | null } {
  return {
    fromMs: startsOn ? Date.parse(`${startsOn}T00:00:00Z`) : null,
    toMs: endsOn ? Date.parse(`${endsOn}T00:00:00Z`) + DAY_MS : null,
  };
}

export function inBounds(atMs: number, b: { fromMs: number | null; toMs: number | null }): boolean {
  if (b.fromMs != null && atMs < b.fromMs) return false;
  if (b.toMs != null && atMs >= b.toMs) return false;
  return true;
}

/** `col >= starts` — the SQL twin of sprintBounds' lower edge. `startsRef` is a DATE expression. */
export function sprintLowerSql(col: string, startsRef: string): string {
  return `${col} >= ${startsRef}`;
}
/** `col < ends + 1` — the SQL twin of sprintBounds' upper edge (ends_on is inclusive). */
export function sprintUpperSql(col: string, endsRef: string): string {
  return `${col} < ${endsRef} + 1`;
}
/** Both edges, each unbounded when its DATE column is NULL (listGrants, the sprint list). */
export function sprintWindowSql(col: string, startsRef: string, endsRef: string): string {
  return `(${startsRef} IS NULL OR ${sprintLowerSql(col, startsRef)})
                 AND (${endsRef} IS NULL OR ${sprintUpperSql(col, endsRef)})`;
}

// ─── Calendar windows ────────────────────────────────────────────────────────

const pad2 = (n: number): string => String(n).padStart(2, '0');

export function monthWindow(now: Date, offset = 0): BudgetWindow {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + offset;
  const start = new Date(Date.UTC(y, m, 1));
  return {
    period: 'monthly', start, end: new Date(Date.UTC(y, m + 1, 1)),
    key: `${start.getUTCFullYear()}-${pad2(start.getUTCMonth() + 1)}`, state: 'open',
  };
}

export function quarterWindow(now: Date, offset = 0): BudgetWindow {
  const y = now.getUTCFullYear();
  const q0 = Math.floor(now.getUTCMonth() / 3) * 3 + offset * 3;
  const start = new Date(Date.UTC(y, q0, 1));
  return {
    period: 'quarterly', start, end: new Date(Date.UTC(y, q0 + 3, 1)),
    key: `${start.getUTCFullYear()}-Q${Math.floor(start.getUTCMonth() / 3) + 1}`, state: 'open',
  };
}

function rollingWindow(now: Date, days: number, offset = 0): BudgetWindow {
  const end = new Date(now.getTime() - offset * days * DAY_MS);
  return { period: 'rolling', start: new Date(end.getTime() - days * DAY_MS), end, key: null, state: 'open' };
}

function sprintWindow(s: SprintSpan): BudgetWindow {
  const b = sprintBounds(s.startsOn, s.endsOn);
  return { period: 'sprint', start: new Date(b.fromMs!), end: new Date(b.toMs!), key: s.id, state: 'open' };
}

const dated = (s: SprintSpan): boolean => s.startsOn != null && s.endsOn != null;
/** ORDER BY starts_on DESC, id DESC — the SQL's tie-break. */
const latestFirst = (a: SprintSpan, b: SprintSpan): number =>
  String(b.startsOn).localeCompare(String(a.startsOn)) || b.id.localeCompare(a.id);

/** The sprint whose window contains now: active first, then the latest start, then the larger id. */
export function currentSprint(sprints: readonly SprintSpan[], now: Date): SprintSpan | null {
  const at = now.getTime();
  const open = sprints.filter((s) => dated(s) && inBounds(at, sprintBounds(s.startsOn, s.endsOn)));
  open.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || latestFirst(a, b));
  return open[0] ?? null;
}

function rollingDaysOf(policy: PeriodPolicy): number {
  const d = Number(policy.rollingDays);
  return Number.isInteger(d) && d >= MIN_ROLLING_DAYS && d <= MAX_ROLLING_DAYS ? d : 30;
}

/**
 * The current window of a policy. `null` policy = no allocation row = monthly.
 * Between sprints the window is the calendar month marked `between-sprints`:
 * the spend figure stays comparable, and the allocation is not in force.
 */
export function currentPeriod(policy: PeriodPolicy | null, now: Date, sprints: readonly SprintSpan[] = []): BudgetWindow {
  const p = policy?.period ?? DEFAULT_PERIOD;
  if (p === 'quarterly') return quarterWindow(now);
  if (p === 'rolling') return rollingWindow(now, rollingDaysOf(policy!));
  if (p === 'sprint') {
    const s = currentSprint(sprints, now);
    if (s) return sprintWindow(s);
    return { ...monthWindow(now), period: 'sprint', key: null, state: 'between-sprints' };
  }
  return monthWindow(now);
}

/**
 * The window before the current one: the previous month or quarter, the
 * rolling window just behind this one, or the latest sprint that started before
 * the current sprint (null when there is none). Between sprints: the previous
 * month, matching the month fallback of currentPeriod. Feeds the auto reserve
 * (last period's essential spend) and the boundary close.
 */
export function previousPeriod(policy: PeriodPolicy | null, now: Date, sprints: readonly SprintSpan[] = []): BudgetWindow | null {
  const p = policy?.period ?? DEFAULT_PERIOD;
  if (p === 'quarterly') return quarterWindow(now, -1);
  if (p === 'rolling') return rollingWindow(now, rollingDaysOf(policy!), 1);
  if (p === 'sprint') {
    const cur = currentSprint(sprints, now);
    if (!cur) return { ...monthWindow(now, -1), period: 'sprint', key: null, state: 'between-sprints' };
    const before = sprints.filter((s) => dated(s) && String(s.startsOn) < String(cur.startsOn)).sort(latestFirst)[0];
    return before ? sprintWindow(before) : null;
  }
  return monthWindow(now, -1);
}

// ─── Carry-over ──────────────────────────────────────────────────────────────

export interface CarryPolicy {
  carryOver: CarryOver;
  /** Clamp |carry| to this; null = no clamp. */
  capUsd: number | null;
  /** Periods ending at or before this instant carry nothing (the policy was not in force). */
  since: Date | null;
}

export interface CloseInput {
  allocatedUsd: number;
  carryInUsd: number;
  /** Known spend in the period. Unknown-cost entries never block a close (DE-38 decision). */
  spentUsd: number;
  periodEnd: Date;
}

/**
 * The signed carry a closed period hands its successor: + unspent, - overspend.
 * `allocated + carry_in - spent`, filtered by the policy, clamped to ±cap, and
 * zero for a period that ended before the policy took effect.
 */
export function carryOut(i: CloseInput, p: CarryPolicy): number {
  if (p.carryOver === 'none') return 0;
  if (p.since && i.periodEnd.getTime() <= p.since.getTime()) return 0;
  let c = i.allocatedUsd + i.carryInUsd - i.spentUsd;
  if (p.carryOver === 'unspent' && c < 0) c = 0;
  if (p.carryOver === 'overspend' && c > 0) c = 0;
  if (p.capUsd != null) c = Math.max(-p.capUsd, Math.min(p.capUsd, c));
  return round4(c) + 0; // + 0 folds -0
}

/** What the brakes judge against: the allocation plus the carry in, never below zero. */
export function effectiveAllocation(allocatedUsd: number, carryInUsd: number): number {
  return Math.max(0, round4(allocatedUsd + carryInUsd));
}

/**
 * The allocation the brakes judge against: the effective figure once DE-38's
 * period fields are attached to a budget row, else the stored one (a row built
 * without them, e.g. a stub). Null = unbudgeted (no row, or between sprints).
 */
export function budgetedAllocation(row: { allocatedUsd: number | null; effectiveAllocatedUsd?: number | null }): number | null {
  return row.effectiveAllocatedUsd !== undefined ? row.effectiveAllocatedUsd : row.allocatedUsd;
}

/** Does this policy ever write a boundary close? Rolling never ends; 'none' carries nothing. */
export function closesAtBoundary(policy: PeriodPolicy & { carryOver: CarryOver }): boolean {
  return policy.period !== 'rolling' && policy.carryOver !== 'none';
}

// ─── The SQL twin ────────────────────────────────────────────────────────────

/** Start of the calendar month, in a UTC session. Org totals and user budgets stay on it. */
export const PERIOD_START_SQL = `date_trunc('month', NOW())`;

/**
 * A DE-38 column of `initiative_budgets ib`, read through the row's JSON so the
 * statement still parses on a cluster that has not applied
 * schema/budget_periods_schema.sql (the key is simply absent: NULL). No probe
 * is needed before a READ; only `ib.period` (always present) can name a
 * non-monthly window, and it can do so only after the migration widened its
 * CHECK. Writes still probe (periodsSupported in providers/budgets.ts).
 */
export function policyColumnSql(alias: string, column: (typeof PERIOD_COLUMNS)[number], cast: 'int' | 'text' | 'float8' | 'timestamptz'): string {
  return `(to_jsonb(${alias})->>'${column}')::${cast}`;
}

/**
 * The `budget_windows` CTE body: one row per initiative (projects.id) with
 * `period, rolling_days, period_state, period_start, period_end, period_key,
 * prev_start, prev_end, prev_key`. currentPeriod / previousPeriod, in SQL.
 * Every initiative still on 'monthly' (or with no allocation row) gets exactly
 * the pre-DE-38 window, PERIOD_START_SQL. `scoped` adds `WHERE p.id = :pid`.
 */
export function budgetWindowsCteSql(opts: { scoped?: boolean } = {}): string {
  const where = opts.scoped ? 'WHERE p.id = :pid' : '';
  const month = PERIOD_START_SQL;
  const quarter = `date_trunc('quarter', NOW())`;
  const roll = `make_interval(days => ${policyColumnSql('ib', 'rolling_days', 'int')})`;
  return `budget_windows AS (
      SELECT p.id AS org_project_id,
             COALESCE(ib.period, 'monthly') AS period,
             ${policyColumnSql('ib', 'rolling_days', 'int')} AS rolling_days,
             CASE WHEN ib.period = 'sprint' AND cs.id IS NULL THEN 'between-sprints' ELSE 'open' END AS period_state,
             CASE WHEN ib.period = 'quarterly' THEN ${quarter}
                  WHEN ib.period = 'rolling' THEN NOW() - ${roll}
                  WHEN ib.period = 'sprint' AND cs.id IS NOT NULL THEN cs.starts_on::timestamptz
                  ELSE ${month} END AS period_start,
             CASE WHEN ib.period = 'quarterly' THEN ${quarter} + INTERVAL '3 months'
                  WHEN ib.period = 'rolling' THEN NOW()
                  WHEN ib.period = 'sprint' AND cs.id IS NOT NULL THEN (cs.ends_on + 1)::timestamptz
                  ELSE ${month} + INTERVAL '1 month' END AS period_end,
             CASE WHEN ib.period = 'quarterly' THEN to_char(${quarter}, 'YYYY-"Q"Q')
                  WHEN ib.period = 'rolling' THEN NULL
                  WHEN ib.period = 'sprint' THEN cs.id
                  ELSE to_char(${month}, 'YYYY-MM') END AS period_key,
             CASE WHEN ib.period = 'quarterly' THEN ${quarter} - INTERVAL '3 months'
                  WHEN ib.period = 'rolling' THEN NOW() - ${roll} * 2
                  WHEN ib.period = 'sprint' AND cs.id IS NOT NULL THEN ps.starts_on::timestamptz
                  ELSE ${month} - INTERVAL '1 month' END AS prev_start,
             CASE WHEN ib.period = 'quarterly' THEN ${quarter}
                  WHEN ib.period = 'rolling' THEN NOW() - ${roll}
                  WHEN ib.period = 'sprint' AND cs.id IS NOT NULL THEN (ps.ends_on + 1)::timestamptz
                  ELSE ${month} END AS prev_end,
             CASE WHEN ib.period = 'quarterly' THEN to_char(${quarter} - INTERVAL '3 months', 'YYYY-"Q"Q')
                  WHEN ib.period = 'rolling' THEN NULL
                  WHEN ib.period = 'sprint' AND cs.id IS NOT NULL THEN ps.id
                  WHEN ib.period = 'sprint' THEN NULL
                  ELSE to_char(${month} - INTERVAL '1 month', 'YYYY-MM') END AS prev_key
        FROM projects p
        LEFT JOIN initiative_budgets ib ON ib.org_project_id = p.id
        LEFT JOIN LATERAL (
          SELECT sp.id, sp.starts_on, sp.ends_on FROM sprints sp
           WHERE ib.period = 'sprint' AND sp.org_project_id = p.id
             AND ${sprintLowerSql('NOW()', 'sp.starts_on')} AND ${sprintUpperSql('NOW()', 'sp.ends_on')}
           ORDER BY (sp.status = 'active') DESC, sp.starts_on DESC, sp.id DESC
           LIMIT 1
        ) cs ON TRUE
        LEFT JOIN LATERAL (
          SELECT sp.id, sp.starts_on, sp.ends_on FROM sprints sp
           WHERE cs.id IS NOT NULL AND sp.org_project_id = p.id AND sp.starts_on < cs.starts_on
           ORDER BY sp.starts_on DESC, sp.id DESC
           LIMIT 1
        ) ps ON TRUE
       ${where}
    )`;
}

/** `WITH budget_windows AS (...)` for a statement that starts with this CTE. */
export function withBudgetWindowsSql(scoped = false): string {
  return `WITH ${budgetWindowsCteSql({ scoped })}\n`;
}

/**
 * The current window's start for one initiative, as a scalar expression. The
 * statement must open with withBudgetWindowsSql().
 */
export function periodStartForSql(projectRef: string): string {
  return `(SELECT bw.period_start FROM budget_windows bw WHERE bw.org_project_id = ${projectRef})`;
}

/** The DE-38 columns: read through policyColumnSql, probed together (column-probe.ts) before a write names them. */
export const PERIOD_COLUMNS = ['rolling_days', 'carry_over', 'carry_over_cap_usd', 'carry_over_since'] as const;
