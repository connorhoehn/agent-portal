// Update on write (docs/user-search-goal.md decision 1): a writer's change is
// searchable on the next query without a rebuild, inside the partition it was
// written to — a mock scope's write never reaches the shared world's index.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../../../providers/recording-search.js', () => ({ listRecordingSearchRecords: jest.fn(async () => ({ records: [], partial: [] })), resolveRecordingSearchRecord: jest.fn() }));
import { searchRecords } from '../../../providers/search.js';
import { createWorkItem, updateWorkItem } from '../../../providers/work-items.js';
import { fixtureRegistry, createMockScope, runInMockScope } from '../../../mock/core/index.js';
import { __resetSearchIndex, ensureIndexed } from '../registry.js';

const principal = { sub: 'u-theo', tenant: 'orgiq', role: 'member' };
const keys = async (q: string) => (await searchRecords(principal, { q })).results.map(r => `${r.type}:${r.id}`);

beforeEach(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });

test('a created and then renamed work item is found by its new title only, without a rebuild', async () => {
  const before = await ensureIndexed('orgiq');
  const item = await createWorkItem({ projectId: 'p-auth-migration', type: 'story', title: 'Quokka handshake rollout' });
  expect(await keys('quokka')).toContain(`work:${item.id}`);
  await updateWorkItem(item.id, { title: 'Wombat handshake rollout' });
  expect(await keys('quokka')).not.toContain(`work:${item.id}`);
  expect(await keys('wombat')).toContain(`work:${item.id}`);
  expect((await ensureIndexed('orgiq')).meta.builtAt).toBe(before.meta.builtAt);
});

test('a write inside a mock scope is indexed in that scope only', async () => {
  await ensureIndexed('orgiq');
  const scope = createMockScope({ base: 'default', label: 'write-through test' });
  const id = await runInMockScope(scope, async () => (await createWorkItem({ projectId: 'p-auth-migration', type: 'story', title: 'Platypus cutover drill' })).id);
  expect(await runInMockScope(scope, () => keys('platypus'))).toContain(`work:${id}`);
  expect(await keys('platypus')).not.toContain(`work:${id}`);
});

test('a reset of the shared world is never answered from the old projection', async () => {
  const item = await createWorkItem({ projectId: 'p-auth-migration', type: 'story', title: 'Echidna rollback rehearsal' });
  expect(await keys('echidna')).toContain(`work:${item.id}`);
  fixtureRegistry.resetAll();
  expect(await keys('echidna')).toEqual([]);
});
