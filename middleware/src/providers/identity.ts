// Identity provider — tenants, login-able users, and per-tenant role grants
// from Aurora via the RDS Data API (schema/identity_schema.sql). Self-contained:
// no imports from aurora.ts/types.ts.
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
  /** Session-invalidation generation (app_users.session_epoch), default 0.
   * Bumped by bumpSessionEpoch on a tenant/role switch or sign-out-others. */
  epoch: number;
  /** The IdP subject (app_users.external_sub) once the user has signed in via
   * SSO; absent for fallback/seed users and picker-only accounts. Read by the
   * realtime token bridge (routes/session.ts) so a gateway can correlate the
   * OrgIQ identity with the Cognito one. */
  externalSub?: string | null;
}

// ── Fallback seed mirror (matches schema/identity_schema.sql) ────────────────

const FALLBACK_TENANTS: TenantInfo[] = [
  { id: 'orgiq', displayName: 'OrgIQ', status: 'ACTIVE' },
  { id: 'assessment', displayName: 'Assessment', status: 'ACTIVE' },
];

// Mutable epoch: bumpSessionEpoch increments in place so dev:mock exercises the
// same sign-out-others / switch-invalidation semantics as Aurora.
const FALLBACK_USERS: UserInfo[] = [
  { id: 'u-operator', displayName: 'Platform Operator', email: 'operator@orgiq.example', personId: null,
    grants: { orgiq: ['admin'], assessment: ['admin'] }, epoch: 0 },
  { id: 'u-theo', displayName: 'Theo Chang', email: 'theo.chang@orgiq.example', personId: 'p-001',
    grants: { orgiq: ['member'] }, epoch: 0 },
  { id: 'u-vera', displayName: 'Vera Green', email: 'vera.green@orgiq.example', personId: 'p-002',
    grants: { orgiq: ['org-leader', 'member'] }, epoch: 0 },
  { id: 'u-hr', displayName: 'Priya Desai', email: 'priya.desai@orgiq.example', personId: null,
    grants: { orgiq: ['hr-admin'] }, epoch: 0 },
  // Program operating model cast — see docs/program-operating-model.md.
  { id: 'u-release', displayName: 'Sienna Garcia', email: 'sienna.garcia@orgiq.example', personId: 'p-005',
    grants: { orgiq: ['org-leader', 'member'] }, epoch: 0 },
  { id: 'u-rachel', displayName: 'Rachel Kowalski', email: 'rachel.kowalski@orgiq.example', personId: 'p-012',
    grants: { orgiq: ['hr-admin', 'org-leader'] }, epoch: 0 },
  // The program owner — runs the delivery program (sprints, bots, the board)
  // AND holds ManageBudgets on it: allocates the monthly budget and grants
  // sprint envelopes on the initiatives they own, the same allocation
  // authority hr-admin and org-leader hold. No leaderboard, no identity
  // admin, and ApproveTransaction stays forbidden — allocating is not
  // approving. See seeds/roles/orgiq/program-owner.cedar.
  { id: 'u-mia', displayName: 'Mia Singh', email: 'mia.singh@orgiq.example', personId: 'p-030',
    grants: { orgiq: ['program-owner', 'member'] }, epoch: 0 },
  { id: 'u-nora', displayName: 'Nora DaSilva', email: 'nora.dasilva@orgiq.example', personId: 'p-004',
    grants: { orgiq: ['sme'] }, epoch: 0 },
  { id: 'u-eli', displayName: 'Eli Garcia', email: 'eli.garcia@orgiq.example', personId: 'p-011',
    grants: { orgiq: ['sme'] }, epoch: 0 },
  { id: 'u-layla', displayName: 'Layla Hassan', email: 'layla.hassan@orgiq.example', personId: 'p-008',
    grants: { orgiq: ['sme'] }, epoch: 0 },
  { id: 'u-caleb', displayName: 'Caleb Turner', email: 'caleb.turner@orgiq.example', personId: 'p-013',
    grants: { orgiq: ['sme'] }, epoch: 0 },
  // Assessment tenant cast — see docs/assessment-tenant.md Roles (Cedar).
  { id: 'u-asha', displayName: 'Asha Nair', email: 'asha.nair@assessment.example', personId: null,
    grants: { assessment: ['assessor'] }, epoch: 0 },
  { id: 'u-jonas', displayName: 'Jonas Lindqvist', email: 'jonas.lindqvist@assessment.example', personId: null,
    grants: { assessment: ['lead-assessor', 'assessor'] }, epoch: 0 },
  { id: 'u-farah', displayName: 'Farah Osei', email: 'farah.osei@assessment.example', personId: null,
    grants: { assessment: ['program-lead', 'lead-assessor'] }, epoch: 0 },
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
      `SELECT id, display_name, email, person_id, session_epoch FROM app_users ORDER BY display_name`);
    if (users.length === 0) return FALLBACK_USERS;
    const grants = groupGrants(await exec(
      // tenant_id, role tie-break granted_at so the ordering is total and
      // deterministic — seed rows share a granted_at timestamp, so ordering by
      // it alone left multi-role users' landing role unstable.
      `SELECT user_id, tenant_id, role FROM user_tenant_roles ORDER BY granted_at, tenant_id, role`));
    return users.map(([id, displayName, email, personId, epoch]) => ({
      id: id as string,
      displayName: displayName as string,
      email: (email as string | null) ?? null,
      personId: (personId as string | null) ?? null,
      grants: grants.get(id as string) ?? {},
      epoch: (epoch as number | null) ?? 0,
    }));
  } catch {
    return FALLBACK_USERS;
  }
}

