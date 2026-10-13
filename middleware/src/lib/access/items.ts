// What a request names, resolved (lane A2).
//
// A grant request names a catalog item (access_catalog_items.id) and only a
// catalog item: one that has left the catalog cannot be provisioned. A
// revocation — created by an access review over a STANDING grant — names the
// grant as `role:<tenant>:<role>`, the same id shape a catalog role carries,
// and that grant need not be requestable (orgiq `member`, `hr-admin`, …). So a
// revocation resolves to its catalog item when there is one, and otherwise to
// a role descriptor built from the id itself; the descriptor is never offered
// in the catalog and never provisioned.

import type { AccessCatalogRow } from '../../mock/access-catalog.js';
import { ACCESS_TENANTS, type AccessTenant } from './types.js';

const TENANT_TITLES: Readonly<Record<AccessTenant, string>> = {
  orgiq: 'Work', assessment: 'Assessment', social: 'Social', pipelines: 'Pipelines',
};

/** The id a standing (tenant, role) grant is named by. */
export const roleItemId = (tenant: string, role: string): string => `role:${tenant}:${role}`;

/** `role:<tenant>:<role>` → a role descriptor, or null when the id has another shape. */
export function roleItem(id: string, catalog: readonly AccessCatalogRow[] = []): AccessCatalogRow | null {
  const known = catalog.find((i) => i.id === id);
  if (known) return known;
  const m = /^role:([a-z]+):([a-z][a-z-]*)$/.exec(id);
  if (!m || !(ACCESS_TENANTS as readonly string[]).includes(m[1]!)) return null;
  const tenant = m[1] as AccessTenant;
  const role = m[2]!;
  return {
    id, kind: 'tenant-role', tenant, role, projectId: null,
    title: `${role.replaceAll('-', ' ').replace(/^./, (c) => c.toUpperCase())} in ${TENANT_TITLES[tenant]}`,
    description: 'A standing grant in the directory; not offered in the catalog.',
    sensitive: false, defaultDuration: 'standing', stewardRule: 'tenant-steward',
  };
}

/** The item a request acts on: the catalog item, or (revocations only) the role descriptor. */
export function requestItem(request: { kind: 'grant' | 'revocation'; itemId: string }, catalog: readonly AccessCatalogRow[]): AccessCatalogRow | undefined {
  const known = catalog.find((i) => i.id === request.itemId);
  if (known) return known;
  return request.kind === 'revocation' ? roleItem(request.itemId) ?? undefined : undefined;
}
