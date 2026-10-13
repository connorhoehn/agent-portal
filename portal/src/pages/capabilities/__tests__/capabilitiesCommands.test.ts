import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capabilitiesAdapter, matchesCapability } from '../capabilitiesCommands.ts';

test('advertised examples drive search and refresh; nothing else is accepted', async () => {
  let query = 'q'; let refreshes = 0;
  const adapter = capabilitiesAdapter({ setQuery: (v) => { query = v; }, refresh: () => { refreshes++; } });
  await adapter.execute('search capabilities for Browser'); assert.equal(query, 'Browser');
  await adapter.execute('reset filters'); assert.equal(query, '');
  await adapter.execute('refresh'); assert.equal(refreshes, 1);
  for (const example of adapter.examples) await adapter.execute(example);
  assert.ok(!adapter.examples.some((e) => e.startsWith('open ')));
  query = 'kept'; refreshes = 0;
  for (const phrase of ['open Browser', 'start browser', 'delete memory', 'show missing capabilities']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(phrase)), phrase);
  }
  assert.equal(query, 'kept'); assert.equal(refreshes, 0);
});

test('search matches label, configured id, env var and state', () => {
  const row = { label: 'Browser profile', configuredId: 'bp-123', envVar: 'BROWSER_PROFILE_ID', state: 'missing' };
  for (const q of ['browser', 'BP-123', 'profile_id', 'missing', '']) assert.ok(matchesCapability(row, q), q);
  assert.equal(matchesCapability(row, 'guardrail'), false);
});
