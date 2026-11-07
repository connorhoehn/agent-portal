// Identity provider — tenants, login-able users, and per-tenant role grants
// from Aurora via the RDS Data API (schema/identity_schema.sql). Self-contained:
// no imports from aurora.ts/types.ts.
//
// When Aurora is unreachable or the identity tables don't exist yet, falls back
// to an in-memory mirror of the seed data so local dev works with no database.

import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';

import { config } from '../config.js';
import type { Grants } from '../lib/session.js';
import { TENANTS, TENANT_MANIFEST } from '../lib/tenants.generated.js';
import { identityGrantWritesFixture } from '../mock/identity-grants.js';
import {
  GRANT_ROLE_SQL, REVOKE_ROLE_SQL, applyGrantDiff, grantDiff, writeGrantSet, type GrantDiff,
} from '../lib/identity-grants-sql.js';
import {
  findClone, liveClones, removeClone, DEFAULT_CLONE_TTL_MS, MAX_CLONE_TTL_MS, MAX_CLONES,
  type IdentityCloneRow,
} from '../mock/identity-clones.js';
import { randomBytes } from 'node:crypto';
import { clock } from '../mock/core/index.js';
import { invalidateForUser } from '../lib/gateway/authority-invalidation.js';

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

// The tenants rows (schema/identity_schema.sql) mirror tenants/manifest.json;
// so does this fallback (DE-29).
const FALLBACK_TENANTS: TenantInfo[] = TENANTS.map((id) => ({ id, displayName: TENANT_MANIFEST[id].displayName, status: 'ACTIVE' }));

