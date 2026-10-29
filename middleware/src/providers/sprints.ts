// Sprints — the cadence an SME actually works and spends inside.
//
// The program operating model (docs/program-operating-model.md) is built on
// sprints: each initiative runs them, one SME stewards each, budget_grants
// scopes an envelope to one, and work_items carry sprint_id. Until this module
// existed none of that was readable as a sprint — the only surface was the
// grants table on the Budgets page, which is gated to org-leader/hr-admin, so
// the SME the model is written for could not open their own sprint anywhere.
//
// Three deliberate decisions live here:
//
// 1. "Mine" is broader than "I steward it". In the seed, stewardship is held by
//    six people while sprint work is assigned across the whole cast — p-004
//    (the SME the demo logs in as) stewards nothing and is assigned work in
//    four sprints. A page that answered only "sprints you steward" would be
//    empty for most SMEs, so a sprint is mine when I steward it, hold a grant
//    on it, OR have work assigned in it, and the row says which of the three.
//
// 2. Spend is INITIATIVE spend inside the sprint window, never personal burn.
//    bot_runs record which initiative and which bot paid, never whose envelope
//    authorized it (schema/program_schema.sql is explicit that burn is derived,
//    not stored). Calling this the steward's burn would be a number the data
//    cannot support — the same reasoning behind GrantRow.initiativeSpendInWindowUsd
//    in providers/budgets.ts, whose predicate this module reuses rather than
//    re-deriving.
//
// 3. Rollups are computed here, not in the portal. The board fetches its items
//    from /api/graph/work?sprint=<id>, but the header numbers (points, items,
//    estimate, envelope, spend) must be true even when the board is paginated
//    or filtered, so they come from SQL over the whole sprint.
//
// This module is persistence only. Gating lives in routes/sprints.ts.

import { AppError } from '../lib/async-handler.js';
import { sprintLowerSql, sprintUpperSql } from '../lib/budget-periods.js';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
// The attribution model of record for "what did this initiative spend" — one
// predicate, shared with the ledger, so a sprint's window spend and the Budgets
// page's window spend can never be computed two different ways.
import { mockInitiativeWindowSpendUsd, spendPredicateSql } from './budgets.js';
import { sprints as sprintsFixture, type MockSprint } from './sprintWindows.js';
import { mergedMockGrants } from './grantOverlay.js';
import { searchWorkItems } from './work-items.js';
// The one clock. A created sprint's id carries an instant, and a fixture
// instant is read through the clock so a frozen test freezes it too.
import { clock } from '../mock/core/index.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : nul(name);
}
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function toBool(v: unknown): boolean { return v === true || v === 'true' || v === 1; }

export type SprintStatus = 'planned' | 'active' | 'done';
export const SPRINT_STATUSES: readonly SprintStatus[] = ['planned', 'active', 'done'];

export interface SprintRow {
  id: string;
  orgProjectId: string;
  orgProjectName: string | null;
  name: string;
  goal: string | null;
  /** The SME accountable for the sprint; the envelope points at them. */
  stewardPersonId: string | null;
  stewardName: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: string;

  // ── Work in the sprint (every item, not the page the board rendered) ──
  itemCount: number;
  doneItemCount: number;
  pointsTotal: number;
  pointsDone: number;
  /** Sum of work_items.estimated_cost_usd in the sprint — what the sprint was
   *  planned to cost, against the envelope granted for it. */
  estimatedCostUsd: number;

  // ── Money ──
  /** Sum of budget_grants.allocated_usd scoped to this sprint. */
  grantedUsd: number;
  grantCount: number;
  /** Spend attributed to the INITIATIVE inside the sprint's dates. Deliberately
   *  not the steward's burn — see the header note. */
  initiativeSpendInWindowUsd: number;

  // ── Why this sprint is the caller's (all false/0 for an unlinked caller) ──
  isSteward: boolean;
  isGrantee: boolean;
  myItemCount: number;
  myOpenItemCount: number;
}

export interface ListSprintsOpts {
  /** people.id of the caller, resolved from app_users.person_id. */
  personId?: string | null;
  /** Keep only sprints the caller stewards, holds a grant on, or has work in. */
  mineOnly?: boolean;
  status?: string;
  orgProjectId?: string;
  /** One sprint by id — the read-back path for a create/mutation. */
  sprintId?: string;
  limit?: number;
}

