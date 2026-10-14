// Capability grants: entries in a tenant's grant list that are NOT roles
// (middleware lib/session.ts CAPABILITY_GRANTS). orgiq `budgets-reader` opens
// the budget figures and nothing else; nobody acts AS it, so role pickers and
// tenant lists leave it out. The server already drops it from
// `availableRoles` / `availableTenants`; this is the same rule for the places
// that read the raw `grants` map.

export const CAPABILITY_GRANTS: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['budgets-reader'],
};

export function isCapabilityGrant(tenant: string, entry: string): boolean {
  return (CAPABILITY_GRANTS[tenant] ?? []).includes(entry);
}

/** The roles held in `tenant`, without capability grants. */
export function roleGrants(grants: Readonly<Record<string, readonly string[]>> | null | undefined, tenant: string): string[] {
  return (grants?.[tenant] ?? []).filter((r) => !isCapabilityGrant(tenant, r));
}
