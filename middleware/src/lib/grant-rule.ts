// The one grant rule (docs/next-steps.md section 8, package 5). Every path
// that writes a (tenant, role) grant asks this module first: the identity
// admin routes (PUT and POST /api/identity/users) and access provisioning
// (lib/access-provision.ts). Cedar only says the caller may manage users at
// all; it never sees the payload, so the payload rules live here.
//
//   * `admin` is the cross-tenant platform role. Only an admin session may
//     grant or remove it, in any tenant.
//   * A non-admin caller writes only inside their own session tenant.
//   * Nobody edits their own grants (the real identity behind a masquerade
//     included), so a scoped manager cannot raise themselves.

export interface GrantActor {
  /** Absent for a system writer (access provisioning acts for an approval, not a user). */
  sub?: string;
  role: string;
  tenant: string;
  act?: { sub: string };
}

export type GrantVerdict = { ok: true } | { ok: false; reason: string };

export const ADMIN_ROLE = 'admin';

/** May `actor` grant (or remove) `role` in `tenant`? */
export function canGrant(actor: GrantActor, tenant: string, role: string): GrantVerdict {
  if (role === ADMIN_ROLE && actor.role !== ADMIN_ROLE) {
    return { ok: false, reason: `only an admin session can grant or remove '${ADMIN_ROLE}'` };
  }
  if (actor.role !== ADMIN_ROLE && tenant !== actor.tenant) {
    return { ok: false, reason: `cannot set grants for tenant '${tenant}' — your session is scoped to '${actor.tenant}'` };
  }
  return { ok: true };
}

/** May `actor` change the grants of `userId` at all? Never their own. */
export function canEditGrantsOf(actor: GrantActor, userId: string): GrantVerdict {
  if (userId === actor.sub || (actor.act && userId === actor.act.sub)) {
    return { ok: false, reason: 'you cannot change your own grants; ask another user admin' };
  }
  return { ok: true };
}

/** The first refused (tenant, role) pair among `pairs`, or ok. */
export function canGrantAll(actor: GrantActor, pairs: Iterable<readonly [string, string]>): GrantVerdict {
  for (const [tenant, role] of pairs) {
    const verdict = canGrant(actor, tenant, role);
    if (!verdict.ok) return verdict;
  }
  return { ok: true };
}

/**
 * May `actor` change something on `target` beyond grants (its person link)?
 * An admin may; anyone else only for a user who holds a grant in the actor's
 * own tenant, so a tenant-scoped ManageUsers holder cannot reach into another
 * tenant's directory (docs/next-steps.md section 7, PUT /users/:id/person).
 */
export function canManageUserIn(actor: GrantActor, targetGrants: Readonly<Record<string, readonly string[] | undefined>>): GrantVerdict {
  if (actor.role === ADMIN_ROLE) return { ok: true };
  if ((targetGrants[actor.tenant] ?? []).length > 0) return { ok: true };
  return { ok: false, reason: `this user holds no grant in '${actor.tenant}', the tenant your session is scoped to` };
}
