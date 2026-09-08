// Environments — where an initiative's code runs.
//
// The third noun in the delivery picture: `projects` holds the initiative and
// the people accountable for it, `agent_projects` holds the repositories that
// deliver it, and this holds the places the delivered code lands.
//
// Descriptive, not operational. Nothing here deploys, promotes, restarts or
// scales an environment — the linked repositories have GitHub Actions for
// that, and this product only reports what those runs did (see
// lib/github-connector.ts listWorkflowRuns). Every row is a statement of what
// exists and how a box would reach it.
//
// `accessRoleArn` is the interesting field and the reason this is more than a
// registry: it is the IAM role a devbox assumes to get inside. Publishing the
// role NAME grants nothing — Cedar decides whether a principal may reach an
// environment at all (EnterEnvironment, lib/authz.ts + the routes), and IAM
// decides what the assumed role may do once there. Because the column holds no
// secret, the read side can be wide without leaking anything.
//
// Schema: schema/environments_schema.sql.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { agentProjects } from '../mock/agent-projects.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function nul(name: string): SqlParameter { return { name, value: { isNull: true } }; }
function maybe(name: string, v: string | null | undefined): SqlParameter {
  return v ? s(name, v) : nul(name);
}
function n(name: string, value: number): SqlParameter { return { name, value: { longValue: Math.trunc(value) } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }
const isUuid = (v: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** The shapes an environment can take. `eks` is the common one, not the only one. */
export const ENVIRONMENT_KINDS = ['eks', 'ecs', 'lambda', 'static', 'rds', 'other'] as const;
export type EnvironmentKind = (typeof ENVIRONMENT_KINDS)[number];

/** Believed state, edited by a human — nothing here polls the environment. */
export const ENVIRONMENT_STATUSES = ['active', 'provisioning', 'degraded', 'retired'] as const;
export type EnvironmentStatus = (typeof ENVIRONMENT_STATUSES)[number];

export interface Environment {
  id: string;
  orgProjectId: string;
  /** Denormalized for display — a bare `p-soc2` means nothing to a reader. */
  orgProjectName: string | null;
  name: string;
  kind: EnvironmentKind;
  awsAccountId: string;
  awsRegion: string;
  /** Null for everything that isn't a cluster, which is most of a mixed estate. */
  clusterName: string | null;
  clusterArn: string | null;
  namespace: string | null;
  /** The role a devbox assumes to reach this. A name, not a credential. */
  accessRoleArn: string | null;
  rank: number;
  status: EnvironmentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentInput {
  orgProjectId: string;
  name: string;
  kind?: string;
  awsAccountId: string;
  awsRegion?: string;
  clusterName?: string | null;
  clusterArn?: string | null;
  namespace?: string | null;
  accessRoleArn?: string | null;
  rank?: number;
  status?: string;
}

function rowToEnvironment(r: Record<string, unknown>): Environment {
  return {
    id: toStr(r['id']),
    orgProjectId: toStr(r['org_project_id']),
    orgProjectName: r['org_project_name'] ? toStr(r['org_project_name']) : null,
    name: toStr(r['name']),
    kind: toStr(r['kind'], 'other') as EnvironmentKind,
    awsAccountId: toStr(r['aws_account_id']),
    awsRegion: toStr(r['aws_region'], 'us-east-1'),
    clusterName: r['cluster_name'] ? toStr(r['cluster_name']) : null,
    clusterArn: r['cluster_arn'] ? toStr(r['cluster_arn']) : null,
    namespace: r['namespace'] ? toStr(r['namespace']) : null,
    accessRoleArn: r['access_role_arn'] ? toStr(r['access_role_arn']) : null,
    rank: toNum(r['rank']),
    status: toStr(r['status'], 'active') as EnvironmentStatus,
    createdAt: toStr(r['created_at']),
    updatedAt: toStr(r['updated_at']),
  };
}

/**
 * A small fixture for `npm run dev:mock`, mirroring schema/environments_schema.sql.
 *
 * Other providers return `[]` in mock mode, which is right when the surface is
 * a live feed. It is wrong here: an environments list that renders empty is
 * indistinguishable from an org that has described nothing, so the mock would
 * make the domain look broken rather than unconfigured. Kept deliberately
 * short — enough to show a dev→prod ordering, a non-EKS row and a prod that
 * doesn't exist yet, which are the three things the model is about.
 */
const MOCK_ENVIRONMENTS: Environment[] = [
  {
    id: 'b1f0a1e1-0001-4a00-8000-000000000001', orgProjectId: 'p-observability',
    orgProjectName: 'Unified Observability', name: 'dev', kind: 'eks',
    awsAccountId: '647757222309', awsRegion: 'us-east-1', clusterName: 'orgiq-dev',
    clusterArn: 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-dev', namespace: 'observability',
    accessRoleArn: 'arn:aws:iam::647757222309:role/orgiq-env-dev-access',
    rank: 0, status: 'active', createdAt: '', updatedAt: '',
  },
  {
    id: 'b1f0a1e1-0001-4a00-8000-000000000003', orgProjectId: 'p-observability',
    orgProjectName: 'Unified Observability', name: 'prod', kind: 'eks',
    awsAccountId: '647757222309', awsRegion: 'us-east-1', clusterName: 'orgiq-prod',
    clusterArn: 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod', namespace: 'observability',
    accessRoleArn: 'arn:aws:iam::647757222309:role/orgiq-env-prod-access',
    rank: 30, status: 'active', createdAt: '', updatedAt: '',
  },
  {
    id: 'b1f0a1e1-0004-4a00-8000-000000000002', orgProjectId: 'p-cost-opt',
    orgProjectName: 'Cloud Cost Optimization', name: 'prod', kind: 'lambda',
    awsAccountId: '647757222309', awsRegion: 'us-east-1', clusterName: null,
    clusterArn: null, namespace: null,
    accessRoleArn: 'arn:aws:iam::647757222309:role/orgiq-env-prod-access',
    rank: 30, status: 'active', createdAt: '', updatedAt: '',
  },
  {
    id: 'b1f0a1e1-0005-4a00-8000-000000000003', orgProjectId: 'p-rag-search',
    orgProjectName: 'RAG Search', name: 'prod', kind: 'eks',
    awsAccountId: '647757222309', awsRegion: 'us-east-1', clusterName: 'orgiq-prod',
    clusterArn: 'arn:aws:eks:us-east-1:647757222309:cluster/orgiq-prod', namespace: 'rag',
    accessRoleArn: null,
    rank: 30, status: 'provisioning', createdAt: '', updatedAt: '',
  },
];

const SELECT = `SELECT e.id, e.org_project_id, e.name, e.kind, e.aws_account_id, e.aws_region,
                       e.cluster_name, e.cluster_arn, e.namespace, e.access_role_arn,
                       e.rank, e.status, e.created_at, e.updated_at,
                       p.name AS org_project_name
                  FROM environments e
                  LEFT JOIN projects p ON p.id = e.org_project_id`;

/**
 * Every environment, or one initiative's.
 *
 * Ordered by initiative then `rank`, so dev precedes prod — the ordering
 * readers expect and the one no alphabetical sort produces.
 */
export async function listEnvironments(orgProjectId?: string | null): Promise<Environment[]> {
  if (config.mock.aurora) {
    return orgProjectId
      ? MOCK_ENVIRONMENTS.filter((e) => e.orgProjectId === orgProjectId)
      : MOCK_ENVIRONMENTS;
  }
  const where = orgProjectId ? ` WHERE e.org_project_id = :pid` : '';
  const rows = await exec(
    `${SELECT}${where} ORDER BY e.org_project_id, e.rank, e.name LIMIT 500`,
    orgProjectId ? [s('pid', orgProjectId)] : [],
  );
  return rows.map(rowToEnvironment);
}

export async function getEnvironment(id: string): Promise<Environment | null> {
  if (!isUuid(id)) return null;
  if (config.mock.aurora) return MOCK_ENVIRONMENTS.find((e) => e.id === id) ?? null;
  const rows = await exec(`${SELECT} WHERE e.id = :id::uuid`, [s('id', id)]);
  return rows[0] ? rowToEnvironment(rows[0]) : null;
}

/**
 * Describe an environment.
 *
 * Upserts on (org_project_id, name) rather than erroring: re-describing "the
 * staging cluster for auth" is a correction, not a new environment, and making
 * the caller delete-then-recreate would change the id that access decisions
 * and links are written against.
 */
export async function createEnvironment(input: EnvironmentInput): Promise<Environment> {
  const rows = await exec(
    `INSERT INTO environments
       (org_project_id, name, kind, aws_account_id, aws_region,
        cluster_name, cluster_arn, namespace, access_role_arn, rank, status)
     VALUES (:pid, :name, :kind, :acct, :region, :cluster, :carn, :ns, :role, :rank, :status)
     ON CONFLICT (org_project_id, name) DO UPDATE
       SET kind            = EXCLUDED.kind,
           aws_account_id  = EXCLUDED.aws_account_id,
           aws_region      = EXCLUDED.aws_region,
           cluster_name    = EXCLUDED.cluster_name,
           cluster_arn     = EXCLUDED.cluster_arn,
           namespace       = EXCLUDED.namespace,
           access_role_arn = EXCLUDED.access_role_arn,
           rank            = EXCLUDED.rank,
           status          = EXCLUDED.status,
           updated_at      = NOW()
     RETURNING *`,
    [
      s('pid', input.orgProjectId),
      s('name', input.name),
      s('kind', input.kind || 'eks'),
      s('acct', input.awsAccountId),
      s('region', input.awsRegion || 'us-east-1'),
      maybe('cluster', input.clusterName ?? null),
      maybe('carn', input.clusterArn ?? null),
      maybe('ns', input.namespace ?? null),
      maybe('role', input.accessRoleArn ?? null),
      n('rank', input.rank ?? 0),
      s('status', input.status || 'active'),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('environments insert returned no row');
  return rowToEnvironment(row);
}

/**
 * Patch an environment.
 *
 * Only the fields present in `patch` are touched — an update that sent every
 * column would silently blank whatever the caller didn't happen to load, and
 * blanking `access_role_arn` by accident revokes reachability. Column names are
 * from a fixed allowlist, never from caller keys; values always bind.
 */
export async function updateEnvironment(
  id: string,
  patch: Partial<Omit<EnvironmentInput, 'orgProjectId'>>,
): Promise<Environment | null> {
  if (!isUuid(id)) return null;

  const sets: string[] = [];
  const params: SqlParameter[] = [s('id', id)];

  const text: Array<[keyof typeof patch, string]> = [
    ['name', 'name'], ['kind', 'kind'], ['awsAccountId', 'aws_account_id'],
    ['awsRegion', 'aws_region'], ['status', 'status'],
  ];
  for (const [key, column] of text) {
    const v = patch[key];
    if (typeof v === 'string' && v.trim()) { sets.push(`${column} = :${column}`); params.push(s(column, v.trim())); }
  }

  // Nullable columns take an explicit null as a real value: clearing
  // `cluster_name` is how an environment stops being an EKS one.
  const nullable: Array<[keyof typeof patch, string]> = [
    ['clusterName', 'cluster_name'], ['clusterArn', 'cluster_arn'],
    ['namespace', 'namespace'], ['accessRoleArn', 'access_role_arn'],
  ];
  for (const [key, column] of nullable) {
    if (!(key in patch)) continue;
    const v = patch[key];
    sets.push(`${column} = :${column}`);
    params.push(typeof v === 'string' && v.trim() ? s(column, v.trim()) : nul(column));
  }

  if (typeof patch.rank === 'number' && Number.isFinite(patch.rank)) {
    sets.push('rank = :rank');
    params.push(n('rank', patch.rank));
  }

  if (sets.length === 0) return getEnvironment(id);

  const rows = await exec(
    `UPDATE environments SET ${sets.join(', ')}, updated_at = NOW()
      WHERE id = :id::uuid RETURNING *`,
    params,
  );
  return rows[0] ? rowToEnvironment(rows[0]) : null;
}

/**
 * The repository that delivers an initiative, if one is linked.
 *
 * Environments don't own a repo reference of their own — that link already
 * exists on `agent_projects.org_project_id`, and duplicating it here would let
 * the two disagree about which repository ships an initiative. The workflow-run
 * report (GET /api/environments/:id/runs) resolves the repo through the
 * initiative for exactly that reason.
 *
 * The offline branch reads the SAME fixture the linked-codebase surface reads
 * (mock/agent-projects.ts), rather than a second copy of the mapping. It used
 * to return `null` unconditionally, which made every environment in `dev:mock`
 * claim "No repository is linked to this initiative" — a statement the seed
 * flatly contradicts: `schema/seed_program.sql` links one repository to each
 * of the fourteen initiatives, including all three that have an environment.
 * A mock that answers a question wrongly is worse than one that cannot answer
 * it, because the wrong answer looks like a finding.
 */
export async function repoForInitiative(
  orgProjectId: string,
): Promise<{ repoFullName: string; connectionName: string | null } | null> {
  if (config.mock.aurora) {
    // `ORDER BY created_at ASC LIMIT 1` — the oldest link wins, matching the
    // statement below, so the offline answer and the live one pick the same
    // repository when an initiative has more than one.
    const linked = agentProjects.rows()
      .filter((p) => p.orgProjectId === orgProjectId)
      .slice()
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return linked
      ? { repoFullName: linked.repoFullName, connectionName: linked.connectionName }
      : null;
  }
  const rows = await exec(
    `SELECT repo_full_name, connection_name
       FROM agent_projects
      WHERE org_project_id = :pid
      ORDER BY created_at ASC LIMIT 1`,
    [s('pid', orgProjectId)],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    repoFullName: toStr(row['repo_full_name']),
    connectionName: row['connection_name'] ? toStr(row['connection_name']) : null,
  };
}

export async function deleteEnvironment(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await exec(`DELETE FROM environments WHERE id = :id::uuid RETURNING id`, [s('id', id)]);
  return rows.length > 0;
}