/** A sprint the release manager/SME asked to create. */
export interface CreateSprintInput {
  orgProjectId: string;
  name: string;
  /** ISO calendar dates (YYYY-MM-DD); the route validates format + ordering. */
  startsOn: string;
  endsOn: string;
  stewardPersonId?: string | null;
  goal?: string | null;
  status?: SprintStatus;
}

// ─── Mock fixtures (config.mock.aurora === true) ─────────────────────────────
//
// The sprint table is the REGISTERED `sprints` fixture (mock/sprints.ts), read
// here through providers/sprintWindows.ts — the seam that stops budgets.ts and
// this module importing each other. It used to be two module-level arrays right
// here: `MOCK_SPRINTS` (the seeded cadence) and `MOCK_CREATED_SPRINTS` (every
// sprint this process created), plus a third table of dates keyed by sprint id
// one module over. Nothing could put any of them back — `POST /api/__mock/reset`
// walks the fixture registry — so a sprint created in dev:mock lived until the
// process restarted and the write-capture sweep had to refuse `POST /api/sprints`
// rather than replay it. A create pushes to the fixture now, and a reset takes
// it out again.
//
// Coverage, and why it is exactly this union rather than a longer list, is on
// the fixture. Two things stay derived here rather than stored there:
// envelope figures are read from `mergedMockGrants()` — the seed WITH mutations
// applied — so the Sprints page and the Budgets grants table cannot disagree
// about one envelope; and work rollups come from `searchWorkItems()` for the
// same reason against the board.

/** The rollup shape every sprint row — seeded or created — resolves to before
 *  its counts are computed. */
type MockSprintBase = MockSprint;

/** Test-only: put the sprint calendar back, dropping anything this process
 *  created. `fixtureRegistry.resetAll()` (POST /api/__mock/reset) does the same
 *  thing, which is the point of the fixture. */
export function _resetMockSprints(): void { sprintsFixture.reset(); }

async function buildMockSprintRow(m: MockSprintBase, personId: string | null): Promise<SprintRow> {
  const items = await searchWorkItems({ sprintId: m.id, limit: 200 });
  const grants = mergedMockGrants().filter((g) => g.sprintId === m.id);
  const mine = personId ? items.filter((i) => i.assigneeId === personId) : [];
  return {
    id: m.id,
    orgProjectId: m.orgProjectId,
    orgProjectName: m.orgProjectName,
    name: m.name,
    goal: m.goal,
    stewardPersonId: m.stewardPersonId,
    stewardName: m.stewardName,
    startsOn: m.startsOn,
    endsOn: m.endsOn,
    status: m.status,
    itemCount: items.length,
    doneItemCount: items.filter((i) => i.status === 'done').length,
    pointsTotal: items.reduce((n, i) => n + (i.storyPoints ?? 0), 0),
    pointsDone: items.reduce((n, i) => n + (i.status === 'done' ? (i.storyPoints ?? 0) : 0), 0),
    estimatedCostUsd: Number(items.reduce((n, i) => n + (i.estimatedCostUsd ?? 0), 0).toFixed(2)),
    grantedUsd: grants.reduce((n, g) => n + g.allocatedUsd, 0),
    grantCount: grants.length,
    // The SQL sums bot_runs for the INITIATIVE over the sprint window once —
    // independent of how many grants the sprint carries. Summing each grant's
    // own window spend counted one initiative's money twice on spr-auth-s2
    // (two grants), and counted a lifetime total rather than the window.
    initiativeSpendInWindowUsd: mockInitiativeWindowSpendUsd(m.orgProjectId, m.startsOn, m.endsOn),
    isSteward: personId != null && m.stewardPersonId === personId,
    isGrantee: personId != null && grants.some((g) => g.granteePersonId === personId),
    myItemCount: mine.length,
    myOpenItemCount: mine.filter((i) => i.status !== 'done' && i.status !== 'cancelled').length,
  };
}

// ─── Read plumbing ───────────────────────────────────────────────────────────

