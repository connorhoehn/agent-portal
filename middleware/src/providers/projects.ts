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
}

export interface ProjectDetail {
  id: string;
  name: string;
  status: string | null;
  createdAt: string | null;
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

// ─── Provider functions ──────────────────────────────────────────────────────

export async function listProjects(opts: {
  status?: string;
  limit?: number;
}): Promise<ProjectSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  const params: SqlParameter[] = [intParam('lim', limit)];
  const whereClause = opts.status
    ? (params.push(strParam('status', opts.status)), 'WHERE p.status = :status')
    : '';

  const sql = `
    SELECT
      p.id,
      p.name,
      p.status,
      p.created_at,
      COUNT(pc.person_id) AS contributor_count
    FROM projects p
    LEFT JOIN project_contributions pc ON pc.project_id = p.id
    ${whereClause}
    GROUP BY p.id, p.name, p.status, p.created_at
    ORDER BY contributor_count DESC, p.created_at DESC
    LIMIT :lim
  `;

  const rows = await exec(sql, params);
  return rows.map((r) => ({
    id: String(r['id'] ?? ''),
    name: String(r['name'] ?? ''),
    status: r['status'] != null ? String(r['status']) : null,
    contributorCount: Number(r['contributor_count'] ?? 0),
    createdAt: r['created_at'] != null ? String(r['created_at']) : null,
  }));
}

export async function getProject(id: string): Promise<ProjectDetail | null> {
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

  return {
    id: String(proj['id'] ?? ''),
    name: String(proj['name'] ?? ''),
    status: proj['status'] != null ? String(proj['status']) : null,
    createdAt: proj['created_at'] != null ? String(proj['created_at']) : null,
    contributors: contribRows.map((r) => ({
      personId: String(r['person_id'] ?? ''),
      name: String(r['name'] ?? ''),
      title: r['title'] != null ? String(r['title']) : null,
      role: r['role'] != null ? String(r['role']) : null,
      weight: Number(r['weight'] ?? 0),
    })),
  };
}
