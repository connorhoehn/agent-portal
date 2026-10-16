// The pipelines tenant's projection (lib/search-index/pipelines.ts): what it
// indexes, how phrases map to facets, and that a writer's change is searchable
// without a rebuild (docs/user-search-goal.md S2).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
import { fixtureRegistry } from '../../../mock/core/index.js';
import { __resetSearchIndex, ensureIndexed } from '../registry.js';
import { searchTenant } from '../tenant-query.js';
import { parseTenantQuery } from '../tenant-query.js';
import { pipelinesSpec, projectPipelinesRecord } from '../pipelines.js';
import { setPausedReason, listBots } from '../../../providers/bots.js';

const principal = { sub: 'u-kofi', tenant: 'pipelines', role: 'operator' };
const ask = (q: string) => searchTenant('pipelines', principal, { q, limit: 20 });

beforeEach(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });

test('every record type the tenant derives is projected', async () => {
  const { index, partition } = await ensureIndexed('pipelines');
  for (const type of ['run', 'definition', 'runbook', 'bot', 'approval', 'queue', 'artifact']) {
    expect((await index.query({ tenant: partition, terms: [], types: [type] })).docs.length).toBeGreaterThan(0);
  }
});

test('phrases name a type and a facet', () => {
  expect(parseTenantQuery('which runs failed this week', pipelinesSpec)).toMatchObject({ types: ['run'], facets: { status: ['failed'] }, terms: [] });
  expect(parseTenantQuery('runbooks needing a dry run', pipelinesSpec)).toMatchObject({ types: ['runbook'], facets: { dryRun: ['none'] } });
  expect(parseTenantQuery('what is waiting for my approval', pipelinesSpec).facets).toEqual({ approvalState: ['pending'] });
});

test('failed runs answer with failed runs only, carrying the error', async () => {
  const out = await ask('failed runs');
  expect(out.results.length).toBeGreaterThan(0);
  expect(out.results.every(r => r.type === 'run' && r.status === 'failed')).toBe(true);
  expect((await ask('why did the token verifier run fail')).results[0]?.description).toMatch(/verify\.test\.ts/);
});

test('an off-topic question returns nothing rather than unrelated rows', async () => {
  expect((await ask('quarterly offsite catering budget')).results).toEqual([]);
  expect((await ask('security group runbook')).results).toEqual([]);
});

test('who approved a change names the decider; pending ones are the inbox', async () => {
  const decided = (await ask('who approved RED dashboards')).results[0]!;
  expect(decided.type).toBe('approval');
  expect(decided.subtitle).toMatch(/decided by/);
  const pending = await ask('pending approvals');
  expect(pending.results.every(r => r.status === 'pending')).toBe(true);
});

test('a pause is searchable on the next query without a rebuild', async () => {
  const before = await ensureIndexed('pipelines');
  const bot = (await listBots()).find(b => b.enabled && !b.pausedReason)!;
  expect((await ask('paused bots')).results.some(r => r.id === bot.id && /paused:/.test(r.subtitle ?? ''))).toBe(false);
  await setPausedReason(bot.id, 'budget hit');
  const row = (await ask('paused bots')).results.find(r => r.id === bot.id);
  expect(row?.subtitle).toMatch(/paused: budget hit/);
  expect((await ensureIndexed('pipelines')).meta.builtAt).toBe(before.meta.builtAt);
  expect((await projectPipelinesRecord(before.partition, 'bot', bot.id))?.facets['inactive']).toEqual(['true']);
});

test('rows carry real portal hrefs', async () => {
  const out = await ask('score-dimensions');
  expect(out.results.find(r => r.type === 'definition')?.href).toBe('/pipelines/definitions/assessment%3Ascore-dimensions');
  expect((await ask('token verifier')).results.find(r => r.type === 'run')?.href).toMatch(/^\/pipelines\/runs\/[a-z-]+%3A/);
});