/** Reads degrade to empty until program_schema.sql is applied — a cluster that
 *  predates sprints should render an empty board, not a 500. */
async function safeExec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  try {
    return await exec(sql, params);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/does not exist|relation/i.test(msg)) return [];
    throw err;
  }
}

function rowToSprint(r: Record<string, unknown>): SprintRow {
  return {
    id: toStr(r['id']),
    orgProjectId: toStr(r['org_project_id']),
    orgProjectName: r['org_project_name'] != null ? toStr(r['org_project_name']) : null,
    name: toStr(r['name']),
    goal: r['goal'] != null ? toStr(r['goal']) : null,
    stewardPersonId: r['steward_person_id'] != null ? toStr(r['steward_person_id']) : null,
    stewardName: r['steward_name'] != null ? toStr(r['steward_name']) : null,
    startsOn: r['starts_on'] != null ? toStr(r['starts_on']) : null,
    endsOn: r['ends_on'] != null ? toStr(r['ends_on']) : null,
    status: toStr(r['status']),
    itemCount: toNum(r['item_count']),
    doneItemCount: toNum(r['done_item_count']),
    pointsTotal: toNum(r['points_total']),
    pointsDone: toNum(r['points_done']),
    estimatedCostUsd: toNum(r['estimated_cost_usd']),
    grantedUsd: toNum(r['granted_usd']),
    grantCount: toNum(r['grant_count']),
    initiativeSpendInWindowUsd: toNum(r['window_spend_usd']),
    isSteward: toBool(r['is_steward']),
    isGrantee: toBool(r['is_grantee']),
    myItemCount: toNum(r['my_item_count']),
    myOpenItemCount: toNum(r['my_open_item_count']),
  };
}

/**
 * Sprints, active first then most recently started.
 *
 * The window-spend subquery uses `< ends_on + 1` rather than `<= ends_on`
 * because ends_on is a DATE: `<=` would compare a timestamp against midnight
 * and silently drop the whole final day of the sprint, which is exactly the day
 * a demo is most likely to be looking at. Same guard as listGrants.
 */