// Mutable epoch: bumpSessionEpoch increments in place so dev:mock exercises the
// same sign-out-others / switch-invalidation semantics as Aurora.
const FALLBACK_USERS: UserInfo[] = [
  { id: 'u-operator', displayName: 'Platform Operator', email: 'operator@orgiq.example', personId: null,
    grants: { orgiq: ['admin'], assessment: ['admin'], social: ['admin'], pipelines: ['admin'], access: ['admin'] }, epoch: 0 },
  { id: 'u-theo', displayName: 'Theo Chang', email: 'theo.chang@orgiq.example', personId: 'p-001',
    grants: { orgiq: ['member'], social: ['participant'] }, epoch: 0 },
  // Vera and Rachel also approve in Access: they steward Work's access steps
  // (Rachel the Work roles as hr-admin, Vera her initiative) — schema/identity_schema.sql.
  { id: 'u-vera', displayName: 'Vera Green', email: 'vera.green@orgiq.example', personId: 'p-002',
    grants: { orgiq: ['org-leader', 'member'], social: ['participant'], access: ['approver'] }, epoch: 0 },
  { id: 'u-hr', displayName: 'Helen Desai', email: 'helen.desai@orgiq.example', personId: null,
    grants: { orgiq: ['hr-admin'] }, epoch: 0 },
  // Program operating model cast — see docs/program-operating-model.md.
  { id: 'u-release', displayName: 'Sienna Garcia', email: 'sienna.garcia@orgiq.example', personId: 'p-005',
    grants: { orgiq: ['org-leader', 'member'], social: ['participant'] }, epoch: 0 },
  { id: 'u-rachel', displayName: 'Rachel Kowalski', email: 'rachel.kowalski@orgiq.example', personId: 'p-012',
    grants: { orgiq: ['hr-admin', 'org-leader'], social: ['participant'], access: ['approver'] }, epoch: 0 },
  // The program owner — runs the delivery program (sprints, bots, the board)
  // AND holds ManageBudgets on it: allocates the monthly budget and grants
  // sprint envelopes on the initiatives they own, the same allocation
  // authority hr-admin and org-leader hold. No leaderboard, no identity
  // admin, and ApproveTransaction stays forbidden — allocating is not
  // approving. See seeds/roles/orgiq/program-owner.cedar.
  { id: 'u-mia', displayName: 'Mia Singh', email: 'mia.singh@orgiq.example', personId: 'p-030',
    grants: { orgiq: ['program-owner', 'member'], social: ['participant'] }, epoch: 0 },
  { id: 'u-nora', displayName: 'Nora DaSilva', email: 'nora.dasilva@orgiq.example', personId: 'p-004',
    grants: { orgiq: ['sme'], social: ['participant'] }, epoch: 0 },
  { id: 'u-eli', displayName: 'Eli Garcia', email: 'eli.garcia@orgiq.example', personId: 'p-011',
    grants: { orgiq: ['sme'], social: ['participant'] }, epoch: 0 },
  { id: 'u-layla', displayName: 'Layla Hassan', email: 'layla.hassan@orgiq.example', personId: 'p-008',
    grants: { orgiq: ['sme'], social: ['participant'] }, epoch: 0 },
  { id: 'u-caleb', displayName: 'Caleb Turner', email: 'caleb.turner@orgiq.example', personId: 'p-013',
    grants: { orgiq: ['sme'], social: ['participant'] }, epoch: 0 },
  // Assessment tenant cast — see docs/assessment-tenant.md Roles (Cedar).
  { id: 'u-asha', displayName: 'Asha Nair', email: 'asha.nair@assessment.example', personId: null,
    grants: { assessment: ['assessor'], social: ['participant'] }, epoch: 0 },
  { id: 'u-jonas', displayName: 'Jonas Lindqvist', email: 'jonas.lindqvist@assessment.example', personId: null,
    grants: { assessment: ['lead-assessor', 'assessor'], social: ['participant'] }, epoch: 0 },
  { id: 'u-farah', displayName: 'Farah Osei', email: 'farah.osei@assessment.example', personId: null,
    grants: { assessment: ['program-lead', 'lead-assessor'], social: ['participant'] }, epoch: 0 },
  // Social tenant cast — see docs/social-tenant-design.md §4.1. A grant only in
  // social, so each role's outbound isolation walk starts from nothing else.
  // (The curated orgiq and assessment casts above hold `participant` there too.)
  { id: 'u-mira', displayName: 'Mira Okafor', email: 'mira.okafor@social.example', personId: null,
    grants: { social: ['community-admin'] }, epoch: 0 },
  { id: 'u-lena', displayName: 'Lena Brandt', email: 'lena.brandt@social.example', personId: null,
    grants: { social: ['moderator'] }, epoch: 0 },
  { id: 'u-sana', displayName: 'Sana Iqbal', email: 'sana.iqbal@social.example', personId: null,
    grants: { social: ['participant'] }, epoch: 0 },
  // Pipelines tenant cast — see docs/pipelines-tenant-goal.md §Cast. Same rule:
  // a grant only in pipelines.
  { id: 'u-ines', displayName: 'Ines Moreau', email: 'ines.moreau@orgiq.example', personId: null,
    grants: { pipelines: ['author'] }, epoch: 0 },
  { id: 'u-kofi', displayName: 'Kofi Mensah', email: 'kofi.mensah@orgiq.example', personId: null,
    grants: { pipelines: ['operator'] }, epoch: 0 },
  { id: 'u-dara', displayName: 'Dara Whitfield', email: 'dara.whitfield@orgiq.example', personId: null,
    grants: { pipelines: ['pipeline-admin'] }, epoch: 0 },
  // The Communication-plane walker for pipelines (docs/communication-plane-goal.md):
  // a pipelines author who ALSO holds Social. Deliberately NOT part of the pure
  // three-person cast above, whose outbound isolation walks need no Social grant.
  { id: 'u-tomas', displayName: 'Tomás Ferreira', email: 'tomas.ferreira@orgiq.example', personId: null,
    grants: { pipelines: ['author'], social: ['participant'] }, epoch: 0 },
  // Access tenant cast — see docs/access-tenant-goal.md §Cast. A grant only in
  // access; the linked people rows (and u-omar as u-rhea's manager) come from
  // schema/access_schema.sql, mirrored offline by mock/access-people.ts.
  { id: 'u-rhea', displayName: 'Rhea Castellanos', email: 'rhea.castellanos@orgiq.example', personId: 'p-rhea',
    grants: { access: ['requester'] }, epoch: 0 },
  { id: 'u-omar', displayName: 'Omar Haddad', email: 'omar.haddad@orgiq.example', personId: 'p-omar',
    grants: { access: ['approver'] }, epoch: 0 },
  { id: 'u-priya', displayName: 'Priya Venkataraman', email: 'priya.venkataraman@orgiq.example', personId: 'p-priya',
    grants: { access: ['access-admin'] }, epoch: 0 },
];

