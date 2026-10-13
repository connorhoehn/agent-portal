import assert from 'node:assert/strict';
import { test } from 'node:test';
import { knowledgeRegistryAdapter } from '../knowledgeCommands.ts';

function harness(rows = [{ id: 'kb-1', name: 'Org docs' }, { id: null, name: 'Unregistered live KB' }, { id: 'kb-2', name: 'Policies' }]) {
  const state = { search: 'x', status: 'attention' as string, refreshes: 0, navigated: [] as string[] };
  const adapter = knowledgeRegistryAdapter({
    setSearch: (v) => { state.search = v; }, setStatus: (v) => { state.status = v; },
    refresh: () => { state.refreshes++; }, rows, navigate: (p) => { state.navigated.push(p); },
  });
  return { state, adapter };
}

test('advertised examples drive the registry toolbar state', async () => {
  const { state, adapter } = harness();
  await adapter.execute('search knowledge bases for "org"'); assert.equal(state.search, 'org');
  await adapter.execute('reset filters'); assert.equal(state.search, ''); assert.equal(state.status, 'all');
  await adapter.execute('show needs attention knowledge bases'); assert.equal(state.status, 'attention');
  await adapter.execute('refresh'); assert.equal(state.refreshes, 1);
  for (const example of adapter.examples.filter((e) => !e.startsWith('open <'))) await adapter.execute(example);
});

test('mutating or unsupported phrases change nothing', async () => {
  const { state, adapter } = harness();
  for (const phrase of ['sync now', 'adopt kb-1', 'repoint Org docs', 'delete all knowledge bases', 'open all', 'show broken knowledge bases']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(phrase)), phrase);
  }
  assert.deepEqual(state, { search: 'x', status: 'attention', refreshes: 0, navigated: [] });
});

test('open resolves exact id or title on the current rows only', async () => {
  const { state, adapter } = harness();
  await adapter.execute('open kb-2'); await adapter.execute('open "org docs"');
  assert.deepEqual(state.navigated, ['/admin/knowledge/registry/kb-2', '/admin/knowledge/registry/kb-1']);
  await assert.rejects(() => Promise.resolve(adapter.execute('open Org')));
  await assert.rejects(() => Promise.resolve(adapter.execute('open Unregistered live KB')), /No matching/);
  const filtered = harness([{ id: 'kb-2', name: 'Policies' }]);
  await assert.rejects(() => Promise.resolve(filtered.adapter.execute('open kb-1')));
  assert.deepEqual(filtered.state.navigated, []);
});
