import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePipelineCollectionCommand, pipelineCollectionAdapter, resolvePipelineCollectionTarget } from '../pipelineCollectionCommands.ts';

for (const collection of ['agents', 'bots', 'commands', 'approvals'] as const) {
  test(`${collection} accepts bounded search, reset, refresh and exact open`, () => {
    assert.deepEqual(parsePipelineCollectionCommand(`search ${collection} for "API"`, collection), { kind: 'search', query: 'API' });
    assert.deepEqual(parsePipelineCollectionCommand(`show all ${collection}`, collection), { kind: 'reset' });
    assert.deepEqual(parsePipelineCollectionCommand(`refresh ${collection}`, collection), { kind: 'refresh' });
    assert.deepEqual(parsePipelineCollectionCommand('open "API review"', collection), { kind: 'open', target: 'API review' });
  });
  test(`${collection} rejects mutations and unimplemented qualifiers`, () => {
    for (const text of ['approve all', 'reject API review', 'run API', 'pause all bots', 'show failed bots', 'show all approvals from last week', 'open all', 'open ""']) {
      assert.throws(() => parsePipelineCollectionCommand(text, collection));
    }
  });
}

test('record resolution preserves exact IDs, rejects ambiguity and excludes filtered rows', () => {
  const rows = [{ id: 'Bot:ONE', title: 'API' }, { id: 'bot:two', title: 'API' }, { id: 'bot:three', title: 'Other review' }];
  assert.equal(resolvePipelineCollectionTarget('Bot:ONE', rows), rows[0]);
  assert.equal(resolvePipelineCollectionTarget('other REVIEW', rows), rows[2]);
  for (const target of ['bot:one', 'API', 'Other', 'bot:missing']) assert.throws(() => resolvePipelineCollectionTarget(target, rows));
  assert.throws(() => resolvePipelineCollectionTarget('Bot:ONE', rows.slice(1)));
});

test('read-only adapter maps to toolbar state and opens only through declared handler', () => {
  const calls: string[] = [];
  const adapter = pipelineCollectionAdapter('approvals', {
    setQuery(value) { calls.push(`query:${value}`); }, refresh() { calls.push('refresh'); }, scopeNote: 'No decisions.',
    open(target) { calls.push(`open:${target}`); return 'Opened for review.'; },
  });
  adapter.execute('search approvals for API');
  adapter.execute('reset filters');
  adapter.execute('refresh');
  adapter.execute('open API');
  assert.deepEqual(calls, ['query:API', 'query:', 'refresh', 'open:API']);
  assert.throws(() => adapter.execute('approve API'));
  assert.deepEqual(calls, ['query:API', 'query:', 'refresh', 'open:API']);
});

test('adapters without an open handler reject it without changing state', () => {
  const adapter = pipelineCollectionAdapter('definitions', {
    setQuery() { assert.fail('must not change query'); }, setFilter() { assert.fail('must not change filter'); },
    refresh() { assert.fail('must not refresh'); }, scopeNote: 'Filters only.',
  });
  assert.throws(() => adapter.execute('open API'), /not available/);
  assert.ok(!adapter.examples.some(example => example.startsWith('open ')));
});