/**
 * The offline directory as it stands now: the seed mirror with any grant
 * writes applied (mock/identity-grants.ts, a registered fixture, so a reset
 * restores the seed). With no write recorded this is FALLBACK_USERS itself —
 * the same objects, so the in-place epoch bump below stays visible.
 */
function fallbackUsers(): UserInfo[] {
  const writes = identityGrantWritesFixture.rows();
  if (writes.length === 0) return FALLBACK_USERS;
  const byUser = new Map(writes.map((w) => [w.userId, w.grants]));
  return FALLBACK_USERS.map((u) => {
    const grants = byUser.get(u.id);
    return grants ? { ...u, grants: structuredClone(grants) } : u;
  });
}
/**
 * One user by id: the seed mirror, then the live identity clones
 * (mock/identity-clones.ts). Clones resolve here — login, the grants refresh
 * and the realtime authority all read through `getUser` — but are left out of
 * `listUsers`, so the picker and directory listings never show them.
 */
const fallbackUser = (id: string): UserInfo | null =>
  fallbackUsers().find((u) => u.id === id) ?? cloneAsUser(findClone(id));

function cloneAsUser(clone: IdentityCloneRow | null): UserInfo | null {
  if (!clone) return null;
  return {
    id: clone.id, displayName: clone.displayName, email: clone.email, personId: clone.personId,
    grants: structuredClone(clone.grants), epoch: clone.epoch,
  };
}

export class CloneRefused extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/**
 * Mint an ephemeral clone of a seed persona (dev:mock only; the control plane
 * gates the route). Same grants (as they stand now, grant writes included),
 * person link and display name; its own id and session epoch.
 */
export function cloneIdentity(from: string, opts: { label?: string | null; ttlMs?: number } = {}): IdentityCloneRow {
  if (!config.mock?.aurora) throw new CloneRefused('identity clones need MOCK_AURORA (the offline directory)', 409);
  const persona = fallbackUsers().find((u) => u.id === from);
  if (!persona) {
    const isClone = Boolean(findClone(from));
    throw new CloneRefused(isClone ? 'clone a seed persona, not a clone' : `unknown persona ${from}`, isClone ? 400 : 404);
  }
  const rows = liveClones();
  if (rows.length >= MAX_CLONES) throw new CloneRefused(`at most ${MAX_CLONES} live clones; POST /api/__mock/reset`, 429);
  const ttl = typeof opts.ttlMs === 'number' && Number.isFinite(opts.ttlMs) && opts.ttlMs > 0
    ? Math.min(opts.ttlMs, MAX_CLONE_TTL_MS) : DEFAULT_CLONE_TTL_MS;
  const now = clock.now().getTime();
  const row: IdentityCloneRow = {
    id: `${persona.id}-clone-${randomBytes(4).toString('hex')}`,
    from: persona.id,
    label: opts.label ?? null,
    displayName: persona.displayName,
    email: persona.email,
    personId: persona.personId,
    grants: structuredClone(persona.grants),
    epoch: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
  };
  rows.push(row);
  return row;
}

/** Remove one clone; the next grants refresh treats its sessions as a deleted account. */
export function deleteIdentityClone(id: string): boolean {
  if (!removeClone(id)) return false;
  directoryChanged(id);
  return true;
}

export { liveClones as listIdentityClones };

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

async function exec(sql: string, params: SqlParameter[] = [], transactionId?: string): Promise<unknown[][]> {
  const out = await getClient().send(new ExecuteStatementCommand({
    resourceArn: config.aurora.clusterArn,
    secretArn: config.aurora.secretArn,
    database: config.aurora.database,
    sql,
    parameters: params,
    ...(transactionId ? { transactionId } : {}),
  }));
  return (out.records ?? []).map(row => row.map(readField));
}

