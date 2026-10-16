// The access tenant's projection: build, visibility, "my" binding, update on write.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async (_p: unknown, action: string) => action === 'DecideAccess' ? (_p as { role: string }).role !== 'requester' : true) }));
import { fixtureRegistry } from '../../../mock/core/index.js';
import { accessRequestsFixture } from '../../../mock/access-requests.js';
import { casRequest, insertRequest } from '../../../providers/access.js';
import { __resetSearchIndex, ensureIndexed } from '../registry.js';
import { searchTenant } from '../tenant-query.js';

const rhea = { sub: 'u-rhea', tenant: 'access', role: 'requester' };
const omar = { sub: 'u-omar', tenant: 'access', role: 'approver' };
const priya = { sub: 'u-priya', tenant: 'access', role: 'access-admin' };
const nora = { sub: 'u-nora', tenant: 'access', role: 'requester' };
const ids = async (p: typeof rhea, q: string, type?: string) => (await searchTenant('access', p, { q, limit: 20, ...(type ? { type } : {}) })).results.map((r) => `${r.type}:${r.id}`);
const tick = () => new Promise((r) => setTimeout(r, 50));

beforeEach(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });

test('every record type is built', async () => {
  const { index, partition } = await ensureIndexed('access');
  const types = new Set((await index.query({ tenant: partition, terms: [] })).docs.map((d) => d.type));
  expect([...types].sort()).toEqual(['catalog', 'delegation', 'event', 'policy', 'request', 'review', 'review-item']);
});

test('a request is visible to its party and deciders, not to an outsider', async () => {
  expect(await ids(rhea, 'req-0002', 'request')).toContain('request:req-0002');
  expect(await ids(omar, 'req-0002', 'request')).toContain('request:req-0002');
  expect(await ids(nora, 'req-0002', 'request')).not.toContain('request:req-0002');
  expect(await ids(nora, 'req-0004', 'request')).toContain('request:req-0004');
});

test('"waiting on me" lists the open steps the reader may decide, never the reader\'s own', async () => {
  expect(await ids(omar, "what's waiting on me")).toContain('request:req-0001');
  expect(await ids(rhea, "what's waiting on me")).not.toContain('request:req-0001');
});

test('"my pending requests" binds to the reader, and a clone acts as its persona', async () => {
  expect(await ids(rhea, 'my pending access requests')).toEqual(expect.arrayContaining(['request:req-0001', 'request:req-0002']));
  expect(await ids(rhea, 'my pending access requests')).not.toContain('request:req-0007');
  expect(await ids(omar, 'my pending access requests')).not.toContain('request:req-0001');
});

test('review items are the decider\'s, or the reviewed user\'s own', async () => {
  expect(await ids(omar, 'undecided review items')).toContain('review-item:ri-0003');
  expect(await ids(rhea, 'undecided review items')).not.toContain('review-item:ri-0003');
});

test('an off-topic query returns nothing', async () => {
  expect(await ids(priya, 'kubernetes pizza')).toEqual([]);
});

test('a new request and its transition are searchable without a rebuild', async () => {
  const before = await ensureIndexed('access');
  const base = accessRequestsFixture.rows().find((r) => r.id === 'req-0002')!;
  insertRequest({ ...base, id: 'req-0099', justification: 'Quokka rehearsal access', status: 'submitted' }, [], [{ kind: 'submitted', before: 'draft', after: 'submitted', reason: null }], 'u-rhea');
  await tick();
  expect(await ids(rhea, 'quokka')).toContain('request:req-0099');
  casRequest('req-0099', { from: ['submitted'] }, { status: 'withdrawn' }, [{ kind: 'withdrawn', before: 'submitted', after: 'withdrawn', reason: 'changed my mind' }], 'u-rhea', new Date().toISOString());
  await tick();
  expect(await ids(rhea, 'withdrawn requests')).toContain('request:req-0099');
  expect((await ensureIndexed('access')).meta.builtAt).toBe(before.meta.builtAt);
});
