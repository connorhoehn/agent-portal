// Projects provider — reads project data from Aurora PostgreSQL via RDS Data API.
// Tables: projects(id, name, status, created_at), project_contributions(person_id, project_id, role, weight), people(id, name, title, team)
// Does NOT import from or modify types.ts or aurora.ts — all types and exec are local.

import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';

import { config } from '../config.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProjectSummary {
  id: string;
  name: string;
  status: string | null;
  contributorCount: number;
  createdAt: string | null;
  topContributorNames: string[];
  lastActivityAt: string | null;
}

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
// IDs here intentionally match the proj-* IDs used in providers/work-items.ts
// so that navigating from the projects list to a project detail page resolves
// the same mock work items.

const MOCK_PROJECTS: ProjectSummary[] = [
  {
    id: 'proj-k8s', name: 'Kubernetes Cluster Upgrade', status: 'active', contributorCount: 5,
    createdAt: '2026-04-06T12:00:00Z',
    topContributorNames: ['Alex Chen', 'Maria Santos', 'Priya Patel', 'Ahmed Hassan'],
    lastActivityAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'proj-istio', name: 'Istio Service Mesh Migration', status: 'active', contributorCount: 4,
    createdAt: '2026-03-22T12:00:00Z',
    topContributorNames: ['Alex Chen', 'Sophie Turner', 'Priya Patel', "Ryan O'Brien"],
    lastActivityAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
  },
  {
    id: 'proj-cicd', name: 'CI/CD Pipeline Unification', status: 'active', contributorCount: 4,
    createdAt: '2026-04-01T12:00:00Z',
    topContributorNames: ['Maria Santos', 'Sophie Turner', 'James Wright', 'David Kim'],
    lastActivityAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'proj-otel', name: 'Unified Observability Stack', status: 'active', contributorCount: 3,
    createdAt: '2026-03-12T12:00:00Z',
    topContributorNames: ['Ben Foster', 'Alex Chen', 'David Kim'],
    lastActivityAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  },
  {
    id: 'proj-cedar', name: 'Cedar Auth Policy Migration', status: 'active', contributorCount: 3,
    createdAt: '2026-03-26T12:00:00Z',
    topContributorNames: ['Sophie Turner', 'James Wright', 'David Kim'],
    lastActivityAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
  },
  {
    id: 'proj-onboard', name: 'Developer Onboarding Improvements', status: 'planning', contributorCount: 3,
    createdAt: '2026-04-21T12:00:00Z',
    topContributorNames: ['David Kim', 'James Wright', "Ryan O'Brien"],
    lastActivityAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

// Owner fields are defaulted at the return site so the fixtures don't need
// per-entry churn every time the detail shape grows.
const MOCK_PROJECT_DETAILS: Record<string, Omit<ProjectDetail, 'ownerId' | 'ownerName'>> = {
  'proj-k8s': {
    id: 'proj-k8s', name: 'Kubernetes Cluster Upgrade', status: 'active',
    createdAt: '2026-04-06T12:00:00Z',
    contributors: [
      { personId: 'p-001', name: 'Alex Chen',    title: 'Staff Engineer',        role: 'Tech Lead',         weight: 0.40 },
      { personId: 'p-002', name: 'Maria Santos', title: 'Senior Engineer',        role: 'Engineer',          weight: 0.25 },
      { personId: 'p-004', name: 'Priya Patel',  title: 'Senior Engineer',        role: 'Engineer',          weight: 0.15 },
      { personId: 'p-013', name: 'Ahmed Hassan', title: 'ML Engineer',            role: 'Stakeholder',       weight: 0.10 },
      { personId: 'p-009', name: "Ryan O'Brien",  title: 'Technical Writer',      role: 'Documentation',     weight: 0.10 },
    ],
  },
  'proj-istio': {
    id: 'proj-istio', name: 'Istio Service Mesh Migration', status: 'active',
    createdAt: '2026-03-22T12:00:00Z',
    contributors: [
      { personId: 'p-001', name: 'Alex Chen',     title: 'Staff Engineer',  role: 'Tech Lead',  weight: 0.40 },
      { personId: 'p-022', name: 'Sophie Turner', title: 'Security Engineer', role: 'Engineer',  weight: 0.30 },
      { personId: 'p-004', name: 'Priya Patel',   title: 'Senior Engineer', role: 'Engineer',   weight: 0.20 },
      { personId: 'p-009', name: "Ryan O'Brien",   title: 'Technical Writer', role: 'Docs',      weight: 0.10 },
    ],
  },
  'proj-cicd': {
    id: 'proj-cicd', name: 'CI/CD Pipeline Unification', status: 'active',
    createdAt: '2026-04-01T12:00:00Z',
    contributors: [
      { personId: 'p-002', name: 'Maria Santos', title: 'Senior Engineer',  role: 'Tech Lead',  weight: 0.45 },
      { personId: 'p-022', name: 'Sophie Turner', title: 'Security Engineer', role: 'Security', weight: 0.25 },
      { personId: 'p-003', name: 'James Wright', title: 'Engineer',          role: 'Engineer',  weight: 0.20 },
      { personId: 'p-005', name: 'David Kim',    title: 'Engineering Manager', role: 'PM',      weight: 0.10 },
    ],
  },
  'proj-otel': {
    id: 'proj-otel', name: 'Unified Observability Stack', status: 'active',
    createdAt: '2026-03-12T12:00:00Z',
    contributors: [
      { personId: 'p-021', name: 'Ben Foster',    title: 'SRE Lead',        role: 'Tech Lead',  weight: 0.55 },
      { personId: 'p-001', name: 'Alex Chen',     title: 'Staff Engineer',  role: 'Architect',  weight: 0.25 },
      { personId: 'p-005', name: 'David Kim',     title: 'Eng Manager',     role: 'Sponsor',    weight: 0.20 },
    ],
  },
  'proj-cedar': {
    id: 'proj-cedar', name: 'Cedar Auth Policy Migration', status: 'active',
    createdAt: '2026-03-26T12:00:00Z',
    contributors: [
      { personId: 'p-022', name: 'Sophie Turner', title: 'Security Engineer', role: 'Tech Lead', weight: 0.50 },
      { personId: 'p-003', name: 'James Wright',  title: 'Engineer',          role: 'Engineer',  weight: 0.30 },
      { personId: 'p-005', name: 'David Kim',     title: 'Eng Manager',       role: 'Sponsor',   weight: 0.20 },
    ],
  },
  'proj-onboard': {
    id: 'proj-onboard', name: 'Developer Onboarding Improvements', status: 'planning',
    createdAt: '2026-04-21T12:00:00Z',
    contributors: [
      { personId: 'p-005', name: 'David Kim',    title: 'Eng Manager',   role: 'Sponsor',  weight: 0.40 },
      { personId: 'p-003', name: 'James Wright', title: 'Engineer',      role: 'Engineer', weight: 0.35 },
      { personId: 'p-009', name: "Ryan O'Brien",  title: 'Tech Writer',  role: 'Docs',     weight: 0.25 },
    ],
  },
};

// ─── Provider functions ──────────────────────────────────────────────────────

export async function listProjects(opts: {
  status?: string;
  limit?: number;
}): Promise<ProjectSummary[]> {
  if (config.mock.aurora) {
    let items = MOCK_PROJECTS.slice();
    if (opts.status) items = items.filter((p) => p.status === opts.status);
    return items.slice(0, Math.min(opts.limit ?? 50, 200));
  }

  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const params: SqlParameter[] = [intParam('lim', limit)];
  const whereClause = opts.status
    ? (params.push(strParam('status', opts.status)), 'WHERE p.status = :status')
    : '';

  // Note: projects table has (id, name, status, created_at) — no updated_at.
  // Top contributor names are fetched via a correlated subquery to avoid
  // blowing up GROUP BY with per-row ARRAY_AGG on large tables.
  const sql = `
    SELECT
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
      ) AS top_names
    FROM projects p
    LEFT JOIN project_contributions pc ON pc.project_id = p.id
    ${whereClause}
    GROUP BY p.id, p.name, p.status, p.created_at
    ORDER BY contributor_count DESC, p.created_at DESC
    LIMIT :lim
  `;

  const rows = await exec(sql, params);
  return rows.map((r) => {
    const createdAt = r['created_at'] != null ? String(r['created_at']) : null;
    const rawTopNames = r['top_names'] != null ? String(r['top_names']) : null;
    return {
      id: String(r['id'] ?? ''),
      name: String(r['name'] ?? ''),
      status: r['status'] != null ? String(r['status']) : null,
      contributorCount: Number(r['contributor_count'] ?? 0),
      createdAt,
      topContributorNames: rawTopNames
        ? rawTopNames.split('|||').filter((n) => n.length > 0)
        : [],
      lastActivityAt: createdAt,
    };
  });
}

export async function getProject(id: string): Promise<ProjectDetail | null> {
  if (config.mock.aurora) {
    const mock = MOCK_PROJECT_DETAILS[id];
    if (!mock) return null;
    // First contributor stands in as owner so the "Run by" surface is
    // demonstrable in mock mode.
    const lead = mock.contributors[0];
    return { ...mock, ownerId: lead?.personId ?? null, ownerName: lead?.name ?? null };
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
