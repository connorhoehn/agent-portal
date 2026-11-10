// Whose rows of observability.invocation_traces a caller may read text from.
//
// invocation_traces holds every user's prompt and response snippets, in every
// tenant, and the RLS script exempts it on purpose, so the scope is enforced in
// the routes. `ViewObservability` (every orgiq member holds it) answers "may
// you open the observability pages", not "may you read everyone's prompts".
//
//   * a fleet-wide role (FLEET_WIDE_ROLES: org-leader, hr-admin, admin — the
//     same roles that see every computer) reads every row;
//   * everyone else reads only their own rows in their own tenant.
//
// Every route that returns snippet text (or anything else derived from a
// user's prompt or answer) from this table applies it: the SQL clause for the
// live path and `rowInScope` for the offline corpus, which is answered by
// functions that do not read the SQL. Aggregates without text (counts, costs,
// latencies) may stay unscoped.

import type { Request, Response } from 'express';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { FLEET_WIDE_ROLES } from './devbox-visibility.js';

/** `userId: null` = every user in `tenant`. A `null` scope = every row (cross-tenant admin). */
export interface TraceScope { tenant: string; userId: string | null }

/** The caller's scope from the session alone, or null for a fleet-wide role. */
export function scopeForSession(session: { sub?: string; tenant?: unknown; role?: string } | undefined): TraceScope | null | 'none' {
  if (!session?.sub) return 'none';
  const role = session.role ?? '';
  if ((FLEET_WIDE_ROLES as readonly string[]).includes(role)) return null;
  return { tenant: String(session.tenant ?? ''), userId: session.sub };
}

/** The request's scope; answers 401 and returns 'refused' when there is no session. */
export function traceScope(req: Request, res: Response): TraceScope | null | 'refused' {
  const scope = scopeForSession(req.session as never);
  if (scope === 'none') {
    res.status(401).json({ error: 'session required' });
    return 'refused';
  }
  return scope;
}

/**
 * ` AND <alias>user_id = … AND <alias>tenant = …` with its parameters, or
 * nothing for the cross-tenant admin. `alias` is the table alias with its dot
 * (`'t.'`), empty for an unaliased query.
 */
export function scopeSql(scope: TraceScope | null, alias = ''): { clause: string; params: SqlParameter[] } {
  if (!scope) return { clause: '', params: [] };
  const params: SqlParameter[] = [{ name: 'scope_tenant', value: { stringValue: scope.tenant } }];
  let clause = ` AND ${alias}tenant = :scope_tenant`;
  if (scope.userId !== null) {
    clause = ` AND ${alias}user_id = :scope_user${clause}`;
    params.unshift({ name: 'scope_user', value: { stringValue: scope.userId } });
  }
  return { clause, params };
}

/**
 * The same rule over a returned row. The offline corpus has no tenant column
 * (it is orgiq's own), so an absent tenant checks the user alone.
 */
export function rowInScope(scope: TraceScope | null, row: Record<string, unknown> | undefined): boolean {
  if (!scope || !row) return true;
  if (scope.userId !== null && row['user_id'] !== scope.userId) return false;
  const tenant = row['tenant'];
  return tenant === undefined || tenant === scope.tenant;
}

/**
 * A JOIN condition for a table that joins invocation_traces by id (the
 * harness's results): keep the trace's text only when it is a harness trace
 * (no user) or in the caller's scope. A caller with no session (the harness
 * runner's machine identity) gets harness traces only. `alias` as above.
 */
export function joinScopeSql(scope: TraceScope | null | 'none', alias: string): { clause: string; params: SqlParameter[] } {
  if (scope === 'none') return { clause: ` AND ${alias}user_id IS NULL`, params: [] };
  if (scope === null) return { clause: '', params: [] };
  const inner = scopeSql(scope, alias);
  return { clause: ` AND (${alias}user_id IS NULL OR (TRUE${inner.clause}))`, params: inner.params };
}