export async function getUser(userId: string, options: { authoritative?: boolean } = {}): Promise<UserInfo | null> {
  // Realtime grants must not revive a deleted/revoked seed identity during a
  // database outage. Only an explicitly mocked deployment may use fixtures.
  if (options.authoritative && config.mock?.aurora) return FALLBACK_USERS.find(u => u.id === userId) ?? null;
  if (!auroraConfigured()) {
    if (options.authoritative && !config.mock?.aurora) throw new Error('identity store unavailable');
    return FALLBACK_USERS.find(u => u.id === userId) ?? null;
  }
  try {
    const rows = await exec(
      `SELECT id, display_name, email, person_id, session_epoch, external_sub FROM app_users WHERE id = :id`,
      [str('id', userId)]);
    if (rows.length === 0) return options.authoritative ? null : FALLBACK_USERS.find(u => u.id === userId) ?? null;
    const [id, displayName, email, personId, epoch, externalSub] = rows[0]!;
    const grantRows = await exec(
      `SELECT user_id, tenant_id, role FROM user_tenant_roles WHERE user_id = :id ORDER BY granted_at, tenant_id, role`,
      [str('id', userId)]);
    return {
      id: id as string,
      displayName: displayName as string,
      email: (email as string | null) ?? null,
      personId: (personId as string | null) ?? null,
      grants: groupGrants(grantRows).get(id as string) ?? {},
      epoch: (epoch as number | null) ?? 0,
      externalSub: (externalSub as string | null | undefined) ?? null,
    };
  } catch (error) {
    if (options.authoritative) throw error;
    return FALLBACK_USERS.find(u => u.id === userId) ?? null;
  }
}

// ── IdP identity resolution (Cognito / OIDC) ─────────────────────────────────
// The BFF resolves an authenticated federated identity to an OrgIQ user by its
// external subject (app_users.external_sub), falling back to an email match the
// first time a user signs in (then linking the sub so later logins are direct).

async function hydrate(id: string, displayName: string, email: string | null, personId: string | null, epoch = 0): Promise<UserInfo> {
  const grantRows = await exec(
    `SELECT user_id, tenant_id, role FROM user_tenant_roles WHERE user_id = :id ORDER BY granted_at, tenant_id, role`,
    [str('id', id)]);
  return { id, displayName, email, personId, grants: groupGrants(grantRows).get(id) ?? {}, epoch };
}

