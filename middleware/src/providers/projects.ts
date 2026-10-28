// Projects provider — reads project data from Aurora PostgreSQL via RDS Data API.
// Tables: projects(id, name, status, created_at), project_contributions(person_id, project_id, role, weight), people(id, name, title, team)
// Does NOT import from or modify types.ts or aurora.ts — all types and exec are
// local. The single exception is PERIOD_START_SQL from budgets.ts: the agent
// spend window is one fact and duplicating it is what let the two pages
// disagree in the first place.

import { noteSearchWrite } from '../lib/search-index/writes.js';
import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';

import { config } from '../config.js';
// The one exception to the "nothing shared" note above, and a deliberate one:
// the budget period is a single fact and this rollup must not have its own copy
// of it. See PERIOD_START_SQL for why the windows were unified.
import { PERIOD_START_SQL, MOCK_BUDGETS, mockBudgetRow } from './budgets.js';
import { spendLedgerMode } from './spend-ledger.js';
// Same reasoning: the work-item rollup (points/open counts) is one fact,
// owned by work-items.ts's own mock fixture, so the Initiatives list can't
// restate a different number than the initiative-detail Work tab reads.
import { mockWorkItemRollup } from './work-items.js';
// The one mock attribution resolver (spendPredicateSql's three arms, row by
// row) — the live-agents count must attribute a run exactly as spend does.
import { mockRunsAttributedTo } from './bots.js';
import { clock, countBy } from '../mock/core/index.js';
import { initiatives, findInitiative, type MockInitiative } from '../mock/initiatives.js';
import { mockAvatarUrl } from '../mock/avatars.js';
import { devboxBoxes } from '../mock/devbox-fleet.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  status: string | null;
  contributorCount: number;
  createdAt: string | null;
  topContributorNames: string[];
  lastActivityAt: string | null;
  /** Operating-model rollups: one owner + a few SMEs directing agents. Null
      when the cluster predates the work-items/bots schema (see the legacy
      fallback in listProjects) — the portal renders what's present. */
  ownerId: string | null;
  ownerName: string | null;
  smeNames: string[];
  openStories: number | null;
  openBugs: number | null;
  pointsDone: number | null;
  pointsTotal: number | null;
  /** Agent spend MONTH-TO-DATE — the same calendar-month window the Budgets
      ledger uses (providers/budgets.ts PERIOD_START_SQL), so the two surfaces
      report one number for one initiative. Callers must label the month. */
  agentSpendUsd: number | null;
  /** Genuinely last, not last-this-month — see the note in listProjects. */
  lastAgentActivityAt: string | null;
  /** bot_runs currently 'running' attributed to this initiative (24h guard,
      mirroring countRunningRuns in providers/bots.ts). The dashboard's "agents
      active now" signal. */
  activeAgentRuns: number | null;
  /** Highest open work-item priority ('critical' > 'high' > 'medium' > 'low'),
      null when nothing is open. */
  priority: string | null;
  /** initiative_budgets.allocated_usd — the monthly allocation the MTD spend
      reads against. Null when no allocation exists. */
  allocatedUsd: number | null;
  /** The `owner/repo` this initiative's code lives in (agent_projects.repo_full_name,
      joined on agent_projects.org_project_id = projects.id), null when no repo is
      linked yet. This is the ONLY read path a release manager (org-leader) has to
      the codebase link — /api/agent-projects is gated on ManageDevbox, which
      org-leader does not hold (see docs/program-operating-model.md's role table).
      This rollup carries no dispatch or clone capability, only the repo name. */
  repoFullName: string | null;
}

/** The rollup fields defaulted for mock mode and the legacy fallback. */
const EMPTY_ROLLUPS: Pick<ProjectSummary,
  'ownerId' | 'ownerName' | 'smeNames' | 'openStories' | 'openBugs'
  | 'pointsDone' | 'pointsTotal' | 'agentSpendUsd' | 'lastAgentActivityAt' | 'repoFullName'
  | 'activeAgentRuns' | 'priority' | 'allocatedUsd'> = {
  ownerId: null, ownerName: null, smeNames: [],
  openStories: null, openBugs: null, pointsDone: null, pointsTotal: null,
  agentSpendUsd: null, lastAgentActivityAt: null, repoFullName: null,
  activeAgentRuns: null, priority: null, allocatedUsd: null,
};

export interface ProjectDetail {
  id: string;
  name: string;
  status: string | null;
  createdAt: string | null;
  /** 1–3 sentences of prose: what this initiative is for. Null when unset or
      when the column predates the summary/sponsor migration. */
  summary: string | null;
  /** The one person running this initiative (projects.owner_id) — null when
      unset or when the column predates the work-items schema. */
  ownerId: string | null;
  ownerName: string | null;
  /** The VP-like authorizer/originator who signed off on this initiative
      existing (projects.sponsor_person_id) — distinct from the owner who runs
      it day to day and the SMEs who attach to it. Null when unset or when the
      column predates the summary/sponsor migration. */
  sponsorId: string | null;
  sponsorName: string | null;
  sponsorTitle: string | null;
  /** Agent spend MONTH-TO-DATE, same window/definition as
      ProjectSummary.agentSpendUsd — carried here so the detail page (and its
      header) never has to refetch the whole /api/graph/projects list to read
      one row's number. Null when the underlying tables predate the
      work-items schema. */
  agentSpendUsd: number | null;
  /** The monthly allocation agentSpendUsd reads against
      (initiative_budgets.allocated_usd) — same field as
      ProjectSummary.allocatedUsd, scoped to this id, so the detail header can
      say "$1.73 spent of $95 allocated" without refetching the list. Null when
      no allocation exists or the budgets schema predates this cluster. */
  allocatedUsd: number | null;
  /** bot_runs currently 'running' attributed to this initiative (24h guard) —
      same definition as ProjectSummary.activeAgentRuns. The detail header's
      "N agents running". Null only when bot_runs predates this cluster; 0 is
      a real "nothing running". */
  activeAgentRuns: number | null;
  /** Same repo-link rollup as ProjectSummary.repoFullName, scoped to this id. */
  repoFullName: string | null;
  contributors: Array<{
    personId: string;
    name: string;
    title: string | null;
    role: string | null;
    weight: number;
    /** people.avatar_url — null renders initials. */
    avatarUrl: string | null;
  }>;
}