/** Run `fn` in one Data API transaction: committed if it returns, rolled back if it throws. */
async function inTransaction<T>(fn: (transactionId: string) => Promise<T>): Promise<T> {
  const target = { resourceArn: config.aurora.clusterArn, secretArn: config.aurora.secretArn };
  const begun = await getClient().send(new BeginTransactionCommand({ ...target, database: config.aurora.database }));
  const transactionId = begun.transactionId;
  if (!transactionId) throw new Error('Data API returned no transaction id');
  try {
    const result = await fn(transactionId);
    await getClient().send(new CommitTransactionCommand({ ...target, transactionId }));
    return result;
  } catch (error) {
    await getClient().send(new RollbackTransactionCommand({ ...target, transactionId })).catch(() => undefined);
    throw error;
  }
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

/** The seeded login linked to an org-graph person (the fallback mirror of `app_users.person_id`), if any. */
export function seedUserForPerson(personId: string): { id: string; displayName: string } | null {
  const user = FALLBACK_USERS.find((u) => u.personId === personId);
  return user ? { id: user.id, displayName: user.displayName } : null;
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

export async function listUsers(options: { authoritative?: boolean } = {}): Promise<UserInfo[]> {
  if (options.authoritative && config.mock?.aurora) return fallbackUsers();
  if (!auroraConfigured()) {
    if (options.authoritative) throw new Error('identity store unavailable');
    return fallbackUsers();
  }
  try {
    const users = await exec(
      `SELECT id, display_name, email, person_id, session_epoch FROM app_users ORDER BY display_name`);
    if (users.length === 0) return options.authoritative ? [] : fallbackUsers();
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
  } catch (error) {
    if (options.authoritative) throw error;
    return fallbackUsers();
  }
}

export async function getUser(userId: string, options: { authoritative?: boolean } = {}): Promise<UserInfo | null> {
  // Realtime grants must not revive a deleted/revoked seed identity during a
  // database outage. Only an explicitly mocked deployment may use fixtures.
  if (options.authoritative && config.mock?.aurora) return fallbackUser(userId);
  if (!auroraConfigured()) {
    if (options.authoritative && !config.mock?.aurora) throw new Error('identity store unavailable');
    return fallbackUser(userId);
  }
  try {
    const user = options.authoritative ? await queuedAuthoritativeUser(userId) : (await readCurrentUsers([userId])).get(userId) ?? null;
    return user ?? (options.authoritative ? null : fallbackUser(userId));
  } catch (error) {
    if (options.authoritative) throw error;
    return fallbackUser(userId);
  }
}

// One SQL snapshot keeps each user's epoch and grants together. Adjacent
// outstanding authority reads share a bounded query, not a settled positive
// cache: every later action/delivery still starts a new directory read.
const AUTHORITY_BATCH_SIZE = 128;
const MAX_QUEUED_AUTHORITY_SUBJECTS = 2048;
type AuthorityWaiter = { resolve: (user: UserInfo | null) => void; reject: (error: unknown) => void };
const authorityQueue = new Map<string, AuthorityWaiter[]>();
let authorityScheduled = false;
async function readCurrentUsers(userIds: string[]): Promise<Map<string, UserInfo>> {
  const params = userIds.map((id, index) => str(`id${index}`, id));
  const rows = await exec(
    `SELECT u.id, u.display_name, u.email, u.person_id, u.session_epoch, u.external_sub,
            r.tenant_id, r.role
     FROM app_users u LEFT JOIN user_tenant_roles r ON r.user_id = u.id
     WHERE u.id IN (${params.map(param => `:${param.name}`).join(', ')})
     ORDER BY u.id, r.granted_at, r.tenant_id, r.role`, params);
  const users = new Map<string, UserInfo>();
  for (const [id, name, email, personId, epoch, externalSub, tenant, role] of rows) {
    if (typeof id !== 'string' || !userIds.includes(id)) throw new Error('Unexpected directory subject');
    let user = users.get(id);
    if (!user) {
      user = { id, displayName: name as string, email: (email as string | null) ?? null,
        personId: (personId as string | null) ?? null, epoch: (epoch as number | null) ?? 0,
        externalSub: (externalSub as string | null) ?? null, grants: {} };
      users.set(id, user);
    }
    if (typeof tenant === 'string' && typeof role === 'string') (user.grants[tenant] ??= []).push(role);
  }
  return users;
}
function queuedAuthoritativeUser(userId: string): Promise<UserInfo | null> {
  if (!authorityQueue.has(userId) && authorityQueue.size >= MAX_QUEUED_AUTHORITY_SUBJECTS) return Promise.reject(new Error('Directory authority queue is full'));
  return new Promise((resolve, reject) => {
    const waiters = authorityQueue.get(userId) ?? [];
    waiters.push({ resolve, reject }); authorityQueue.set(userId, waiters);
    if (authorityScheduled) return;
    authorityScheduled = true;
    setImmediate(() => {
      authorityScheduled = false;
      const queued = [...authorityQueue]; authorityQueue.clear();
      for (let offset = 0; offset < queued.length; offset += AUTHORITY_BATCH_SIZE) {
        const batch = queued.slice(offset, offset + AUTHORITY_BATCH_SIZE);
        void readCurrentUsers(batch.map(([id]) => id)).then(users => {
          for (const [id, readers] of batch) for (const reader of readers) reader.resolve(users.has(id) ? structuredClone(users.get(id)!) : null);
        }, error => { for (const [, readers] of batch) for (const reader of readers) reader.reject(error); });
      }
    });
  });
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
    return fallbackUsers().find(u => (u.email ?? '').toLowerCase() === needle) ?? null;
  }
  try {
    const rows = await exec(
      `SELECT id, display_name, email, person_id, session_epoch FROM app_users WHERE lower(email) = :email`,
      [str('email', needle)]);
    if (rows.length === 0) {
      return fallbackUsers().find(u => (u.email ?? '').toLowerCase() === needle) ?? null;
    }
    const [id, displayName, mail, personId, epoch] = rows[0]!;
    return hydrate(id as string, displayName as string, (mail as string | null) ?? null, (personId as string | null) ?? null, (epoch as number | null) ?? 0);
  } catch {
    return fallbackUsers().find(u => (u.email ?? '').toLowerCase() === needle) ?? null;
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
  // MOCK_AURORA's authoritative reads are the seed mirror (getUser/listUsers
  // above), so its epoch is the one a live session is checked against.
  if (!auroraConfigured() || config.mock?.aurora) {
    // A clone's epoch is its own: bumping it never touches the persona's.
    const clone = findClone(userId);
    const u = clone ?? FALLBACK_USERS.find(x => x.id === userId);
    const next = u ? (u.epoch = (u.epoch ?? 0) + 1) : 1;
    directoryChanged(userId);
    return next;
  }
  const rows = await exec(
    `UPDATE app_users SET session_epoch = session_epoch + 1 WHERE id = :id RETURNING session_epoch`,
    [str('id', userId)]);
  directoryChanged(userId);
  return (rows[0]?.[0] as number | undefined) ?? 1;
}

// ── Committed directory changes (grants, epoch) ─────────────────────────────
// A content-free signal for live readers that hold access open (the work-graph
// stream, lib/work-graph/stream.ts): they re-ask their own authority. Never a
// grant record; listeners must not trust anything but the user id.
const directoryListeners = new Set<(userId: string) => void>();
export function onDirectoryChange(listener: (userId: string) => void): () => void {
  directoryListeners.add(listener);
  return () => { directoryListeners.delete(listener); };
}
function directoryChanged(userId: string): void {
  // The gateway's verdict cache first (lib/gateway/authority-invalidation.ts):
  // every grant write, epoch bump and clone removal lands here after commit.
  invalidateForUser(userId, 'directory');
  for (const listener of directoryListeners) {
    try { listener(userId); } catch { /* a listener never fails the write */ }
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

/**
 * Insert a new user. Never an upsert: an existing id is left exactly as it
 * is (name, email, person) and the call returns false, so the caller can
 * answer 409. Rewriting an existing account's email would hand it to whoever
 * owns the new address through the SSO email-link fallback.
 */
export async function createUser(
  input: { id: string; displayName: string; email?: string; personId?: string },
): Promise<boolean> {
  if (!auroraConfigured()) throw new Error('Aurora not configured — cannot provision users');
  const params = [str('id', input.id), str('name', input.displayName)];
  const rows = await exec(
    `INSERT INTO app_users (id, display_name, email, person_id)
     VALUES (:id, :name, ${input.email ? ':email' : 'NULL'}, ${input.personId ? ':person' : 'NULL'})
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [
      ...params,
      ...(input.email ? [str('email', input.email)] : []),
      ...(input.personId ? [str('person', input.personId)] : []),
    ]);
  return rows.length > 0;
}

// ── Grant writes ─────────────────────────────────────────────────────────────
// Every write changes named (user, tenant, role) rows and nothing else
// (lib/identity-grants-sql.ts): `grantRole` / `revokeRole` one row,
// `setGrants` the diff between the set its caller started from and the set it
// wants. No writer deletes a user's rows and re-inserts its set, so concurrent
// writers to different roles never clobber each other. None of them bumps the
// session epoch — a grant reaches open cookies at the grants refresh; a caller
// that removes access and must retire cookies (access revocation, expiry —
// docs/access-tenant-design.md A3) calls `bumpSessionEpoch` itself.
//
// Under MOCK_AURORA (whose authoritative reads are the seed mirror) a write
// lands in the registered `identity.grant-writes` fixture, which every
// fallback read above applies, so `POST /api/__mock/reset` restores the seed
// grants. The mock reads and writes in one synchronous step — the same
// per-row outcome the statements give on the cluster. Without MOCK_AURORA an
// unconfigured cluster refuses: an unmocked process has no store to write and
// must not pretend to.

/** The offline write: apply `diff` (computed from `base`, default the current grants) in one tick. */
function applyMockGrants(userId: string, diffFrom: (current: Grants) => GrantDiff): void {
  const clone = findClone(userId);
  const current = clone?.grants ?? fallbackUsers().find((u) => u.id === userId)?.grants;
  if (!current) throw new Error(`No user ${userId} in the offline directory`);
  const next = applyGrantDiff(current, diffFrom(current));
  if (clone) {
    // A clone's grants live on its own row, so a provisioning write under a
    // clone never changes the persona it came from.
    clone.grants = next;
  } else {
    const rows = identityGrantWritesFixture.rows();
    const at = rows.findIndex((r) => r.userId === userId);
    const row = { userId, grants: next };
    if (at >= 0) rows[at] = row; else rows.push(row);
  }
  directoryChanged(userId);
}

async function writeRole(userId: string, tenant: string, role: string, present: boolean): Promise<void> {
  if (config.mock?.aurora) {
    applyMockGrants(userId, () => (present ? { add: [[tenant, role]], remove: [] } : { add: [], remove: [[tenant, role]] }));
    return;
  }
  if (!auroraConfigured()) throw new Error('Aurora not configured — cannot edit grants');
  await exec(present ? GRANT_ROLE_SQL : REVOKE_ROLE_SQL, [str('user_id', userId), str('tenant', tenant), str('role', role)]);
  directoryChanged(userId);
}

/** Grant one role (or capability grant) to a user. Idempotent; touches no other grant; no epoch bump. */
export function grantRole(userId: string, tenant: string, role: string): Promise<void> {
  return writeRole(userId, tenant, role, true);
}

/** Remove one role (or capability grant) from a user. Idempotent; touches no other grant; no epoch bump. */
export function revokeRole(userId: string, tenant: string, role: string): Promise<void> {
  return writeRole(userId, tenant, role, false);
}

/**
 * Set a user's grants to `grants` (the admin UI edits the full matrix) by
 * writing only what differs from `base`, in one transaction.
 *
 * `base` is the set the caller started from — the grants the editor loaded.
 * A role written by someone else since (an access provisioning) is in neither
 * set and is left alone, so the edit cannot erase it. With no `base` the
 * user's rows as read inside the transaction are the base: the result is
 * exactly `grants` for every row that read saw, and a row committed after it
 * still survives. No epoch bump (unchanged behaviour).
 */
export async function setGrants(userId: string, grants: Grants, options: { base?: Grants } = {}): Promise<void> {
  if (config.mock?.aurora) {
    applyMockGrants(userId, (current) => grantDiff(options.base ?? current, grants));
    return;
  }
  if (!auroraConfigured()) throw new Error('Aurora not configured — cannot edit grants');
  await inTransaction((tx) => writeGrantSet(
    (sql, params) => exec(sql, Object.entries(params).map(([name, value]) => str(name, value)), tx),
    userId, grants, options.base));
  directoryChanged(userId);
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
  return FALLBACK_USERS.find((u) => u.id === subject)?.displayName ?? findClone(subject)?.displayName ?? null;
}

