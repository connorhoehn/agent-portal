// The request's tenant scope for row-level security (docs/next-steps.md §8
// work item 22, schema/row_level_security.sql).
//
// The database filters tenant tables on `app.tenant`, a per-transaction
// setting. The RDS Data API keeps no session, so the wrapper in aurora.ts sends
// it inside the same transaction as the statement: begin, SET_TENANT_SQL,
// statement, commit. This module decides WHAT it sends and WHEN.
//
// WHAT. sessionMiddleware (lib/session.ts) runs the rest of each request with a
// session inside `runWithDbTenant(dbTenantScopeFor(session), …)`:
//   * the active tenant first, then every other tenant the user holds a grant
//     in ('orgiq,social'). A grant is what authorises a read; a tenant the user
//     holds nothing in is the cross-tenant read RLS exists to stop, and the
//     product reads across granted tenants by design (the Social bottom bar in
//     every tenant, a pipeline run on the page it acted for);
//   * '*' for the cross-tenant `admin` role and for the access tenant, which
//     administers every tenant's grants;
//   * '*' when no request scope is active: boot, pollers, schedulers, and the
//     grants refresh that runs before the scope opens. Code with no user behind
//     it is the system. `runAsSystem` says so explicitly inside a request.
// An unauthenticated request carries no scope, so it also runs as the system;
// those routes (login, config, health) read the directory to establish who
// the caller is.
//
// WHEN. Only under RLS_ENFORCE, and only for statements that name a table the
// SQL file protects (`touchesTenantTable`); every other statement keeps its one
// autocommit round trip. A table the pattern misses fails closed (the setting
// is unset, the policy answers false), never open.
//
// RLS_ENFORCE: 'true' / 'false' wins; unset means on, whatever
// AURORA_SECRET_ARN names. Under the `dbMasterSecret` fallback the master owns
// every table and RLS does not bind it, so enforcing there costs only the extra
// round trips; `RLS_ENFORCE=false` is the explicit opt-out for that login. With
// the middleware's own login (`<prefix>-aurora-middleware-credentials`,
// infra/lib/aurora-stack.ts) it must stay on, or tenant tables read empty.

import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';

/** The wrapper's statement; `:app_tenant` is its one parameter. The third argument `true` makes it LOCAL. */
export const SET_TENANT_SQL = "SELECT set_config('app.tenant', :app_tenant, true)";

/** Every tenant, unrestricted: admin, the access tenant and system work. */
export const ALL_TENANTS = '*';

const storage = new AsyncLocalStorage<string>();

/** The scope the database sees for this request: '*' outside any request. */
export function currentDbTenant(): string {
  return storage.getStore() ?? ALL_TENANTS;
}

/** Run `fn` (and everything it awaits) with `scope` as the request's tenant scope. */
export function runWithDbTenant<T>(scope: string, fn: () => T): T {
  return storage.run(scope, fn);
}

/**
 * Run `fn` as the system, inside a request: for reads that establish identity
 * (a user's whole grant set) rather than serve tenant data.
 */
export function runAsSystem<T>(fn: () => T): T {
  return storage.run(ALL_TENANTS, fn);
}

const TENANT_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The subset of a session the scope is computed from. */
export interface DbTenantSubject {
  tenant: string;
  role: string;
  grants: Record<string, readonly string[] | undefined>;
}

/** `app.tenant` for a session: see the module header. */
export function dbTenantScopeFor(session: DbTenantSubject): string {
  if (session.role === 'admin' || session.tenant === 'access') return ALL_TENANTS;
  const tenants = [session.tenant, ...Object.keys(session.grants ?? {})
    .filter((t) => t !== session.tenant && (session.grants[t]?.length ?? 0) > 0)];
  // A tenant id is a manifest slug; anything else could smuggle a comma.
  return tenants.filter((t) => TENANT_ID.test(t)).join(',');
}

/** Whether AURORA_SECRET_ARN names the middleware's own login rather than the master. */
export function usesApplicationRole(secretArn: string | undefined = config.aurora?.secretArn): boolean {
  return /:secret:[A-Za-z0-9-]*-aurora-middleware-credentials(-[A-Za-z0-9]{6})?$/.test(secretArn ?? '');
}

/** RLS_ENFORCE, read per call so an operator's override needs no code path of its own. Unset = on. */
export function rlsEnforced(): boolean {
  const raw = (process.env['RLS_ENFORCE'] ?? '').trim().toLowerCase();
  if (raw === 'false' || raw === '0') return false;
  return true;
}

/**
 * The tables schema/row_level_security.sql protects, as one pattern. A false
 * positive costs a transaction; a miss reads empty. The parity test in
 * __tests__/aurora-rls.test.ts holds this to the SQL file's list.
 */
const TENANT_TABLES = new RegExp(
  '\\b(?:user_tenant_roles|saved_searches|flow_runs|knowledge_bases'
  + '|social_channels|social_bindings|microvm_sessions|github_user_grants'
  + '|access_[a-z_]+|assessment_[a-z_]+'
  + '|pipeline_(?:definitions|runs|steps|artifacts|config|run_decks|run_deck_revisions))\\b',
  'i',
);

export function touchesTenantTable(sql: string): boolean {
  return TENANT_TABLES.test(sql);
}

let warned = false;
/** Says once, loudly, when the application login runs with RLS_ENFORCE off: tenant tables will read empty. */
export function warnIfMisconfigured(log: (msg: string) => void = (m) => console.warn(m)): void {
  if (warned || rlsEnforced() || !usesApplicationRole()) return;
  warned = true;
  log('[rls] RLS_ENFORCE=false while AURORA_SECRET_ARN is the middleware login: every tenant table will read '
    + 'empty. Unset RLS_ENFORCE, or deploy with -c dbMasterSecret=true and RLS_ENFORCE=false (infra/SECURITY-NOTES.md).');
}