// ─── RDS Data API helpers (local to this module) ────────────────────────────

let _client: RDSDataClient | null = null;
function getClient(): RDSDataClient {
  if (!_client) _client = new RDSDataClient({ region: config.region });
  return _client;
}

function readField(cell: Field | undefined): unknown {
  if (!cell) return null;
  if (cell.isNull) return null;
  if (cell.stringValue !== undefined) return cell.stringValue;
  if (cell.longValue !== undefined) return cell.longValue;
  if (cell.doubleValue !== undefined) return cell.doubleValue;
  if (cell.booleanValue !== undefined) return cell.booleanValue;
  return null;
}

async function exec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  const resp = await getClient().send(
    new ExecuteStatementCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
      sql,
      parameters: params,
      includeResultMetadata: true,
    }),
  );
  const cols = (resp.columnMetadata ?? []).map((c) => c.name ?? '');
  return (resp.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};
    record.forEach((cell, i) => {
      row[cols[i] ?? `col${i}`] = readField(cell);
    });
    return row;
  });
}

export function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

export function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

// ─── Mock data (used when config.mock.aurora === true) ───────────────────────
// A faithful mirror of the curated program seed (schema/seed_program.sql, built
// by schema/seeds/generate_program_seed.py): the same canonical p-* initiative
// ids, the same people from schema/seed.sql, and the same operating model —
// exactly one owner runs an initiative, and a couple of SMEs attach across
// several. The previous fixtures described a phantom proj-* family with
// invented people, so mock mode disagreed with every real surface.
//
// One cast table drives both the summary and the detail shape, so they cannot
// drift apart as the response types grow.

interface CastMember { personId: string; name: string; title: string }

const CAST: Record<string, CastMember> = {
  'p-001': { personId: 'p-001', name: 'Theo Chang',      title: 'Engineer' },
  'p-002': { personId: 'p-002', name: 'Vera Green',      title: 'Principal Engineer' },
  'p-004': { personId: 'p-004', name: 'Nora DaSilva',    title: 'Senior Engineer' },
  'p-006': { personId: 'p-006', name: 'Maria Johnson',   title: 'Principal Engineer' },
  'p-008': { personId: 'p-008', name: 'Layla Hassan',    title: 'SRE Lead' },
  'p-012': { personId: 'p-012', name: 'Rachel Kowalski', title: 'Principal Engineer' },
  'p-011': { personId: 'p-011', name: 'Eli Garcia',      title: 'Senior SRE' },
  'p-013': { personId: 'p-013', name: 'Caleb Turner',    title: 'Senior Engineer' },
  'p-rhea': { personId: 'p-rhea', name: 'Rhea Castellanos', title: 'Security Engineer' },
  'p-015': { personId: 'p-015', name: 'Raj Mehta',       title: 'Data Engineer' },
  'p-017': { personId: 'p-017', name: 'Daniel Chang',    title: 'Staff Data Engineer' },
  'p-019': { personId: 'p-019', name: 'Camille Dubois',     title: 'Senior Data Engineer' },
  'p-024': { personId: 'p-024', name: 'Andre Williams',   title: 'Staff Engineer' },
  'p-025': { personId: 'p-025', name: 'Anika Mehta',     title: 'Principal Engineer' },
  'p-026': { personId: 'p-026', name: 'Mateo Green',     title: 'Senior UX Researcher' },
  'p-030': { personId: 'p-030', name: 'Mia Singh',       title: 'Group PM' },
  'p-034': { personId: 'p-034', name: 'Miles Wright',    title: 'Accessibility Specialist' },
  'p-035': { personId: 'p-035', name: 'Ben Okafor',      title: 'Staff Designer' },
  'p-036': { personId: 'p-036', name: 'David Tanaka',    title: 'Head of Design' },
  'p-038': { personId: 'p-038', name: 'Isabel Vasquez',  title: 'Design Engineer' },
  'p-042': { personId: 'p-042', name: 'Katya Petrov',     title: 'Staff ML Engineer' },
  'p-043': { personId: 'p-043', name: 'Bria Petrov',     title: 'Staff ML Engineer' },
  'p-044': { personId: 'p-044', name: 'Zoe Thompson',  title: 'Staff Engineer' },
  'p-047': { personId: 'p-047', name: 'Nina Rivera',     title: 'Staff ML Engineer' },
  'p-048': { personId: 'p-048', name: 'Lucas Kim',       title: 'Staff ML Engineer' },
  'p-049': { personId: 'p-049', name: 'Paolo Mancini',    title: 'Engineering Manager' },
  'p-051': { personId: 'p-051', name: 'Simone Chang',      title: 'Senior Security Engineer' },
  'p-052': { personId: 'p-052', name: 'Diego Ortiz',    title: 'Security Lead' },
  'p-055': { personId: 'p-055', name: 'Joy Chen',        title: 'Senior Security Engineer' },
  'p-056': { personId: 'p-056', name: 'Hugo Lee',        title: 'Security Engineer' },
};

// The initiative rows themselves are the REGISTERED `initiatives` fixture
// (mock/initiatives.ts) — see that file for why they moved and what went with
// them (`activeAgents`, `activeHoursAgo`). Everything below is a selector over
// those rows, read at request time, so a reset or a scenario switch reaches it.

