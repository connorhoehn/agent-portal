// The grant store's write statements (user_tenant_roles, schema/identity_schema.sql)
// and the diff every whole-set writer applies through them.
//
// A grant is written ONE (user, tenant, role) row at a time — an idempotent
// insert or a targeted delete — never by deleting a user's rows and
// re-inserting the set. The delete-and-reinsert was a read-modify-write: two
// writers that each read the grants, merged their own role and wrote the set
// back lost one role (two access requests provisioned at once, or a
// provisioning racing an admin edit). Per-row statements touch only the row
// they name, so concurrent writers to different roles never clobber each
// other. providers/identity.ts runs these on the cluster; the native
// PostgreSQL contract (lib/access/__tests__/access-postgres.test.ts) runs the
// same strings.

import type { Grants } from './session.js';

/** One (user, tenant, role) row, idempotent — never the whole set rewritten. */
export const GRANT_ROLE_SQL = `
INSERT INTO user_tenant_roles (user_id, tenant_id, role) VALUES (:user_id, :tenant, :role)
ON CONFLICT DO NOTHING`;

/** Remove exactly one (user, tenant, role) row. Idempotent. */
export const REVOKE_ROLE_SQL = `
DELETE FROM user_tenant_roles WHERE user_id = :user_id AND tenant_id = :tenant AND role = :role`;

/** A user's rows as a whole-set writer reads its base inside its own transaction. */
export const USER_GRANTS_SQL = `
SELECT tenant_id, role FROM user_tenant_roles WHERE user_id = :user_id ORDER BY granted_at, tenant_id, role`;

export type GrantPair = readonly [tenant: string, role: string];

export interface GrantDiff {
  add: GrantPair[];
  remove: GrantPair[];
}

const pairs = (grants: Grants): Map<string, GrantPair> => {
  const out = new Map<string, GrantPair>();
  for (const [tenant, roles] of Object.entries(grants)) {
    for (const role of roles ?? []) out.set(`${tenant}\u0000${role}`, [tenant, role]);
  }
  return out;
};

/**
 * What a writer changes going from `base` (the grants it started from) to
 * `next` (the grants it wants): only those rows. A role someone else wrote
 * that is in neither set is left alone.
 */
export function grantDiff(base: Grants, next: Grants): GrantDiff {
  const before = pairs(base);
  const after = pairs(next);
  return {
    add: [...after].filter(([k]) => !before.has(k)).map(([, p]) => p),
    remove: [...before].filter(([k]) => !after.has(k)).map(([, p]) => p),
  };
}

/** `grants` with the diff applied: removals, then additions appended (the cluster's granted_at order). */
export function applyGrantDiff(grants: Grants, diff: GrantDiff): Grants {
  const next: Grants = structuredClone(grants);
  for (const [tenant, role] of diff.remove) {
    const kept = (next[tenant] ?? []).filter((r) => r !== role);
    if (kept.length) next[tenant] = kept; else delete next[tenant];
  }
  for (const [tenant, role] of diff.add) {
    const roles = next[tenant] ?? [];
    if (!roles.includes(role)) next[tenant] = [...roles, role];
  }
  return next;
}

/** Runs one statement with `:name` parameters (all strings here) and returns rows as column arrays. */
export type GrantExec = (sql: string, params: Record<string, string>) => Promise<unknown[][]>;

/**
 * The body of a whole-set write, run inside ONE transaction by the caller
 * (providers/identity.ts `setGrants` on the Data API; the native PostgreSQL
 * contract on a psql session). Reads the base inside the transaction when the
 * caller has none, then applies only the diff, one row per statement.
 */
export async function writeGrantSet(exec: GrantExec, userId: string, grants: Grants, base?: Grants): Promise<GrantDiff> {
  let from = base;
  if (!from) {
    from = {};
    for (const [tenant, role] of await exec(USER_GRANTS_SQL, { user_id: userId })) {
      (from[tenant as string] ??= []).push(role as string);
    }
  }
  const diff = grantDiff(from, grants);
  for (const [tenant, role] of diff.remove) await exec(REVOKE_ROLE_SQL, { user_id: userId, tenant, role });
  for (const [tenant, role] of diff.add) await exec(GRANT_ROLE_SQL, { user_id: userId, tenant, role });
  return diff;
}
