// A tenant's summary: who holds a grant there, and how many of its rail's
// surfaces read real rows yet. Shared by the social and pipelines routers'
// `GET /summary` (routes/social.ts, routes/pipelines.ts). Every number is
// counted from rows — grants from the identity store, surfaces from the
// tenant's registered catalog fixture — never typed (mock contract rule 1).

import { listUsers } from '../providers/identity.js';

export interface TenantSummary {
  tenant: string;
  /** Who holds a grant here, by role (the cross-tenant admin included). */
  members: { total: number; byRole: Record<string, number> };
  /** The rail's surfaces and how many read real rows yet. */
  surfaces: { total: number; live: number; pending: number };
}

export async function tenantMembers(tenant: string, roles: readonly string[]): Promise<TenantSummary['members']> {
  const users = await listUsers();
  const byRole: Record<string, number> = Object.fromEntries([...roles, 'admin'].map((r) => [r, 0]));
  let total = 0;
  for (const u of users) {
    const held = u.grants[tenant] ?? [];
    if (held.length === 0) continue;
    total += 1;
    for (const r of held) byRole[r] = (byRole[r] ?? 0) + 1;
  }
  return { total, byRole };
}