/**
 * Does this initiative exist, in mock mode?
 *
 * Exported so `work-items.ts` can answer "is this a real id" from the SAME list
 * that GET /api/graph/projects serves. It previously answered that question with
 * "does it have any work items or decisions?", so an initiative that genuinely
 * exists but has no work yet (p-realtime-analytics) 404'd as "Project not
 * found" — the exact confusion the sub-collection 404s were introduced to
 * prevent, inverted: instead of a typo reading as empty, an empty initiative
 * read as a typo.
 *
 * Under the fixture's `empty` scenario nothing exists, so every initiative id
 * 404s — which is what a tenant with no projects rows answers too.
 */
export function mockProjectExists(projectId: string): boolean {
  return findInitiative(projectId) !== undefined;
}

/**
 * Does this initiative exist NOW — GET /api/graph/projects/:id's 404 half, read
 * fresh (no cache). The realtime gateway asks it on every decision on an
 * `orgiq:initiative:<id>` call lobby (lib/page-resources.ts), so a forged or
 * deleted initiative is refused the way its page 404s. A store error throws;
 * the caller treats that as a refusal.
 */
export async function projectExists(id: string): Promise<boolean> {
  if (!id) return false;
  if (config.mock.aurora) return mockProjectExists(id);
  return (await exec('SELECT 1 FROM projects WHERE id = :id LIMIT 1', [strParam('id', id)])).length > 0;
}

/**
 * What this initiative is CALLED, in mock mode — the one place a `p-*` id
 * resolves to a display name.
 *
 * Exported because `work-items.ts` used to store a `projectName` string on
 * every fixture row, and 19 of them stored the *wrong* one: the wi-otel-*
 * family said "Unified Observability Stack" while sitting on
 * p-inference-platform, and wi-cedar-* said "Cedar Auth Policy Migration"
 * while sitting on p-rag-search. The Work tab renders that string directly
 * under an initiative header rendered from THIS list, so the reader saw two
 * names for one initiative. A derived name cannot drift; a copied one always
 * eventually does.
 *
 * Returns null for an id no initiative carries, so a caller can decide
 * whether that is an empty label or a bug.
 */
export function mockProjectName(projectId: string): string | null {
  return findInitiative(projectId)?.name ?? null;
}

/** The 24-hour guard countRunningRuns and the SQL `active_agent_runs`
    subquery apply, so a run stuck 'running' cannot read as live forever. */
const ACTIVE_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * bot_runs currently 'running' and attributed to this initiative — COUNTED
 * from the run rows, never typed.
 *
 * The mock analogue of the `active_agent_runs` subquery below: status
 * 'running', started inside 24 hours, attributed through the same three arms
 * the spend predicate uses (bots.ts `mockRunsAttributedTo` — the one place mock
 * attribution is resolved). It replaced a typed `activeAgents` on each fixture
 * row, which claimed two live agents on Observability over a run table with no
 * running row in it.
 */
export function mockActiveAgentRuns(projectId: string): number {
  const cutoff = clock.now().getTime() - ACTIVE_RUN_WINDOW_MS;
  const botRuns = countBy(
    mockRunsAttributedTo(projectId),
    (r) => r.status === 'running' && Date.parse(r.startedAt) > cutoff,
  ).get(true) ?? 0;
  // A devbox box mid-task on the initiative is an agent running on it too, even
  // when no bot_runs row backs it (the fleet and the run table are two fixtures).
  // Taking the larger of the two counts keeps a box and the run that dispatched
  // it from being counted twice, and stops "0 agents running" beside a box that
  // is visibly working the initiative's items.
  const boxes = countBy(devboxBoxes.rows(), (b) => b.status === 'running' && b.projectId === projectId).get(true) ?? 0;
  return Math.max(botRuns, boxes);
}

function castName(personId: string): string {
  return CAST[personId]?.name ?? personId;
}

function mockSummaryRow(p: MockInitiative): Omit<ProjectSummary, keyof typeof EMPTY_ROLLUPS> {
  return {
    id: p.id,
    name: p.name,
    status: p.status,
    contributorCount: 1 + p.smes.length,
    createdAt: p.createdAt,
    topContributorNames: [p.owner, ...p.smes].map(castName),
    // Overwritten from the ledger's run-derived activity at the return site;
    // createdAt is Aurora's own fallback (`lastAgent ?? createdAt`).
    lastActivityAt: p.createdAt,
  };
}

// ─── Provider functions ──────────────────────────────────────────────────────

/** One initiative the person belongs to, by the operating model's two relationships (docs/program-operating-model.md). */
export interface InitiativeMembership { id: string; name: string; status: string | null; membership: 'owner' | 'contributor'; role: string | null }

/**
 * The initiatives `personId` owns (projects.owner_id) or contributes to
 * (project_contributions) — the ONE membership rule behind every "mine" read of
 * initiatives (lib/mine.ts; `listProjects({ mineOnly })` applies the same
 * relationships to the full summary rows). The caller resolves the person from
 * the session's directory link, never from a request.
 */
