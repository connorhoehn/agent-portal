jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, region: 'us-east-1', aurora: {} } }));
jest.mock('../aurora.js', () => ({ exec: jest.fn() }));

import { createWorkItem, getWorkItem, updateWorkItem } from '../work-items.js';
import { workItems } from '../../mock/work-items.js';
import { fixtureRegistry } from '../../mock/core/index.js';
import { SEEDED_WORK_KEYS } from '../../lib/work-item-keys.js';

afterEach(() => fixtureRegistry.resetAll('default'));

it('gives every seeded row its reserved unique key, including epics', () => {
  const rows = workItems.rows('default');
  expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
  for (const row of rows) expect(row.key).toBe(SEEDED_WORK_KEYS[row.id]);
});

it('allocates after reserved seed numbers and keeps the key when title, status and parent change', async () => {
  const first = await createWorkItem({ projectId: 'p-observability', type: 'story', title: 'First follow-up' });
  const second = await createWorkItem({ projectId: 'p-observability', type: 'bug', title: 'Second follow-up' });
  expect(first.key).toBe('ORG-OBS-15');
  expect(second.key).toBe('ORG-OBS-16');
  await updateWorkItem(first.id, { title: 'Renamed follow-up', status: 'in_progress', parentId: 'wi-obs-e2' });
  expect((await getWorkItem(first.id))?.key).toBe(first.key);
});

it('large scenarios have unique keys and resets restore exactly the original mappings', () => {
  const initial = workItems.rows().map(row => [row.id, row.key]);
  fixtureRegistry.resetAll('large');
  const large = workItems.rows();
  expect(new Set(large.map(row => row.key)).size).toBe(large.length);
  fixtureRegistry.resetAll('default');
  expect(workItems.rows().map(row => [row.id, row.key])).toEqual(initial);
});