export async function listSprints(opts: ListSprintsOpts = {}): Promise<SprintRow[]> {
  const personId = opts.personId ?? null;
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 300);

  if (config.mock.aurora) {
    // One list: the seeded cadence and anything created in this process are
    // rows in the same fixture, exactly as they are rows in the same table.
    let rows = await Promise.all(
      sprintsFixture.rows().map((m) => buildMockSprintRow(m, personId)),
    );
    if (opts.sprintId) rows = rows.filter((r) => r.id === opts.sprintId);
    if (opts.status) rows = rows.filter((r) => r.status === opts.status);
    if (opts.orgProjectId) rows = rows.filter((r) => r.orgProjectId === opts.orgProjectId);
    if (opts.mineOnly) rows = rows.filter(isMine);
    rows.sort((a, b) =>
      Number(b.status === 'active') - Number(a.status === 'active')
      || (b.startsOn ?? '').localeCompare(a.startsOn ?? ''));
    return rows.slice(0, limit);
  }

  const params: SqlParameter[] = [];
  const where: string[] = [];
  if (opts.status) { where.push('sp.status = :status'); params.push(s('status', opts.status)); }
  if (opts.orgProjectId) { where.push('sp.org_project_id = :pid'); params.push(s('pid', opts.orgProjectId)); }
  if (opts.sprintId) { where.push('sp.id = :sid'); params.push(s('sid', opts.sprintId)); }

  // With no linked person there is no "mine" to compute, so the markers are
  // literals rather than a parameter compared against NULL (which would make
  // every marker silently false AND still cost the subqueries).
  const meBound = personId != null;
  if (meBound) params.push(s('me', personId));
  const isSteward = meBound ? 'sp.steward_person_id = :me' : 'FALSE';
  const isGrantee = meBound
    ? `EXISTS (SELECT 1 FROM budget_grants g2 WHERE g2.sprint_id = sp.id AND g2.grantee_person_id = :me)`
    : 'FALSE';
  const myItems = meBound
    ? `(SELECT COUNT(*) FROM work_items w2 WHERE w2.sprint_id = sp.id AND w2.assignee_id = :me)::int`
    : '0';
  const myOpenItems = meBound
    ? `(SELECT COUNT(*) FROM work_items w2 WHERE w2.sprint_id = sp.id AND w2.assignee_id = :me
          AND w2.status NOT IN ('done','cancelled'))::int`
    : '0';

  if (opts.mineOnly) {
    // An unlinked caller owns no sprint — say so with a false predicate rather
    // than returning the whole org's board under a "mine" label.
    where.push(meBound ? `(${isSteward} OR ${isGrantee} OR ${myItems} > 0)` : 'FALSE');
  }

  const rows = await safeExec(
    `WITH item_rollup AS (
       SELECT w.sprint_id,
              COUNT(*)::int AS item_count,
              COUNT(*) FILTER (WHERE w.status = 'done')::int AS done_item_count,
              COALESCE(SUM(w.story_points), 0)::int AS points_total,
              COALESCE(SUM(w.story_points) FILTER (WHERE w.status = 'done'), 0)::int AS points_done,
              COALESCE(SUM(w.estimated_cost_usd), 0)::float8 AS estimated_cost_usd
         FROM work_items w
        WHERE w.sprint_id IS NOT NULL
        GROUP BY w.sprint_id
     ),
     grant_rollup AS (
       SELECT g.sprint_id,
              COALESCE(SUM(g.allocated_usd), 0)::float8 AS granted_usd,
              COUNT(*)::int AS grant_count
         FROM budget_grants g
        WHERE g.sprint_id IS NOT NULL
        GROUP BY g.sprint_id
     )
     SELECT sp.id, sp.org_project_id, p.name AS org_project_name,
            sp.name, sp.goal, sp.steward_person_id, pe.name AS steward_name,
            sp.starts_on::text AS starts_on, sp.ends_on::text AS ends_on, sp.status,
            COALESCE(ir.item_count, 0) AS item_count,
            COALESCE(ir.done_item_count, 0) AS done_item_count,
            COALESCE(ir.points_total, 0) AS points_total,
            COALESCE(ir.points_done, 0) AS points_done,
            COALESCE(ir.estimated_cost_usd, 0)::float8 AS estimated_cost_usd,
            COALESCE(gr.granted_usd, 0)::float8 AS granted_usd,
            COALESCE(gr.grant_count, 0) AS grant_count,
            COALESCE((
              SELECT SUM(br.cost_usd)::float8 FROM bot_runs br
               WHERE (${spendPredicateSql('sp.org_project_id')})
                 AND ${sprintLowerSql('br.started_at', 'sp.starts_on')}
                 AND ${sprintUpperSql('br.started_at', 'sp.ends_on')}
            ), 0)::float8 AS window_spend_usd,
            (${isSteward}) AS is_steward,
            (${isGrantee}) AS is_grantee,
            ${myItems} AS my_item_count,
            ${myOpenItems} AS my_open_item_count
       FROM sprints sp
       LEFT JOIN projects p    ON p.id  = sp.org_project_id
       LEFT JOIN people   pe   ON pe.id = sp.steward_person_id
       LEFT JOIN item_rollup ir  ON ir.sprint_id = sp.id
       LEFT JOIN grant_rollup gr ON gr.sprint_id = sp.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY (sp.status = 'active') DESC, sp.starts_on DESC, sp.id
      LIMIT ${limit}`,
    params,
  );
  return rows.map(rowToSprint);
}

/** A sprint is the caller's when they steward it, hold an envelope on it, or
 *  have work assigned in it. Exported so the route and its tests agree. */
export function isMine(r: SprintRow): boolean {
  return r.isSteward || r.isGrantee || r.myItemCount > 0;
}

// ─── One sprint (read-back for a create/mutation) ────────────────────────────

/** A single sprint by id, projected through the same rollup query the board
 *  uses — so a create/move response carries the same shape a list row would. */
export async function getSprint(id: string, personId: string | null = null): Promise<SprintRow | null> {
  const rows = await listSprints({ sprintId: id, personId, limit: 1 });
  return rows[0] ?? null;
}