export async function listInitiativeMemberships(personId: string): Promise<InitiativeMembership[]> {
  if (config.mock.aurora) {
    return initiatives.rows()
      .filter((p) => p.owner === personId || p.smes.includes(personId))
      .map((p): InitiativeMembership => ({ id: p.id, name: p.name, status: p.status, membership: p.owner === personId ? 'owner' : 'contributor', role: p.owner === personId ? 'owner' : 'sme' }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const rows = await exec(
    `SELECT p.id, p.name, p.status, (p.owner_id = :me) AS is_owner, pc.role
       FROM projects p
       LEFT JOIN project_contributions pc ON pc.project_id = p.id AND pc.person_id = :me
      WHERE p.owner_id = :me OR pc.person_id IS NOT NULL
      ORDER BY p.name`,
    [strParam('me', personId)],
  );
  const seen = new Set<string>();
  return rows.flatMap((r) => {
    const id = String(r['id']);
    if (seen.has(id)) return [];
    seen.add(id);
    const owner = r['is_owner'] === true;
    return [{ id, name: String(r['name']), status: r['status'] == null ? null : String(r['status']),
      membership: owner ? 'owner' as const : 'contributor' as const, role: owner ? 'owner' : r['role'] == null ? null : String(r['role']) }];
  });
}

export async function listProjects(opts: {
  status?: string;
  limit?: number;
  /** When true, only initiatives `personId` owns or contributes to — the
      dashboard's "Mine" scope (same person-keyed framing as /api/sprints). */
  mineOnly?: boolean;
  personId?: string | null;
}): Promise<ProjectSummary[]> {
  if (config.mock.aurora) {
    let items = initiatives.rows().slice();
    if (opts.status) items = items.filter((p) => p.status === opts.status);
    if (opts.mineOnly) {
      const me = opts.personId ?? null;
      items = me ? items.filter((p) => p.owner === me || p.smes.includes(me)) : [];
    }
    // The cast's first entry is the initiative owner by construction, and the
    // rest are its SMEs — same shape the real rollup returns.
    return items.slice(0, Math.min(opts.limit ?? 50, 200)).map((cast) => {
      const p = mockSummaryRow(cast);
      // Spend + liveness come from the LEDGER'S OWN mock row, not a second
      // fixture: mock mode used to default both to null here (EMPTY_ROLLUPS)
      // while providers/budgets.ts showed real money for the same initiative
      // ids, so `dev:mock` had Initiatives saying "no agent runs yet" beside a
      // Budgets page reporting $19.77 spent across those very rows. An
      // initiative absent from the ledger genuinely has no attributed runs, so
      // it reads $0 / never — the same answer Aurora gives, not null.
      const ledger = MOCK_BUDGETS.find((b) => b.id === p.id);
      const row = ledger ? mockBudgetRow(ledger) : null;
      // Derived from the SAME wi-* items providers/work-items.ts serves to the
      // initiative-detail Work tab, not restated here — see mockWorkItemRollup.
      const rollup = mockWorkItemRollup(p.id);
      return {
        ...p, ...EMPTY_ROLLUPS,
        ownerId: cast.owner,
        ownerName: p.topContributorNames[0] ?? null,
        smeNames: p.topContributorNames.slice(1),
        repoFullName: cast.repo,
        agentSpendUsd: row ? row.spentThisPeriodUsd : 0,
        lastAgentActivityAt: row ? row.lastAgentActivityAt : null,
        // Counted from running bot_runs rows, as the SQL subquery counts them.
        activeAgentRuns: mockActiveAgentRuns(p.id),
        // Derived from the board where there is one; the fixture's value is
        // the fallback for an initiative whose seeded work this mock does not
        // carry, so a badge can never contradict the items under it.
        priority: rollup.highestOpenPriority ?? cast.priority,
        allocatedUsd: row ? row.allocatedUsd : null,
        openStories: rollup.openStories,
        openBugs: rollup.openBugs,
        pointsDone: rollup.pointsDone,
        pointsTotal: rollup.pointsTotal,
        // Aurora derives lastActivityAt as `lastAgent ?? createdAt`, so where
        // the ledger has activity the two fields are one timestamp, not two
        // fixtures a second apart — and where it has NONE, the fallback is
        // createdAt. (p-zero-trust and p-data-lake have no runs at all, and
        // must not show a card date with no run behind it.)
        lastActivityAt: row?.lastAgentActivityAt ?? p.createdAt,
      };
    });
  }

  // "Mine" without a linked person resolves to nothing — the route says why.
  if (opts.mineOnly && !opts.personId) return [];

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const params: SqlParameter[] = [intParam('lim', limit)];
  const conds: string[] = [];
  if (opts.status) {
    params.push(strParam('status', opts.status));
    conds.push('p.status = :status');
  }
  if (opts.mineOnly && opts.personId) {
    params.push(strParam('me', opts.personId));
    // Ownership OR contribution — an SME attached across initiatives sees each
    // of them under "Mine", same relationship set /api/sprints uses. Only the
    // contributions half of the test so the clause also survives the legacy
    // (pre-owner_id) fallback SQL below; seeds always give the owner a
    // contribution row.
    conds.push(`EXISTS (SELECT 1 FROM project_contributions pcm
        WHERE pcm.project_id = p.id AND pcm.person_id = :me)`);
  }
  const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';

  // Note: projects table has (id, name, status, created_at) — no updated_at.
  // Top contributor names are fetched via a correlated subquery to avoid
  // blowing up GROUP BY with per-row ARRAY_AGG on large tables.
  const legacySelect = `
      p.id,
      p.name,
      p.status,
      p.created_at,
      COUNT(pc.person_id) AS contributor_count,
      (SELECT STRING_AGG(cnames.name, '|||')
       FROM (
         SELECT pe2.name
         FROM project_contributions pc2
         JOIN people pe2 ON pe2.id = pc2.person_id
         WHERE pc2.project_id = p.id
         ORDER BY pc2.weight DESC NULLS LAST
         LIMIT 4
       ) cnames
      ) AS top_names`;

  // The operating-model rollups: owner + SMEs (few people, not avatar walls),
  // real open work, and agent spend. Spend attributes a bot_run to the
  // initiative through any of its three linkages: the run's work item, a bot
  // targeting the initiative directly, or a bot targeting a codebase that
  // delivers it.
  // The linkage alone (no cost filter): a run still 'running' has no cost yet,
  // and the live-agents count below must see it.
  const linkPredicate = `(
          br.work_item_id IN (SELECT w2.id FROM work_items w2 WHERE w2.project_id = p.id)
          OR br.bot_id IN (
            SELECT b.id FROM bots b
             WHERE b.org_project_id = p.id
                OR b.agent_project_id IN (SELECT ap.id FROM agent_projects ap WHERE ap.org_project_id = p.id)
          )
        )`;
  const attributionPredicate = `
        br.cost_usd IS NOT NULL AND ${linkPredicate}`;
  // agentSpendUsd is month-to-date, on the same window the Budgets ledger uses.
  // It was lifetime, which made the same initiative report two different
  // "agent spend" figures on two pages that neither named a window nor agreed.
  const spendPredicate = `br.started_at >= ${PERIOD_START_SQL} AND ${attributionPredicate}`;
  // Last activity stays UNwindowed on purpose: "when did an agent last touch
  // this" is a liveness question, not a money question, and windowing it would
  // report an initiative that ran last month as never having run at all.
  const rollupSelect = `,
      p.owner_id,
      own.name AS owner_name,
      (SELECT STRING_AGG(sn.name, '|||')
       FROM (
         SELECT pe3.name FROM project_contributions pc3
         JOIN people pe3 ON pe3.id = pc3.person_id
         WHERE pc3.project_id = p.id AND pc3.role = 'sme'
         ORDER BY pc3.weight DESC NULLS LAST LIMIT 3
       ) sn) AS sme_names,
      (SELECT COUNT(*) FROM work_items w WHERE w.project_id = p.id AND w.type = 'story'
        AND w.status IN ('open','in_progress','in_review'))::int AS open_stories,
      (SELECT COUNT(*) FROM work_items w WHERE w.project_id = p.id AND w.type = 'bug'
        AND w.status IN ('open','in_progress','in_review'))::int AS open_bugs,
      (SELECT COALESCE(SUM(w.story_points), 0) FROM work_items w
        WHERE w.project_id = p.id AND w.type IN ('story','bug'))::int AS points_total,
      (SELECT COALESCE(SUM(w.story_points), 0) FROM work_items w
        WHERE w.project_id = p.id AND w.type IN ('story','bug') AND w.status = 'done')::int AS points_done,
      ${spendLedgerMode() === 'ledger'
        // The spend ledger (DE-30): attribution resolved at write time, so the
        // rollup and the Budgets ledger read the same rows.
        ? `(SELECT COALESCE(SUM(se.cost_usd), 0)::float8 FROM spend_entries se
             WHERE se.initiative_id = p.id AND se.occurred_at >= ${PERIOD_START_SQL}) AS agent_spend_usd,
      (SELECT MAX(se.occurred_at) FROM spend_entries se
        WHERE se.initiative_id = p.id AND se.cost_usd IS NOT NULL) AS last_agent_activity_at,`
        : `(SELECT COALESCE(SUM(br.cost_usd), 0)::float8 FROM bot_runs br WHERE ${spendPredicate}) AS agent_spend_usd,
      (SELECT MAX(br.started_at) FROM bot_runs br WHERE ${attributionPredicate}) AS last_agent_activity_at,`}
      (SELECT ap.repo_full_name FROM agent_projects ap
        WHERE ap.org_project_id = p.id
        ORDER BY ap.created_at ASC LIMIT 1) AS repo_full_name,
      (SELECT COUNT(*)::int FROM bot_runs br
        WHERE br.status = 'running' AND br.started_at > NOW() - INTERVAL '24 hours'
          AND ${linkPredicate}) AS active_agent_runs,
      (SELECT w.priority FROM work_items w
        WHERE w.project_id = p.id AND w.type IN ('story','bug')
          AND w.status IN ('open','in_progress','in_review')
        ORDER BY CASE w.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1
                                 WHEN 'medium' THEN 2 ELSE 3 END
        LIMIT 1) AS top_priority,
      (SELECT ib.allocated_usd::float8 FROM initiative_budgets ib
        WHERE ib.org_project_id = p.id LIMIT 1) AS allocated_usd`;

  const buildSql = (withRollups: boolean) => `
    SELECT
      ${legacySelect}${withRollups ? rollupSelect : ''}
    FROM projects p
    LEFT JOIN project_contributions pc ON pc.project_id = p.id
    ${withRollups ? 'LEFT JOIN people own ON own.id = p.owner_id' : ''}
    ${whereClause}
    GROUP BY p.id, p.name, p.status, p.created_at${withRollups ? ', p.owner_id, own.name' : ''}
    ORDER BY contributor_count DESC, p.created_at DESC
    LIMIT :lim
  `;

  let rows: Record<string, unknown>[];
  let hasRollups = true;
  try {
    rows = await exec(buildSql(true), params);
  } catch (err) {
    // owner_id / work_items / bots may predate the migrations on this
    // cluster — degrade to the legacy shape rather than 500 the page.
    if (!/does not exist/i.test((err as Error).message ?? '')) throw err;
    hasRollups = false;
    rows = await exec(buildSql(false), params);
  }

  return rows.map((r) => {
    const createdAt = r['created_at'] != null ? String(r['created_at']) : null;
    const rawTopNames = r['top_names'] != null ? String(r['top_names']) : null;
    const rawSmeNames = r['sme_names'] != null ? String(r['sme_names']) : null;
    const lastAgent = r['last_agent_activity_at'] != null ? String(r['last_agent_activity_at']) : null;
    return {
      id: String(r['id'] ?? ''),
      name: String(r['name'] ?? ''),
      status: r['status'] != null ? String(r['status']) : null,
      contributorCount: Number(r['contributor_count'] ?? 0),
      createdAt,
      topContributorNames: rawTopNames
        ? rawTopNames.split('|||').filter((n) => n.length > 0)
        : [],
      lastActivityAt: lastAgent ?? createdAt,
      ...(hasRollups ? {
        ownerId: r['owner_id'] != null ? String(r['owner_id']) : null,
        ownerName: r['owner_name'] != null ? String(r['owner_name']) : null,
        smeNames: rawSmeNames ? rawSmeNames.split('|||').filter((n) => n.length > 0) : [],
        openStories: Number(r['open_stories'] ?? 0),
        openBugs: Number(r['open_bugs'] ?? 0),
        pointsDone: Number(r['points_done'] ?? 0),
        pointsTotal: Number(r['points_total'] ?? 0),
        agentSpendUsd: Number(r['agent_spend_usd'] ?? 0),
        lastAgentActivityAt: lastAgent,
        repoFullName: r['repo_full_name'] != null ? String(r['repo_full_name']) : null,
        activeAgentRuns: Number(r['active_agent_runs'] ?? 0),
        priority: r['top_priority'] != null ? String(r['top_priority']) : null,
        allocatedUsd: r['allocated_usd'] != null ? Number(r['allocated_usd']) : null,
      } : EMPTY_ROLLUPS),
    };
  });
}

/** projects.summary for many initiatives in ONE read, keyed by id — for
    callers (search) that must see every initiative's prose without a detail
    read per row. listProjects deliberately does not carry it: the column
    arrives in a later migration than the rollups, and joining it there would
    drop a pre-summary cluster to the legacy list shape. Ids without a summary
    are absent; a pre-summary cluster yields an empty map, never a throw. */
export async function listProjectSummaries(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = [...new Set(ids)].slice(0, 200);
  if (!distinct.length) return out;
  if (config.mock.aurora) {
    distinct.forEach((id) => { const summary = findInitiative(id)?.summary; if (summary) out.set(id, summary); });
    return out;
  }
  try {
    const rows = await exec(
      `SELECT p.id, p.summary FROM projects p
        WHERE p.summary IS NOT NULL AND p.id IN (${distinct.map((_, i) => `:id${i}`).join(', ')})`,
      distinct.map((id, i) => strParam(`id${i}`, id)),
    );
    rows.forEach((r) => { if (r['id'] != null && r['summary'] != null) out.set(String(r['id']), String(r['summary'])); });
  } catch (err) {
    // Same degradation getProject applies: a pre-summary schema has no prose.
    if (!/does not exist/i.test((err as Error).message ?? '')) throw err;
  }
  return out;
}

export async function getProject(id: string): Promise<ProjectDetail | null> {
  if (config.mock.aurora) {
    const cast = findInitiative(id);
    if (!cast) return null;
    const owner = CAST[cast.owner];
    const sponsor = CAST[cast.sponsor];
    // Same ledger-derived spend and allocation listProjects reads — not a
    // second fixture — so this row and the Initiatives-list row for the same
    // id agree.
    const ledger = MOCK_BUDGETS.find((b) => b.id === id);
    const budgetRow = ledger ? mockBudgetRow(ledger) : null;
    return {
      id: cast.id,
      name: cast.name,
      status: cast.status,
      createdAt: cast.createdAt,
      summary: cast.summary,
      ownerId: cast.owner,
      ownerName: owner?.name ?? null,
      sponsorId: sponsor?.personId ?? null,
      sponsorName: sponsor?.name ?? null,
      sponsorTitle: sponsor?.title ?? null,
      agentSpendUsd: budgetRow ? budgetRow.spentThisPeriodUsd : 0,
      allocatedUsd: budgetRow ? budgetRow.allocatedUsd : null,
      activeAgentRuns: mockActiveAgentRuns(id),
      repoFullName: cast.repo,
      // The owner first, then SMEs — the order Aurora's `weight DESC` returns
      // for the operating model's two weights.
      contributors: [
        { ...CAST[cast.owner]!, role: 'owner', weight: 1.0, avatarUrl: mockAvatarUrl(cast.owner) },
        ...cast.smes.map((pid) => ({ ...CAST[pid]!, role: 'sme', weight: 0.8, avatarUrl: mockAvatarUrl(pid) })),
      ],
    };
  }

  const projectRows = await exec(
    'SELECT id, name, status, created_at FROM projects WHERE id = :id LIMIT 1',
    [strParam('id', id)],
  );

  if (projectRows.length === 0) return null;
  const proj = projectRows[0]!;

  const contribRows = await exec(
    `SELECT
       pc.person_id,
       pe.name,
       pe.title,
       pc.role,
       pc.weight
     FROM project_contributions pc
     JOIN people pe ON pe.id = pc.person_id
     WHERE pc.project_id = :id
     ORDER BY pc.weight DESC`,
    [strParam('id', id)],
  );

  // Owner in its own guarded query: projects.owner_id arrives with the
  // work-items schema, so a cluster that predates it must degrade to "no
  // owner" rather than 500 the whole detail page.
  let ownerId: string | null = null;
  let ownerName: string | null = null;
  try {
    const ownerRows = await exec(
      `SELECT p.owner_id, pe.name AS owner_name
         FROM projects p LEFT JOIN people pe ON pe.id = p.owner_id
        WHERE p.id = :id LIMIT 1`,
      [strParam('id', id)],
    );
    if (ownerRows[0]?.['owner_id'] != null) {
      ownerId = String(ownerRows[0]['owner_id']);
      ownerName = ownerRows[0]['owner_name'] != null ? String(ownerRows[0]['owner_name']) : null;
    }
  } catch { /* column absent — pre-work-items schema */ }

  // Summary + sponsor in one guarded query: both columns arrive in the same
  // migration (schema/orgiq_schema.sql), so a cluster missing one is missing
  // both. Degrades to nulls, not a 500, on a pre-migration cluster.
  let summary: string | null = null;
  let sponsorId: string | null = null;
  let sponsorName: string | null = null;
  let sponsorTitle: string | null = null;
  try {
    const sponsorRows = await exec(
      `SELECT p.summary, p.sponsor_person_id, pe.name AS sponsor_name, pe.title AS sponsor_title
         FROM projects p LEFT JOIN people pe ON pe.id = p.sponsor_person_id
        WHERE p.id = :id LIMIT 1`,
      [strParam('id', id)],
    );
    const row = sponsorRows[0];
    if (row) {
      summary = row['summary'] != null ? String(row['summary']) : null;
      if (row['sponsor_person_id'] != null) {
        sponsorId = String(row['sponsor_person_id']);
        sponsorName = row['sponsor_name'] != null ? String(row['sponsor_name']) : null;
        sponsorTitle = row['sponsor_title'] != null ? String(row['sponsor_title']) : null;
      }
    }
  } catch { /* columns absent — pre-summary/sponsor schema */ }

  // Agent spend (month-to-date) + repo link — the SAME rollup listProjects
  // computes for the list view (linkPredicate/spendPredicate there),
  // reproduced here scoped to just this id, so the detail page never has to
  // refetch the whole /api/graph/projects list to read one row's numbers
  // (that refetch is what ProjectDetailPage.tsx used to do for its header).
  // Guarded like owner/summary above: bot_runs/agent_projects predate the
  // work-items schema on some clusters.
  let agentSpendUsd: number | null = null;
  let repoFullName: string | null = null;
  let activeAgentRuns: number | null = null;
  try {
    const linkPredicate = `(
          br.work_item_id IN (SELECT w2.id FROM work_items w2 WHERE w2.project_id = :id)
          OR br.bot_id IN (
            SELECT b.id FROM bots b
             WHERE b.org_project_id = :id
                OR b.agent_project_id IN (SELECT ap.id FROM agent_projects ap WHERE ap.org_project_id = :id)
          )
        )`;
    const spendRows = await exec(
      `SELECT
         ${spendLedgerMode() === 'ledger'
           ? `(SELECT COALESCE(SUM(se.cost_usd), 0)::float8 FROM spend_entries se
                WHERE se.initiative_id = :id AND se.occurred_at >= ${PERIOD_START_SQL}) AS agent_spend_usd,`
           : `(SELECT COALESCE(SUM(br.cost_usd), 0)::float8 FROM bot_runs br
            WHERE br.started_at >= ${PERIOD_START_SQL} AND br.cost_usd IS NOT NULL AND ${linkPredicate}) AS agent_spend_usd,`}
         (SELECT ap.repo_full_name FROM agent_projects ap
            WHERE ap.org_project_id = :id ORDER BY ap.created_at ASC LIMIT 1) AS repo_full_name,
         (SELECT COUNT(*)::int FROM bot_runs br
            WHERE br.status = 'running' AND br.started_at > NOW() - INTERVAL '24 hours'
              AND ${linkPredicate}) AS active_agent_runs`,
      [strParam('id', id)],
    );
    const row = spendRows[0];
    if (row) {
      agentSpendUsd = row['agent_spend_usd'] != null ? Number(row['agent_spend_usd']) : null;
      repoFullName = row['repo_full_name'] != null ? String(row['repo_full_name']) : null;
      // The list's `active_agent_runs` subquery, scoped to this id — the same
      // 'running' + 24h + link predicate, so the rail row and the header agree.
      activeAgentRuns = row['active_agent_runs'] != null ? Number(row['active_agent_runs']) : null;
    }
  } catch { /* bot_runs/agent_projects absent — pre-work-items schema */ }

  // The allocation in its OWN guarded query: initiative_budgets arrives with
  // the budgets schema, a different migration from bot_runs, so a cluster
  // missing it must cost the allocation (null → "no allocation"), not the
  // spend figure beside it.
  let allocatedUsd: number | null = null;
  try {
    const allocRows = await exec(
      `SELECT ib.allocated_usd::float8 AS allocated_usd FROM initiative_budgets ib
        WHERE ib.org_project_id = :id LIMIT 1`,
      [strParam('id', id)],
    );
    const raw = allocRows[0]?.['allocated_usd'];
    allocatedUsd = raw != null ? Number(raw) : null;
  } catch { /* initiative_budgets absent — pre-budgets schema */ }

  // Avatars last, in their own guarded query: people.avatar_url is an additive
  // column (schema/orgiq_schema.sql), so a cluster that predates it loses
  // faces (initials), not the contributor list.
  const avatarByPerson = new Map<string, string>();
  try {
    const avatarRows = await exec(
      `SELECT pc.person_id, pe.avatar_url
         FROM project_contributions pc JOIN people pe ON pe.id = pc.person_id
        WHERE pc.project_id = :id AND pe.avatar_url IS NOT NULL`,
      [strParam('id', id)],
    );
    for (const row of avatarRows) avatarByPerson.set(String(row['person_id']), String(row['avatar_url']));
  } catch { /* column absent — pre-avatar schema */ }

  return {
    id: String(proj['id'] ?? ''),
    name: String(proj['name'] ?? ''),
    status: proj['status'] != null ? String(proj['status']) : null,
    createdAt: proj['created_at'] != null ? String(proj['created_at']) : null,
    summary,
    ownerId,
    ownerName,
    sponsorId,
    sponsorName,
    sponsorTitle,
    agentSpendUsd,
    allocatedUsd,
    activeAgentRuns,
    repoFullName,
    contributors: contribRows.map((r) => ({
      personId: String(r['person_id'] ?? ''),
      name: String(r['name'] ?? ''),
      title: r['title'] != null ? String(r['title']) : null,
      role: r['role'] != null ? String(r['role']) : null,
      weight: Number(r['weight'] ?? 0),
      avatarUrl: avatarByPerson.get(String(r['person_id'] ?? '')) ?? null,
    })),
  };
}

// ─── Governance writes (owner + contribution roles) ─────────────────────────

/** One shape for both governance writes: the route maps status straight onto
    the response, so every refusal names its own HTTP meaning here. */
export type GovernanceWriteResult =
  | { ok: true }
  | { ok: false; status: 400 | 404 | 503; error: string };

/**
 * Set (or clear, with null) the one person running an initiative
 * (projects.owner_id). The person must exist when non-null — a dangling
 * owner_id would render as "Run by nobody" while blocking reassignment.
 * The column arrives with the work-items schema, so a pre-migration cluster
 * answers 503 with the fix, not a bare SQL error.
 */
export async function updateProjectOwner(
  projectId: string,
  ownerId: string | null,
): Promise<GovernanceWriteResult> {
  if (config.mock.aurora) {
    return { ok: false, status: 503, error: 'project owner updates require Aurora' };
  }

  if (ownerId != null) {
    const person = await exec('SELECT id FROM people WHERE id = :pid LIMIT 1', [strParam('pid', ownerId)]);
    if (person.length === 0) return { ok: false, status: 400, error: 'No such person' };
  }

  try {
    const params = [strParam('id', projectId)];
    const setClause = ownerId == null
      ? 'owner_id = NULL'
      : (params.push(strParam('owner', ownerId)), 'owner_id = :owner');
    const rows = await exec(
      `UPDATE projects SET ${setClause} WHERE id = :id RETURNING id`,
      params,
    );
    if (rows.length === 0) return { ok: false, status: 404, error: 'Project not found' };
    // One owner means one 'owner' role chip: demote any other contributor
    // still carrying it to 'sme' (the portal promotes the new owner's row
    // itself, but nothing else would ever demote the previous one).
    if (ownerId != null) {
      await exec(
        `UPDATE project_contributions SET role = 'sme'
          WHERE project_id = :id AND role = 'owner' AND person_id <> :owner`,
        [strParam('id', projectId), strParam('owner', ownerId)],
      ).catch(() => { /* advisory roles — never fail the owner write over this */ });
    }
    await noteSearchWrite({ type: 'initiative', id: projectId });
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (/owner_id.*does not exist|column.*does not exist/i.test(msg)) {
      return {
        ok: false, status: 503,
        error: 'projects.owner_id is missing — apply schema/orgiq_work_items_schema.sql first',
      };
    }
    throw err;
  }
}

/**
 * Set (or clear, with null) a contributor's role on an initiative
 * (project_contributions.role — free text; 'owner' and 'sme' are the reserved
 * values the marketplace honors). 404 when the person has no contribution row:
 * role editing annotates an existing attachment, it does not create one.
 */
export async function setContributionRole(
  projectId: string,
  personId: string,
  role: string | null,
): Promise<GovernanceWriteResult> {
  if (config.mock.aurora) {
    return { ok: false, status: 503, error: 'contribution role updates require Aurora' };
  }

  const params = [strParam('pid', projectId), strParam('person', personId)];
  const setClause = role == null ? 'role = NULL' : (params.push(strParam('role', role)), 'role = :role');
  const rows = await exec(
    `UPDATE project_contributions SET ${setClause}
      WHERE project_id = :pid AND person_id = :person
      RETURNING person_id`,
    params,
  );
  if (rows.length === 0) {
    return { ok: false, status: 404, error: 'No contribution row for that person on this project' };
  }
  await noteSearchWrite({ type: 'initiative', id: projectId });
  return { ok: true };
}

/** The project_contributions.role an access-tenant membership writes (lib/access-provision.ts). */
export const ACCESS_CONTRIBUTION_ROLE = 'contributor';

/**
 * Attach `personId` to an initiative (a project_contributions row) — the
 * writer the access tenant provisions an `initiative-membership` through
 * (docs/access-tenant-design.md decision A2: no second store). Idempotent:
 * `added` is false when the person already owns or contributes to it. Throws
 * when the initiative does not exist.
 *
 * Offline the mock models every contribution as one SME list on the
 * registered `initiatives` fixture (mock/initiatives.ts — the membership rule
 * `listInitiativeMemberships` reads), so the person joins that list and a
 * reset restores it; the cluster row carries ACCESS_CONTRIBUTION_ROLE.
 */
export async function addContribution(projectId: string, personId: string, role: string = ACCESS_CONTRIBUTION_ROLE): Promise<{ added: boolean }> {
  if (config.mock.aurora) {
    const p = findInitiative(projectId);
    if (!p) throw new Error(`No initiative ${projectId}`);
    if (p.owner === personId || p.smes.includes(personId)) return { added: false };
    p.smes.push(personId);
    await noteSearchWrite({ type: 'initiative', id: projectId });
    return { added: true };
  }
  if (!await projectExists(projectId)) throw new Error(`No initiative ${projectId}`);
  const rows = await exec(
    `INSERT INTO project_contributions (person_id, project_id, role, weight)
     VALUES (:person, :pid, :role, 1.0)
     ON CONFLICT (person_id, project_id) DO NOTHING
     RETURNING person_id`,
    [strParam('person', personId), strParam('pid', projectId), strParam('role', role)],
  );
  if (rows.length > 0) await noteSearchWrite({ type: 'initiative', id: projectId });
  return { added: rows.length > 0 };
}

/**
 * The inverse: detach `personId` from an initiative they joined through the
 * access tenant. Never removes the owner, and on the cluster only a row whose
 * role is still ACCESS_CONTRIBUTION_ROLE — a contribution someone curated
 * since (an SME role chip) is theirs, not the request's. `removed` is false
 * when there was nothing to remove.
 */
export async function removeContribution(projectId: string, personId: string, role: string = ACCESS_CONTRIBUTION_ROLE): Promise<{ removed: boolean }> {
  if (config.mock.aurora) {
    const p = findInitiative(projectId);
    if (!p || p.owner === personId) return { removed: false };
    const at = p.smes.indexOf(personId);
    if (at < 0) return { removed: false };
    p.smes.splice(at, 1);
    await noteSearchWrite({ type: 'initiative', id: projectId });
    return { removed: true };
  }
  const rows = await exec(
    `DELETE FROM project_contributions
      WHERE project_id = :pid AND person_id = :person AND role = :role
      RETURNING person_id`,
    [strParam('pid', projectId), strParam('person', personId), strParam('role', role)],
  );
  if (rows.length > 0) await noteSearchWrite({ type: 'initiative', id: projectId });
  return { removed: rows.length > 0 };
}
