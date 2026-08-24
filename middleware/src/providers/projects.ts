// Projects provider — reads project data from Aurora PostgreSQL via RDS Data API.
// Tables: projects(id, name, status, created_at), project_contributions(person_id, project_id, role, weight), people(id, name, title, team)
// Does NOT import from or modify types.ts or aurora.ts — all types and exec are
// local. The single exception is PERIOD_START_SQL from budgets.ts: the agent
// spend window is one fact and duplicating it is what let the two pages
// disagree in the first place.

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
import { PERIOD_START_SQL } from './budgets.js';

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
}

/** The rollup fields defaulted for mock mode and the legacy fallback. */
const EMPTY_ROLLUPS: Pick<ProjectSummary,
  'ownerId' | 'ownerName' | 'smeNames' | 'openStories' | 'openBugs'
  | 'pointsDone' | 'pointsTotal' | 'agentSpendUsd' | 'lastAgentActivityAt'> = {
  ownerId: null, ownerName: null, smeNames: [],
  openStories: null, openBugs: null, pointsDone: null, pointsTotal: null,
  agentSpendUsd: null, lastAgentActivityAt: null,
};

export interface ProjectDetail {
  id: string;
  name: string;
  status: string | null;
  createdAt: string | null;
  /** The one person running this initiative (projects.owner_id) — null when
      unset or when the column predates the work-items schema. */
  ownerId: string | null;
  ownerName: string | null;
  contributors: Array<{
    personId: string;
    name: string;
    title: string | null;
    role: string | null;
    weight: number;
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
  'p-008': { personId: 'p-008', name: 'Layla Hassan',    title: 'SRE Lead' },
  'p-011': { personId: 'p-011', name: 'Eli Garcia',      title: 'Senior SRE' },
  'p-013': { personId: 'p-013', name: 'Caleb Turner',    title: 'Senior Engineer' },
  'p-015': { personId: 'p-015', name: 'Raj Mehta',       title: 'Data Engineer' },
  'p-017': { personId: 'p-017', name: 'Daniel Chang',    title: 'Staff Data Engineer' },
  'p-019': { personId: 'p-019', name: 'Lena Dubois',     title: 'Senior Data Engineer' },
  'p-024': { personId: 'p-024', name: 'Theo Williams',   title: 'Staff Engineer' },
  'p-025': { personId: 'p-025', name: 'Aisha Mehta',     title: 'Principal Engineer' },
  'p-026': { personId: 'p-026', name: 'Mateo Green',     title: 'Senior UX Researcher' },
  'p-030': { personId: 'p-030', name: 'Mia Singh',       title: 'Group PM' },
  'p-034': { personId: 'p-034', name: 'Asher Wright',    title: 'Accessibility Specialist' },
  'p-035': { personId: 'p-035', name: 'Ben Okafor',      title: 'Staff Designer' },
  'p-038': { personId: 'p-038', name: 'Isabel Vasquez',  title: 'Design Engineer' },
  'p-042': { personId: 'p-042', name: 'Vera Petrov',     title: 'Staff ML Engineer' },
  'p-043': { personId: 'p-043', name: 'Bria Petrov',     title: 'Staff ML Engineer' },
  'p-044': { personId: 'p-044', name: 'Aisha Thompson',  title: 'Staff Engineer' },
  'p-047': { personId: 'p-047', name: 'Nina Rivera',     title: 'Staff ML Engineer' },
  'p-048': { personId: 'p-048', name: 'Lucas Kim',       title: 'Staff ML Engineer' },
  'p-049': { personId: 'p-049', name: 'Hiro Mancini',    title: 'Engineering Manager' },
  'p-051': { personId: 'p-051', name: 'Nora Chang',      title: 'Senior Security Engineer' },
  'p-052': { personId: 'p-052', name: 'Hugo DaSilva',    title: 'Security Lead' },
  'p-055': { personId: 'p-055', name: 'Mia Chen',        title: 'Senior Security Engineer' },
  'p-056': { personId: 'p-056', name: 'Hugo Lee',        title: 'Security Engineer' },
};

interface MockInitiative {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  owner: string;
  smes: string[];
  /** Hours since the last agent run on this initiative. */
  activeHoursAgo: number;
}

const MOCK_INITIATIVES: MockInitiative[] = [
  { id: 'p-observability',     name: 'Observability Platform',       status: 'in_progress', createdAt: '2026-05-24T12:00:00Z', owner: 'p-004', smes: ['p-008', 'p-011'], activeHoursAgo: 1 },
  { id: 'p-auth-migration',    name: 'Auth Migration',               status: 'in_progress', createdAt: '2026-06-05T12:00:00Z', owner: 'p-002', smes: ['p-051', 'p-004'], activeHoursAgo: 3 },
  { id: 'p-llm-platform',      name: 'LLM Application Platform',     status: 'in_progress', createdAt: '2026-06-19T12:00:00Z', owner: 'p-047', smes: ['p-042', 'p-013'], activeHoursAgo: 2 },
  { id: 'p-cost-opt',          name: 'Cost Optimization',            status: 'in_progress', createdAt: '2026-05-30T12:00:00Z', owner: 'p-008', smes: ['p-011', 'p-017'], activeHoursAgo: 5 },
  { id: 'p-realtime-analytics', name: 'Real-time Analytics Pipeline', status: 'in_progress', createdAt: '2026-06-24T12:00:00Z', owner: 'p-017', smes: ['p-019', 'p-024'], activeHoursAgo: 9 },
  { id: 'p-data-lake',         name: 'Data Lake Migration',          status: 'planning',    createdAt: '2026-08-01T12:00:00Z', owner: 'p-025', smes: ['p-017', 'p-015'], activeHoursAgo: 40 },
  { id: 'p-feature-store',     name: 'ML Feature Store',             status: 'in_progress', createdAt: '2026-06-28T12:00:00Z', owner: 'p-042', smes: ['p-019', 'p-044'], activeHoursAgo: 12 },
  { id: 'p-mobile-redesign',   name: 'Mobile App Redesign',          status: 'in_progress', createdAt: '2026-06-12T12:00:00Z', owner: 'p-030', smes: ['p-035', 'p-026'], activeHoursAgo: 18 },
  { id: 'p-design-v3',         name: 'Design System v3',             status: 'in_progress', createdAt: '2026-07-03T12:00:00Z', owner: 'p-035', smes: ['p-038', 'p-034'], activeHoursAgo: 26 },
  { id: 'p-design-system-api', name: 'Design System API',            status: 'in_progress', createdAt: '2026-07-10T12:00:00Z', owner: 'p-038', smes: ['p-035', 'p-001'], activeHoursAgo: 30 },
  { id: 'p-inference-platform', name: 'Inference Platform',          status: 'in_progress', createdAt: '2026-06-15T12:00:00Z', owner: 'p-049', smes: ['p-013', 'p-043'], activeHoursAgo: 7 },
  { id: 'p-rag-search',        name: 'RAG Knowledge Search',         status: 'completed',   createdAt: '2026-04-18T12:00:00Z', owner: 'p-048', smes: ['p-047'],          activeHoursAgo: 22 },
  { id: 'p-soc2',              name: 'SOC2 Compliance',              status: 'in_progress', createdAt: '2026-06-22T12:00:00Z', owner: 'p-052', smes: ['p-055', 'p-051'], activeHoursAgo: 14 },
  { id: 'p-zero-trust',        name: 'Zero Trust Network',           status: 'planning',    createdAt: '2026-08-08T12:00:00Z', owner: 'p-051', smes: ['p-052', 'p-056'], activeHoursAgo: 48 },
];

const HOUR_MS = 60 * 60 * 1000;

const MOCK_PROJECTS: Array<Omit<ProjectSummary, keyof typeof EMPTY_ROLLUPS>> = MOCK_INITIATIVES.map((p) => ({
  id: p.id,
  name: p.name,
  status: p.status,
  contributorCount: 1 + p.smes.length,
  createdAt: p.createdAt,
  topContributorNames: [p.owner, ...p.smes].map((id) => CAST[id]!.name),
  lastActivityAt: new Date(Date.now() - p.activeHoursAgo * HOUR_MS).toISOString(),
}));

// Owner fields are defaulted at the return site so the fixtures don't need
// per-entry churn every time the detail shape grows.
const MOCK_PROJECT_DETAILS: Record<string, Omit<ProjectDetail, 'ownerId' | 'ownerName'>> =
  Object.fromEntries(MOCK_INITIATIVES.map((p) => [p.id, {
    id: p.id,
    name: p.name,
    status: p.status,
    createdAt: p.createdAt,
    contributors: [
      { ...CAST[p.owner]!, role: 'owner', weight: 1.0 },
      ...p.smes.map((id) => ({ ...CAST[id]!, role: 'sme', weight: 0.8 })),
    ],
  }]));

// ─── Provider functions ──────────────────────────────────────────────────────

export async function listProjects(opts: {
  status?: string;
  limit?: number;
}): Promise<ProjectSummary[]> {
  if (config.mock.aurora) {
    let items = MOCK_PROJECTS.slice();
    if (opts.status) items = items.filter((p) => p.status === opts.status);
    // The cast's first entry is the initiative owner by construction, and the
    // rest are its SMEs — same shape the real rollup returns.
    return items.slice(0, Math.min(opts.limit ?? 50, 200)).map((p) => {
      const cast = MOCK_INITIATIVES.find((m) => m.id === p.id);
      return {
        ...p, ...EMPTY_ROLLUPS,
        ownerId: cast?.owner ?? null,
        ownerName: p.topContributorNames[0] ?? null,
        smeNames: p.topContributorNames.slice(1),
      };
    });
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const params: SqlParameter[] = [intParam('lim', limit)];
  const whereClause = opts.status
    ? (params.push(strParam('status', opts.status)), 'WHERE p.status = :status')
    : '';

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
  const attributionPredicate = `
        br.cost_usd IS NOT NULL AND (
          br.work_item_id IN (SELECT w2.id FROM work_items w2 WHERE w2.project_id = p.id)
          OR br.bot_id IN (
            SELECT b.id FROM bots b
             WHERE b.org_project_id = p.id
                OR b.agent_project_id IN (SELECT ap.id FROM agent_projects ap WHERE ap.org_project_id = p.id)
          )
        )`;
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
      (SELECT COALESCE(SUM(br.cost_usd), 0)::float8 FROM bot_runs br WHERE ${spendPredicate}) AS agent_spend_usd,
      (SELECT MAX(br.started_at) FROM bot_runs br WHERE ${attributionPredicate}) AS last_agent_activity_at`;

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
      } : EMPTY_ROLLUPS),
    };
  });
}

export async function getProject(id: string): Promise<ProjectDetail | null> {
  if (config.mock.aurora) {
    const mock = MOCK_PROJECT_DETAILS[id];
    if (!mock) return null;
    // contributors[0] is the owner by construction (see MOCK_INITIATIVES).
    const owner = mock.contributors[0];
    return { ...mock, ownerId: owner?.personId ?? null, ownerName: owner?.name ?? null };
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

  return {
    id: String(proj['id'] ?? ''),
    name: String(proj['name'] ?? ''),
    status: proj['status'] != null ? String(proj['status']) : null,
    createdAt: proj['created_at'] != null ? String(proj['created_at']) : null,
    ownerId,
    ownerName,
    contributors: contribRows.map((r) => ({
      personId: String(r['person_id'] ?? ''),
      name: String(r['name'] ?? ''),
      title: r['title'] != null ? String(r['title']) : null,
      role: r['role'] != null ? String(r['role']) : null,
      weight: Number(r['weight'] ?? 0),
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
  return { ok: true };
}
