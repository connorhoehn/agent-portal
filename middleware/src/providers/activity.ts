// Per-initiative activity time series — daily buckets of agent runs, agent
// spend, and completed work, for the initiative detail page's activity graph.
//
// This is deliberately NOT the same thing as getProjectActivity's `/activity`
// feed (work-items.ts): that endpoint answers "what happened recently" as a
// short list of events; this answers "how much happened, per day, over a
// window" as three same-length numeric arrays a sparkline can read
// positionally. Reusing the `/activity` path for both would silently shadow
// one of them (Express only ever dispatches the first-registered handler for
// a given method+path), so this is mounted at a sibling path instead — see
// routes/work-items.ts.
//
// Every day in the window is represented, oldest first, with no gaps: a day
// with no activity is a real 0, not a missing array element.

import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { spendPredicateSql } from './budgets.js';
import { mockRunsAttributedTo } from './bots.js';
import { projectExists, getProjectWorkItems, mockReprojectedIso, type WorkItem } from './work-items.js';
import { clock } from '../mock/core/index.js';

function strParam(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }

/** Reads degrade to empty until the bots schema is applied — same convention
 * as bots.ts/budgets.ts's safeExec: a cluster missing bot_runs should render
 * a zero series, not a 500. */
async function safeExec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  try {
    return await exec(sql, params);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/does not exist|relation/i.test(msg)) return [];
    throw err;
  }
}

export interface ProjectActivitySeries {
  days: number;
  from: string;
  to: string;
  series: {
    runs: number[];
    spendUsd: number[];
    completed: number[];
  };
  totals: { runs: number; spendUsd: number; completed: number };
}

const DAY_MS = 86_400_000;

/**
 * `days` UTC calendar-day buckets ending "today" (UTC), oldest first, as
 * YYYY-MM-DD keys. Bucketed in UTC — not the host's local time — so the
 * boundary a run falls on does not slide with the middleware's TZ.
 */
