// Identity provider — tenants, login-able users, and per-tenant role grants
// from Aurora via the RDS Data API (schema/identity_schema.sql). Self-contained
// like newsroom-articles.ts: no imports from aurora.ts/types.ts.
//
// When Aurora is unreachable or the identity tables don't exist yet, falls back
// to an in-memory mirror of the seed data so local dev works with no database.

import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';

import { config } from '../config.js';
import type { Grants } from '../lib/session.js';

export interface TenantInfo {
  id: string;
  displayName: string;
  status: string;
}

export interface UserInfo {
  id: string;
  displayName: string;
  email: string | null;
  personId: string | null;
  grants: Grants;
}

// ── Fallback seed mirror (matches schema/identity_schema.sql) ────────────────

const FALLBACK_TENANTS: TenantInfo[] = [
  { id: 'orgiq', displayName: 'OrgIQ', status: 'ACTIVE' },
  { id: 'newsroom', displayName: 'Newsroom', status: 'ACTIVE' },
];

const FALLBACK_USERS: UserInfo[] = [
  { id: 'u-operator', displayName: 'Platform Operator', email: 'operator@orgiq.example', personId: null,
    grants: { orgiq: ['admin'], newsroom: ['admin'] } },
  { id: 'u-theo', displayName: 'Theo Chang', email: 'theo.chang@orgiq.example', personId: 'p-001',
    grants: { orgiq: ['member'] } },
  { id: 'u-vera', displayName: 'Vera Green', email: 'vera.green@orgiq.example', personId: 'p-002',
    grants: { orgiq: ['org-leader', 'member'] } },
  { id: 'u-hr', displayName: 'Priya Desai', email: 'priya.desai@orgiq.example', personId: null,
    grants: { orgiq: ['hr-admin'] } },
  { id: 'u-reporter', displayName: 'Marcus Webb', email: 'marcus.webb@newsroom.example', personId: null,
    grants: { newsroom: ['reporter'] } },
  { id: 'u-editor', displayName: 'Elena Ortiz', email: 'elena.ortiz@newsroom.example', personId: null,
    grants: { newsroom: ['editor', 'reporter'] } },
];

// ── RDS Data API helpers (local to this module) ──────────────────────────────

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

function auroraConfigured(): boolean {
  return !!(config.aurora?.clusterArn && config.aurora?.secretArn);
}

async function exec(sql: string, params: SqlParameter[] = []): Promise<unknown[][]> {
  const out = await getClient().send(new ExecuteStatementCommand({
    resourceArn: config.aurora.clusterArn,
    secretArn: config.aurora.secretArn,
    database: config.aurora.database,
    sql,
    parameters: params,
  }));
  return (out.records ?? []).map(row => row.map(readField));
}

function str(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

// ── Queries ──────────────────────────────────────────────────────────────────

function groupGrants(rows: unknown[][]): Map<string, Grants> {
  const byUser = new Map<string, Grants>();
  for (const [userId, tenantId, role] of rows) {
    const g = byUser.get(userId as string) ?? {};
    (g[tenantId as string] ??= []).push(role as string);
    byUser.set(userId as string, g);
  }
  return byUser;
}

export async function listTenants(): Promise<TenantInfo[]> {
  if (!auroraConfigured()) return FALLBACK_TENANTS;
  try {
    const rows = await exec(`SELECT id, display_name, status FROM tenants ORDER BY id`);
    if (rows.length === 0) return FALLBACK_TENANTS;
    return rows.map(([id, displayName, status]) => ({
      id: id as string, displayName: displayName as string, status: status as string,
    }));
  } catch {
    return FALLBACK_TENANTS;
  }
}

export async function listUsers(): Promise<UserInfo[]> {
  if (!auroraConfigured()) return FALLBACK_USERS;
  try {
    const users = await exec(
      `SELECT id, display_name, email, person_id FROM app_users ORDER BY display_name`);
    if (users.length === 0) return FALLBACK_USERS;
    const grants = groupGrants(await exec(
      `SELECT user_id, tenant_id, role FROM user_tenant_roles ORDER BY granted_at`));
    return users.map(([id, displayName, email, personId]) => ({
      id: id as string,
      displayName: displayName as string,
      email: (email as string | null) ?? null,
      personId: (personId as string | null) ?? null,
      grants: grants.get(id as string) ?? {},
    }));
  } catch {
    return FALLBACK_USERS;
  }
}

export async function getUser(userId: string): Promise<UserInfo | null> {
  if (!auroraConfigured()) return FALLBACK_USERS.find(u => u.id === userId) ?? null;
  try {
    const rows = await exec(
      `SELECT id, display_name, email, person_id FROM app_users WHERE id = :id`,
      [str('id', userId)]);
    if (rows.length === 0) return FALLBACK_USERS.find(u => u.id === userId) ?? null;
    const [id, displayName, email, personId] = rows[0]!;
    const grantRows = await exec(
      `SELECT user_id, tenant_id, role FROM user_tenant_roles WHERE user_id = :id ORDER BY granted_at`,
      [str('id', userId)]);
    return {
      id: id as string,
      displayName: displayName as string,
      email: (email as string | null) ?? null,
      personId: (personId as string | null) ?? null,
      grants: groupGrants(grantRows).get(id as string) ?? {},
    };
  } catch {
    return FALLBACK_USERS.find(u => u.id === userId) ?? null;
  }
}

// ── Provisioning (admin UI) ──────────────────────────────────────────────────

export async function createTenant(id: string, displayName: string): Promise<TenantInfo> {
  if (!auroraConfigured()) throw new Error('Aurora not configured — cannot provision tenants');
  await exec(
    `INSERT INTO tenants (id, display_name) VALUES (:id, :name) ON CONFLICT (id) DO NOTHING`,
    [str('id', id), str('name', displayName)]);
  return { id, displayName, status: 'ACTIVE' };
}

export async function createUser(
  input: { id: string; displayName: string; email?: string; personId?: string },
): Promise<void> {
  if (!auroraConfigured()) throw new Error('Aurora not configured — cannot provision users');
  const params = [str('id', input.id), str('name', input.displayName)];
  await exec(
    `INSERT INTO app_users (id, display_name, email, person_id)
     VALUES (:id, :name, ${input.email ? ':email' : 'NULL'}, ${input.personId ? ':person' : 'NULL'})
     ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email`,
    [
      ...params,
      ...(input.email ? [str('email', input.email)] : []),
      ...(input.personId ? [str('person', input.personId)] : []),
    ]);
}

/** Replace a user's grants wholesale (the admin UI edits the full matrix). */
export async function setGrants(userId: string, grants: Grants): Promise<void> {
  if (!auroraConfigured()) throw new Error('Aurora not configured — cannot edit grants');
  await exec(`DELETE FROM user_tenant_roles WHERE user_id = :id`, [str('id', userId)]);
  for (const [tenant, roles] of Object.entries(grants)) {
    for (const role of roles) {
      await exec(
        `INSERT INTO user_tenant_roles (user_id, tenant_id, role)
         VALUES (:id, :tenant, :role) ON CONFLICT DO NOTHING`,
        [str('id', userId), str('tenant', tenant), str('role', role)]);
    }
  }
}
