// Which workspace a URL belongs to, decided once above the shell (components/shell/WorkspaceGate.tsx).
// Every tenant tree's root comes from the manifest (tenants.generated.ts portalRoot); orgiq's product
// also owns /admin, which has always been gated on the orgiq tenant (RequireTenant in App.tsx). A path
// under no workspace's root (the index, /settings, an unknown URL) belongs to nobody and every
// session may open it.

import { TENANT_MANIFEST, TENANTS, type Tenant } from './tenants.generated.ts';

/** Roots owned by orgiq besides its manifest portalRoot. */
const ORGIQ_EXTRA_ROOTS: readonly string[] = ['/admin'];

function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function pathOwner(pathname: string): Tenant | null {
  for (const tenant of TENANTS) {
    if (under(pathname, TENANT_MANIFEST[tenant].portalRoot)) return tenant;
  }
  if (ORGIQ_EXTRA_ROOTS.some((root) => under(pathname, root))) return 'orgiq';
  return null;
}

/** Whether a session (tenant + role, or none) may be shown the shell for `owner`'s paths. */
export function mayOpenOwnerShell(session: { tenant: string; role: string } | null | undefined, owner: Tenant | null): boolean {
  if (owner === null) return true;
  if (!session) return false;
  return session.role === 'admin' || session.tenant === owner;
}