export function buildDayKeys(days: number, now: Date = clock.now()): string[] {
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    keys.push(new Date(todayUtc - i * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * `bot_runs.cost_usd` is NUMERIC(10,4), so four decimals is the precision the
 * column holds and the precision Postgres returns — this rounding exists only
 * to strip binary-float noise (0.1739 + 0.1409 is 0.31480000000000002), not to
 * truncate real money.
 *
 * It used to round to CENTS, and that put this graph a fraction of a cent away
 * from the ledger reading the same rows: a $0.0341 dispatch moved the Budgets
 * row by 0.0341 and this graph's total by 0.03, so "did these two surfaces move
 * by the same amount" could only ever be answered approximately. Same scale
 * providers/budgets.ts and bots.ts's mockDispatchedSpend use. Presentation
 * rounding belongs to the portal.
 */
function roundCost(n: number): number {
  return Math.round((n + Number.EPSILON) * 10_000) / 10_000;
}

// ─── Runs + spend (bot_runs) ────────────────────────────────────────────────

/**
 * Aurora path: day-bucketed COUNT/SUM over bot_runs, scoped to the initiative
 * with the SAME attribution predicate budgets.ts uses for the ledger's
 * spend/run-count columns (spendPredicateSql — "the attribution model of
 * record", per bots.ts's own comment: two copies of that predicate is how two
 * surfaces come to disagree about the same dollar). That predicate also
 * requires cost_usd IS NOT NULL, matching how budgets.ts's
 * run_count_this_period already counts runs — a run still in flight with no
 * posted cost is not yet counted here either, consistent with the ledger.
 */
async function auroraRunSeries(
  projectId: string,
  dayKeys: string[],
  runsByDay: Map<string, number>,
  spendByDay: Map<string, number>,
): Promise<void> {
  const from = `${dayKeys[0]}T00:00:00Z`;
  const toExclusive = new Date(Date.parse(`${dayKeys[dayKeys.length - 1]}T00:00:00Z`) + DAY_MS).toISOString();
  const rows = await safeExec(
    `SELECT (br.started_at AT TIME ZONE 'UTC')::date::text AS day,
            COUNT(*)::int AS runs,
            COALESCE(SUM(br.cost_usd), 0)::float8 AS spend
       FROM bot_runs br
      WHERE br.started_at >= :from::timestamptz
        AND br.started_at <  :to::timestamptz
        AND (${spendPredicateSql(':pid')})
      GROUP BY 1`,
    [strParam('from', from), strParam('to', toExclusive), strParam('pid', projectId)],
  );
  for (const r of rows) {
    const day = String(r['day']);
    if (!runsByDay.has(day)) continue; // outside the requested window
    runsByDay.set(day, Number(r['runs']) || 0);
    spendByDay.set(day, Number(r['spend']) || 0);
  }
}

/**
 * Mock path: bucket the SAME per-run history the Bots pages and the money
 * surfaces read (bots.ts's `mockRunsAttributedTo`) by UTC day — the fixture
 * analogue of auroraRunSeries' GROUP BY over bot_runs.
 *
 * This used to synthesize a curve instead — one run per day the bot's cron
 * day-of-week field selected, at its budgetPerRunUsd — because MOCK_BOT_RUNS
 * did not exist yet and listBotRuns() returned [] in mock mode. It also
 * skipped any bot that was not `enabled`. Both premises are now wrong, and
 * the second is actively misleading: the seed parks EVERY bot (enabled
 * FALSE, awaiting repo provisioning), so filtering on `enabled` made every
 * initiative's activity graph read flat zero while /iq/bots/:id showed those
 * same initiatives 30 days of runs. Aurora does not filter on bots.enabled
 * either — a parked bot's past runs still happened and still cost money.
 *
 * Like the Aurora predicate, a run with no posted cost is not counted; unlike
 * the old synthesis, "today" needs no separate reconciliation pass, because
 * the bot's todayRunCount/todaySpendUsd are derived (deriveBotStats) from
 * these very rows.
 */
function mockRunSeries(
  projectId: string,
  dayKeys: string[],
  runsByDay: Map<string, number>,
  spendByDay: Map<string, number>,
): void {
  const inWindow = new Set(dayKeys);
  const add = (run: { costUsd: number | null; startedAt: string }): void => {
    if (run.costUsd == null) return;
    const key = run.startedAt.slice(0, 10);
    if (!inWindow.has(key)) return;
    runsByDay.set(key, (runsByDay.get(key) ?? 0) + 1);
    spendByDay.set(key, roundCost((spendByDay.get(key) ?? 0) + run.costUsd));
  };

  // ONE attribution resolver, shared with the ledger. This used to be two
  // loops here — the seeded history of every bot on the initiative, then
  // `listMarketplaceRuns` for the work-item arm — which was already a second
  // copy of a predicate providers/budgets.ts also owned, and the copies had
  // drifted: this one counted marketplace dispatches and the money surfaces
  // did not, so a dispatch offline moved this graph and left Initiatives and
  // Budgets flat. It also missed a third case both copies should have had, a
  // LIVE firing of a seeded bot. `mockRunsAttributedTo` is all three arms,
  // deduped, seeded rows and live rows alike.
  for (const run of mockRunsAttributedTo(projectId)) add(run);
}

// ─── Completed work (work_items.completed_at) ───────────────────────────────

/**
 * Mock work-item seeds carry completedAt written as an offset from a frozen
 * epoch (work-items.ts's D(n)/MOCK_EPOCH) that only gets staler as real time
 * passes it by — literally bucketing those timestamps would put every seeded
 * completion outside any realistic trailing window by now. Reproject: keep
 * the SAME "n days before the reference point" offset the fixture encodes,
 * replayed from real today instead of the frozen epoch. Aurora's completed_at
 * is written with `NOW() - INTERVAL` (schema/seed_program.sql) and needs no
 * such adjustment.
 *
 * The reprojection itself is work-items.ts's `mockReprojectedIso` — the
 * activity FEED there reprojects the same seeds, and a second copy of the rule
 * here is how the graph and the feed come to place one completion on two
 * different days. This is only the day-bucketing wrapper. (Its stamp-written-
 * by-this-process guard lives there too: an item completed a second ago must
 * not have the offset inverted and land months in the future, outside every
 * window, invisible on the graph that exists to show it.)
 */
function mockReprojectedDay(completedAtIso: string): string {
  return mockReprojectedIso(completedAtIso).slice(0, 10);
}

function applyCompleted(items: WorkItem[], dayKeys: string[], completedByDay: Map<string, number>): void {
  const reproject = config.mock.aurora;
  for (const item of items) {
    if (!item.completedAt) continue;
    const day = reproject ? mockReprojectedDay(item.completedAt) : item.completedAt.slice(0, 10);
    if (completedByDay.has(day)) completedByDay.set(day, (completedByDay.get(day) ?? 0) + 1);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Null means "no such initiative" (matching /work and /decisions' 404
 * convention). An initiative that exists with zero runs and zero completed
 * work returns a real, fully zero-filled series — that is a legitimate state,
 * not an error.
 */
export async function getProjectActivitySeries(projectId: string, days: number): Promise<ProjectActivitySeries | null> {
  if (!(await projectExists(projectId))) return null;

  const dayKeys = buildDayKeys(days);
  const runsByDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  const spendByDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));
  const completedByDay = new Map<string, number>(dayKeys.map((k) => [k, 0]));

  if (config.mock.aurora) {
    mockRunSeries(projectId, dayKeys, runsByDay, spendByDay);
  } else {
    await auroraRunSeries(projectId, dayKeys, runsByDay, spendByDay);
  }

  const items = await getProjectWorkItems(projectId);
  applyCompleted(items, dayKeys, completedByDay);

  const runs = dayKeys.map((k) => runsByDay.get(k) ?? 0);
  const spendUsd = dayKeys.map((k) => roundCost(spendByDay.get(k) ?? 0));
  const completed = dayKeys.map((k) => completedByDay.get(k) ?? 0);

  return {
    days: dayKeys.length,
    from: dayKeys[0]!,
    to: dayKeys[dayKeys.length - 1]!,
    series: { runs, spendUsd, completed },
    totals: {
      runs: runs.reduce((a, b) => a + b, 0),
      spendUsd: roundCost(spendUsd.reduce((a, b) => a + b, 0)),
      completed: completed.reduce((a, b) => a + b, 0),
    },
  };
}
