// The assessment tenant's projection: what is built, how a question finds it,
// and that a writer's change is searchable without a rebuild (S2).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
import { fixtureRegistry, createMockScope, runInMockScope } from '../../../mock/core/index.js';
import { createFeedback, createTeam, patchTeam, deleteTeam } from '../../../providers/assessment.js';
import { __resetSearchIndex, ensureIndexed } from '../registry.js';
import { searchTenant } from '../tenant-query.js';

const asha = { sub: 'u-asha', tenant: 'assessment', role: 'assessor' };
const find = async (q: string, p = asha) => (await searchTenant('assessment', p, { q, limit: 20 })).results.map(r => `${r.type}:${r.id}`);

beforeEach(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });

test('the build holds teams, dimensions, runs, submissions, feedback and documents', async () => {
  const { index, partition } = await ensureIndexed('assessment');
  const types = new Set((await index.query({ tenant: partition, terms: [] })).docs.map(d => d.type));
  for (const t of ['team', 'dimension', 'exception', 'feedback', 'run', 'submission', 'story', 'document']) expect(types).toContain(t);
});

test('a team is found by name, by id and by its lead; "my teams" binds to the reader', async () => {
  expect(await find('Northstar Payments')).toContain('team:TEAM-001');
  expect(await find('find team TEAM-001')).toContain('team:TEAM-001');
  expect(await find('who leads Data Platform')).toContain('team:TEAM-004');
  const mine = await find('my teams');
  expect(mine).toContain('team:TEAM-001');
  expect(mine).not.toContain('team:TEAM-004');
});

test('status phrases map to facets: failed runs, staged submissions, below-target teams', async () => {
  const failed = (await searchTenant('assessment', asha, { q: 'which runs failed this week' })).results;
  expect(failed.length).toBeGreaterThan(0);
  expect(failed.every(r => r.type === 'run' && r.subtitle?.includes('failed'))).toBe(true);
  expect((await find('staged submissions')).every(k => k.startsWith('submission:'))).toBe(true);
  expect(await find('which teams are below target')).toEqual(expect.arrayContaining(['team:TEAM-005']));
});

test('an off-topic question returns nothing instead of unrelated rows', async () => {
  expect(await find('quarterly kubernetes cluster budget zebra')).toEqual([]);
});

test('a created and renamed team is searchable on the next query, without a rebuild', async () => {
  const before = await ensureIndexed('assessment');
  const team = await createTeam({ name: 'Quokka Ledger', cohort: 'general' });
  expect(await find('quokka')).toContain(`team:${team.id}`);
  await patchTeam(team.id, { name: 'Wombat Ledger' });
  expect(await find('quokka')).not.toContain(`team:${team.id}`);
  expect(await find('wombat')).toContain(`team:${team.id}`);
  await deleteTeam(team.id);
  expect(await find('wombat')).toEqual([]);
  expect((await ensureIndexed('assessment')).meta.builtAt).toBe(before.meta.builtAt);
});

test('a created feedback task is searchable, and only inside the scope that wrote it', async () => {
  await ensureIndexed('assessment');
  const scope = createMockScope({ base: 'default', label: 'assessment write-through' });
  const task = await runInMockScope(scope, () => createFeedback({ team_id: 'TEAM-001', kind: 'follow_up', question: 'Platypus deploy window evidence?' }));
  expect(await runInMockScope(scope, () => find('platypus'))).toContain(`feedback:${task.task_id}`);
  expect(await find('platypus')).toEqual([]);
});
