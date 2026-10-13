import assert from 'node:assert/strict';
import { test } from 'node:test';
import { botsCommandAdapter } from '../botsCommands.ts';

function harness(rows = [{ id: 'bot-1', name: 'Dependency bumper' }, { id: 'bot-2', name: 'Lint fixer' }]) {
  const state = { query: 'q', status: 'paused' as string, refreshes: 0, opened: '' };
  const adapter = botsCommandAdapter({
    setQuery: v => { state.query = v; }, setStatus: v => { state.status = v; }, refresh: () => { state.refreshes++; },
    rows, open: id => { state.opened = id; },
  });
  return { state, adapter };
}

test('bots: advertised examples drive search, status filter, reset and refresh', async () => {
  const { state, adapter } = harness();
  await adapter.execute('search bots for "lint"'); assert.equal(state.query, 'lint');
  await adapter.execute('show enabled bots'); assert.equal(state.status, 'enabled');
  await adapter.execute('filter paused'); assert.equal(state.status, 'paused');
  await adapter.execute('reset filters'); assert.equal(state.query, ''); assert.equal(state.status, 'all');
  await adapter.execute('refresh'); assert.equal(state.refreshes, 1);
  for (const example of adapter.examples.filter(e => !e.startsWith('open <'))) await adapter.execute(example);
});

test('bots: mutations and unknown filters change nothing', async () => {
  const { state, adapter } = harness();
  for (const text of ['run Lint fixer', 'pause all bots', 'delete bot-1', 'show failed bots', 'create a bot', 'open all']) {
    await assert.rejects(() => Promise.resolve(adapter.execute(text)), text);
  }
  assert.deepEqual(state, { query: 'q', status: 'paused', refreshes: 0, opened: '' });
});

test('bots: open resolves exact id or name on the current rows only', async () => {
  const { state, adapter } = harness();
  await adapter.execute('open bot-2'); assert.equal(state.opened, 'bot-2');
  await adapter.execute('open "dependency BUMPER"'); assert.equal(state.opened, 'bot-1');
  await assert.rejects(() => Promise.resolve(adapter.execute('open Dependency')), /No matching/);
  const narrowed = harness([{ id: 'bot-2', name: 'Lint fixer' }]);
  await assert.rejects(() => Promise.resolve(narrowed.adapter.execute('open bot-1')), /No matching/);
  assert.equal(narrowed.state.opened, '');
});