/** Resolve an OrgIQ user by the IdP subject stored in app_users.external_sub. */
export async function getUserByExternalSub(sub: string): Promise<UserInfo | null> {
  if (!sub) return null;
  if (!auroraConfigured()) return null; // fallback users have no external_sub
  try {
    const rows = await exec(
      `SELECT id, display_name, email, person_id, session_epoch FROM app_users WHERE external_sub = :sub`,
      [str('sub', sub)]);
    if (rows.length === 0) return null;
    const [id, displayName, email, personId, epoch] = rows[0]!;
    return hydrate(id as string, displayName as string, (email as string | null) ?? null, (personId as string | null) ?? null, (epoch as number | null) ?? 0);
  } catch {
    return null;
  }
}

/** Resolve an OrgIQ user by email (case-insensitive) — the first-login link path. */
export async function getUserByEmail(email: string): Promise<UserInfo | null> {
  if (!email) return null;
  const needle = email.trim().toLowerCase();
  if (!auroraConfigured()) {
    return FALLBACK_USERS.find(u => (u.email ?? '').toLowerCase() === needle) ?? null;
  }
  try {
    const rows = await exec(
      `SELECT id, display_name, email, person_id, session_epoch FROM app_users WHERE lower(email) = :email`,
      [str('email', needle)]);
    if (rows.length === 0) {
      return FALLBACK_USERS.find(u => (u.email ?? '').toLowerCase() === needle) ?? null;
    }
    const [id, displayName, mail, personId, epoch] = rows[0]!;
    return hydrate(id as string, displayName as string, (mail as string | null) ?? null, (personId as string | null) ?? null, (epoch as number | null) ?? 0);
  } catch {
    return FALLBACK_USERS.find(u => (u.email ?? '').toLowerCase() === needle) ?? null;
  }
}

/** Link an IdP subject to an OrgIQ user so subsequent logins resolve directly.
 * Best-effort: a failure (e.g. Aurora unconfigured in local dev) is swallowed —
 * the session is still minted from the email match, it just isn't persisted. */
export async function linkExternalSub(userId: string, sub: string): Promise<void> {
  if (!auroraConfigured() || !userId || !sub) return;
  try {
    await exec(
      `UPDATE app_users SET external_sub = :sub WHERE id = :id`,
      [str('sub', sub), str('id', userId)]);
  } catch {
    // non-fatal — see doc comment
  }
}

/**
 * Bump a user's session_epoch, invalidating every previously-minted cookie for
 * them at the next grants-refresh (≤ GRANTS_REFRESH_S). Returns the new epoch so
 * the caller can re-issue the surviving cookie at the current generation.
 *
 * Mock path (Aurora unconfigured): increments the in-memory epoch so dev:mock
 * exercises the same invalidation. If the user isn't known even in the mock,
 * returns a best-effort 1 (a bump from the implicit epoch 0) rather than
 * throwing — matching linkExternalSub's swallow-when-unconfigured stance so a
 * switch never hard-fails on the epoch write.
 */
export async function bumpSessionEpoch(userId: string): Promise<number> {
  if (!auroraConfigured()) {
    const u = FALLBACK_USERS.find(x => x.id === userId);
    if (u) return (u.epoch = (u.epoch ?? 0) + 1);
    return 1;
  }
  const rows = await exec(
    `UPDATE app_users SET session_epoch = session_epoch + 1 WHERE id = :id RETURNING session_epoch`,
    [str('id', userId)]);
  return (rows[0]?.[0] as number | undefined) ?? 1;
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

/**
 * Session subject -> display name, for surfaces that store a subject and must
 * render a person. Synchronous and fallback-only on purpose: this is used by
 * the MOCK write paths, which cannot await, and the Aurora paths resolve the
 * same thing with a LEFT JOIN on app_users instead. Returns null rather than a
 * placeholder so the caller can fall back to the raw subject — printing
 * "unknown" would erase an attribution that genuinely exists.
 */
export function displayNameForSubject(subject: string | null | undefined): string | null {
  if (!subject) return null;
  return FALLBACK_USERS.find((u) => u.id === subject)?.displayName ?? null;
}
