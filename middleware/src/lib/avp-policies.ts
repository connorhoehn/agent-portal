// Verified Permissions policy listing shared by the boot seeder and the admin
// route, kept apart from policy-seeds.ts (import.meta path resolution) so both
// stay testable.
import { ListPoliciesCommand, type ListPoliciesCommandOutput, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';

export type PolicyItem = NonNullable<ListPoliciesCommandOutput['policies']>[number];

/** Every policy in the store. ListPolicies pages; one send reads only the first page. */
export async function listAllPolicies(avp: VerifiedPermissionsClient, policyStoreId: string): Promise<PolicyItem[]> {
  const all: PolicyItem[] = [];
  let nextToken: string | undefined;
  do {
    const page = await avp.send(new ListPoliciesCommand({ policyStoreId, nextToken }));
    all.push(...(page.policies ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return all;
}

const SEED_DESCRIPTION = /^OrgIQ \S+ role \(seed\)/;
const updatedAt = (p: PolicyItem) => new Date(p.lastUpdatedDate ?? p.createdDate ?? 0).getTime();

/**
 * One policy per seed description: the latest-updated copy is kept (the one
 * the seeder compares and updates), every other copy is returned as extra.
 * Policies without a seed description are never touched.
 */
export function partitionSeedPolicies(policies: PolicyItem[]): { keep: Map<string, string>; extra: string[] } {
  const bySeed = new Map<string, PolicyItem[]>();
  for (const p of policies) {
    const desc = p.definition?.static?.description ?? '';
    if (p.policyId && SEED_DESCRIPTION.test(desc)) bySeed.set(desc, [...(bySeed.get(desc) ?? []), p]);
  }
  const keep = new Map<string, string>();
  const extra: string[] = [];
  for (const [desc, copies] of bySeed) {
    const [latest, ...rest] = [...copies].sort((a, b) => updatedAt(b) - updatedAt(a));
    keep.set(desc, latest!.policyId!);
    extra.push(...rest.map((p) => p.policyId!));
  }
  return { keep, extra };
}
