// Pure derivations shared by the identity pages (Users/Tenants, Roles,
// Policies, Schema, Sandbox) — kept out of the components so the matrix,
// grant and chip logic can be node-tested without a DOM.

/**
 * FormField's render-prop wiring includes `labelId`, which is not a DOM
 * prop — spreading it straight onto an Input/Select trips a React "unknown
 * prop" warning. Strip it before spreading onto the control.
 *
 * Same gap `assessment/assessmentFormat.ts` documents and works around;
 * duplicated here rather than importing across a directory another agent
 * owns. Queued in docs/ui-components-queue.md.
 */
export function inputWiring<W extends { labelId: string }>(wiring: W): Omit<W, 'labelId'> {
  const { labelId: _labelId, ...rest } = wiring;
  void _labelId;
  return rest;
}

export interface RoleLike {
  capabilities: string[];
}

/**
 * Permission-matrix action rows: prefer the live Cedar schema (the source
 * both the Roles and Schema tabs read), falling back to the union of what
 * the roles themselves carry when the schema is unreachable (mock mode /
 * AVP down) — so the matrix still says something true.
 */
export function matrixActions(schemaActions: string[], roles: RoleLike[]): string[] {
  if (schemaActions.length > 0) return [...schemaActions].sort();
  const union = new Set<string>();
  for (const r of roles) for (const c of r.capabilities) union.add(c);
  return [...union].sort();
}

export interface TenantLike {
  id: string;
}

export interface TenantScopedRole {
  id: string;
  tenant: string | null;
}

/** Roles selectable for a tenant = that tenant's own roles + cross-tenant
 * (`tenant: null`) roles. */
export function rolesForTenantMap<R extends TenantScopedRole>(
  tenants: TenantLike[],
  roles: R[],
): Map<string, R[]> {
  const map = new Map<string, R[]>();
  for (const t of tenants) {
    map.set(t.id, roles.filter(r => r.tenant === t.id || r.tenant === null));
  }
  return map;
}

/** "tenant/role" chip labels for a user's grants map, flattened. */
export function grantChipLabels(grants: Record<string, string[]>): string[] {
  return Object.entries(grants).flatMap(([tenant, roleIds]) => roleIds.map(r => `${tenant}/${r}`));
}

export function tenantUserCount(
  tenantId: string,
  users: Array<{ grants: Record<string, string[]> }>,
): number {
  return users.filter(u => (u.grants[tenantId] ?? []).length > 0).length;
}

/** Toggle one (tenant, role) pair in a grants map, dropping the tenant key
 * entirely once its role set is empty (an empty array and a missing key
 * mean the same thing server-side, but a missing key is the honest shape). */
export function toggleGrantSet(
  grants: Record<string, string[]>,
  tenant: string,
  role: string,
): Record<string, string[]> {
  const held = new Set(grants[tenant] ?? []);
  if (held.has(role)) held.delete(role); else held.add(role);
  const next = { ...grants };
  if (held.size === 0) delete next[tenant]; else next[tenant] = [...held];
  return next;
}

export type PolicyDecision = 'ALLOW' | 'DENY' | undefined;

/** Tone for the sandbox's decision chip — a request error reads as danger
 * regardless of what (if anything) `decision` says. */
export function decisionTone(decision: PolicyDecision, hasError: boolean): 'success' | 'danger' {
  if (hasError) return 'danger';
  return decision === 'ALLOW' ? 'success' : 'danger';
}

export function effectTone(effect: 'permit' | 'forbid'): 'success' | 'danger' {
  return effect === 'permit' ? 'success' : 'danger';
}

export function truncateId(id: string, len = 12): string {
  return id.length > len ? `${id.slice(0, len)}…` : id;
}

/**
 * Why a tenant id is or is not acceptable, in the words the field's own label
 * promises. `middleware/src/routes/identity.ts` enforces
 * `^[a-z][a-z0-9-]{1,30}$` and 400s otherwise; the form used to enable Create
 * for `   audit probe TENANT` and let the server say no — into a page-level
 * alert behind an open drawer, where the reader could not see it.
 *
 * Returns null when the id is fine.
 */
export function tenantIdProblem(raw: string): string | null {
  const id = raw.trim();
  if (!id) return 'An id is required.';
  if (/\s/.test(id)) return 'No spaces — use hyphens, like "field-ops".';
  if (id !== id.toLowerCase()) return 'Lowercase only, like "field-ops".';
  if (!/^[a-z]/.test(id)) return 'Start with a letter.';
  if (id.length < 2 || id.length > 31) return 'Between 2 and 31 characters.';
  if (!/^[a-z][a-z0-9-]*$/.test(id)) return 'Letters, digits and hyphens only.';
  return null;
}
