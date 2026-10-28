// The seeder reads the whole policy store, not ListPolicies' first page. Reading
// one page made every boot re-create the seeds it missed (the live store held
// ~9 copies of each), and only the copy it saw was ever updated.
import { ListPoliciesCommand, type VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import { listAllPolicies, partitionSeedPolicies, type PolicyItem } from '../avp-policies.js';

const item = (policyId: string, description: string, lastUpdatedDate: string) =>
  ({ policyId, lastUpdatedDate: new Date(lastUpdatedDate), definition: { static: { description } } }) as unknown as PolicyItem;

test('listAllPolicies follows nextToken to the last page', async () => {
  const pages: Record<string, { policies: PolicyItem[]; nextToken?: string }> = {
    first: { policies: [item('a', 'x', '2026-10-01')], nextToken: 't2' },
    t2: { policies: [item('b', 'y', '2026-10-01')], nextToken: 't3' },
    t3: { policies: [item('c', 'z', '2026-10-01')] },
  };
  const asked: Array<string | undefined> = [];
  const avp = { send: async (cmd: ListPoliciesCommand) => { asked.push(cmd.input.nextToken); return pages[cmd.input.nextToken ?? 'first']; } };
  const all = await listAllPolicies(avp as unknown as VerifiedPermissionsClient, 'ps-1');
  expect(all.map((p) => p.policyId)).toEqual(['a', 'b', 'c']);
  expect(asked).toEqual([undefined, 't2', 't3']);
});

test('one policy per seed description survives, the latest-updated; other policies are untouched', () => {
  const { keep, extra } = partitionSeedPolicies([
    item('old', 'OrgIQ member role (seed) (1)', '2026-10-26T14:00:00Z'),
    item('new', 'OrgIQ member role (seed) (1)', '2026-10-28T14:00:00Z'),
    item('mid', 'OrgIQ member role (seed) (1)', '2026-10-27T14:00:00Z'),
    item('solo', 'OrgIQ social/participant role (seed) (2)', '2026-10-26T14:00:00Z'),
    item('hand-1', 'hand-written admin policy', '2026-10-01T00:00:00Z'),
    item('hand-2', 'hand-written admin policy', '2026-10-02T00:00:00Z'),
  ]);
  expect(Object.fromEntries(keep)).toEqual({
    'OrgIQ member role (seed) (1)': 'new',
    'OrgIQ social/participant role (seed) (2)': 'solo',
  });
  expect(extra.sort()).toEqual(['mid', 'old']);
});