// ─── Existence checks (write-path validation) ────────────────────────────────
//
// Mirror the discipline in providers/budgets.ts: mock mode answers `true` and
// lets the in-memory write proceed, so dev:mock creates a real (in-memory)
// sprint rather than 503-ing. Real mode asks Aurora.

/** Does this person exist? Steward/grantee ids must resolve to a real people
 *  row before a sprint or envelope can point at them. */
export async function personExists(personId: string): Promise<boolean> {
  if (config.mock.aurora) return true;
  const rows = await exec('SELECT id FROM people WHERE id = :pid LIMIT 1', [s('pid', personId)]);
  return rows.length > 0;
}

// ─── Create ──────────────────────────────────────────────────────────────────

function activeSprintConflict(): AppError {
  return new AppError(409, 'this initiative already has an active sprint; finish it before activating another');
}

async function hasActiveSprint(orgProjectId: string): Promise<boolean> {
  if (config.mock.aurora) return sprintsFixture.rows().some((r) => r.orgProjectId === orgProjectId && r.status === 'active');
  const rows = await exec(
    `SELECT 1 AS one FROM sprints WHERE org_project_id = :pid AND status = 'active' LIMIT 1`,
    [s('pid', orgProjectId)],
  );
  return rows.length > 0;
}

/**
 * Create a sprint. The schema defaults the id (`spr-…`) and CHECKs
 * `ends_on > starts_on`; the route validates dates and referenced ids before we
 * get here, so a failure at this layer is a real DB error, not a bad request.
 * Writes use `exec` (not the read path's `safeExec`) so inserting against a
 * cluster that predates program_schema.sql is loud, never a silent no-op.
 */
export async function createSprint(input: CreateSprintInput): Promise<SprintRow> {
  const status: SprintStatus = input.status ?? 'planned';
  // DE-38: at most one ACTIVE sprint per initiative, so a sprint-period
  // allocation and every envelope resolve to one window (the partial unique
  // index in schema/budget_periods_schema.sql is the database's half).
  if (status === 'active' && await hasActiveSprint(input.orgProjectId)) throw activeSprintConflict();
  if (config.mock.aurora) {
    // The instant comes from the mock clock, not `Date.now()` — a fixture id is
    // a fixture timestamp with a prefix, and a frozen test that cannot predict
    // the id it just created cannot assert on it. The random suffix is what
    // keeps two creates in the same millisecond (or under one frozen instant)
    // apart, so routing the clock half through the clock costs no uniqueness.
    const id = `spr-mock-${clock.now().getTime()}-${Math.floor(Math.random() * 1e6)}`;
    const base: MockSprintBase = {
      id,
      orgProjectId: input.orgProjectId,
      orgProjectName: null,
      name: input.name,
      goal: input.goal ?? null,
      stewardPersonId: input.stewardPersonId ?? null,
      stewardName: null,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      status,
    };
    // Into the fixture, beside the seeded cadence — one `sprints` table, so
    // the sprint is listed by the same read that lists the seeded ones, carries
    // a window the grants side can bound a burn with, and is dropped by
    // `POST /api/__mock/reset` rather than living until the process restarts.
    sprintsFixture.rows().push(base);
    return buildMockSprintRow(base, null);
  }

  let rows: Record<string, unknown>[];
  try {
    rows = await exec(
      `INSERT INTO sprints (org_project_id, name, goal, steward_person_id, starts_on, ends_on, status)
       VALUES (:pid, :name, :goal, :steward, :starts::date, :ends::date, :status)
       RETURNING id`,
      [
        s('pid', input.orgProjectId),
        s('name', input.name),
        maybe('goal', input.goal),
        maybe('steward', input.stewardPersonId),
        s('starts', input.startsOn),
        s('ends', input.endsOn),
        s('status', status),
      ],
    );
  } catch (err) {
    // Two activations racing past the check: the partial unique index decides.
    if (/sprints_one_active_per_initiative/.test((err as Error).message ?? '')) throw activeSprintConflict();
    throw err;
  }
  const id = toStr(rows[0]?.['id']);
  // Read back through the list projection so the response carries the joined
  // initiative/steward names and the (zeroed) rollups a list row would show.
  const created = await getSprint(id);
  if (created) return created;
  throw new Error('sprint was inserted but could not be read back');
}
