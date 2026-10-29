// The Cedar role files tenants/manifest.json registers (DE-29): the one list
// the policy seeder (policy-seeds.ts) and the role registry (role-registry.ts)
// walk. Kept free of `import.meta` so jest can import it.
//
// A cross-tenant role is seeds/roles/<role>.cedar; a tenant role is
// seeds/roles/<tenant>/<role>.cedar. scripts/check-tenant-manifest.mjs fails
// when a directory holds a file the manifest does not list (or the reverse),
// so the manifest and the directory walk this replaced name the same files.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CROSS_TENANT_ROLES, ROLES_BY_TENANT, TENANTS } from './tenants.generated.js';

export interface ManifestRoleFile {
  role: string;
  /** null for a cross-tenant role (admin). */
  tenant: string | null;
  /**
   * The policy seeder's key: 'member' or 'assessment/assessor'. The tenant
   * prefix is omitted for orgiq and root-level files so seeded policy
   * descriptions stay byte-identical with stores seeded before the
   * multi-tenant reorg — a fixed fact of those stores, hence the literal.
   */
  key: string;
  path: string;
}

/** Every registered role file under `rolesDir`. Throws when one is missing: a
 *  role the manifest names but Cedar never defines would deny every check. */
export function manifestRoleFiles(rolesDir: string): ManifestRoleFile[] {
  const out: ManifestRoleFile[] = [];
  for (const role of CROSS_TENANT_ROLES) out.push({ role, tenant: null, key: role, path: join(rolesDir, `${role}.cedar`) });
  for (const tenant of TENANTS) {
    for (const role of ROLES_BY_TENANT[tenant]) {
      out.push({ role, tenant, key: tenant === 'orgiq' ? role : `${tenant}/${role}`, path: join(rolesDir, tenant, `${role}.cedar`) });
    }
  }
  const missing = out.filter((f) => !existsSync(f.path)).map((f) => f.path);
  if (missing.length) throw new Error(`tenants/manifest.json registers roles with no Cedar file: ${missing.join(', ')}`);
  return out;
}
