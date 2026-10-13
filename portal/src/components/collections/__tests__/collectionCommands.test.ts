import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter, parseCollectionCommand, resolveCollectionTarget } from '../collectionCommands.ts';

const grammar = { noun: 'work items', filters: { open: 'open', blocked: 'blocked' }, extra: ['show my work'] } as const;

test('parse: search keeps punctuation and case, bounded verbs, unknown prose is refused', () => {
  assert.deepEqual(parseCollectionCommand('search work items for "DEP-5.1"', grammar), { kind: 'search', query: 'DEP-5.1' });
  assert.deepEqual(parseCollectionCommand('find Auth', grammar), { kind: 'search', query: 'Auth' });
  assert.deepEqual(parseCollectionCommand('Please refresh work items!', grammar), { kind: 'refresh' });
  assert.deepEqual(parseCollectionCommand('show all work items', grammar), { kind: 'reset' });
  assert.deepEqual(parseCollectionCommand('show blocked work items', grammar), { kind: 'filter', value: 'blocked' });
  assert.deepEqual(parseCollectionCommand('filter open', grammar), { kind: 'filter', value: 'open' });
  assert.deepEqual(parseCollectionCommand('open wi-1', grammar), { kind: 'open', target: 'wi-1' });
  assert.deepEqual(parseCollectionCommand('Show my work', grammar), { kind: 'extra', phrase: 'show my work' });
  for (const phrase of ['', 'delete everything', 'open all', 'search for ""', 'run all', 'assign to me', 'x'.repeat(501)]) {
    assert.throws(() => parseCollectionCommand(phrase, grammar), Error, phrase);
  }
});

test('adapter: advertised examples execute; unsupported commands cannot touch the controls', async () => {
  let query = 'q'; let filter = 'f'; let refreshes = 0; let opened = ''; let extra = '';
  const adapter = collectionCommandAdapter(grammar, {
    setQuery: v => { query = v; }, setFilter: v => { filter = v; }, refresh: () => { refreshes++; }, scopeNote: 'Loaded rows only.',
    open: target => { opened = target; return `Opened ${target}.`; }, extra: phrase => { extra = phrase; return { message: 'Mine.' }; },
  });
  await assert.rejects(() => Promise.resolve(adapter.execute('delete everything')));
  assert.equal(query, 'q'); assert.equal(filter, 'f'); assert.equal(refreshes, 0); assert.equal(opened, '');
  await adapter.execute('search for "literal and punctuation!"');
  assert.equal(query, 'literal and punctuation!'); assert.equal(filter, 'f');
  await adapter.execute('refresh'); assert.equal(refreshes, 1);
  await adapter.execute('reset filters'); assert.equal(query, ''); assert.equal(filter, '');
  await adapter.execute('open WI-9'); assert.equal(opened, 'WI-9');
  await adapter.execute('show my work'); assert.equal(extra, 'show my work');
  for (const example of adapter.examples.filter(e => !e.startsWith('open <'))) await assert.doesNotReject(() => Promise.resolve(adapter.execute(example)), example);
  assert.match(adapter.placeholder, /^Search work items, filter, open a record, or refresh/);
});

test('adapter without filter/open refuses those verbs without changing state', async () => {
  let query = 'q'; let refreshes = 0;
  const adapter = collectionCommandAdapter({ noun: 'sources' }, { setQuery: v => { query = v; }, refresh: () => { refreshes++; }, scopeNote: 'Loaded rows.' });
  await assert.rejects(() => Promise.resolve(adapter.execute('open src-1')), /not available/);
  await assert.rejects(() => Promise.resolve(adapter.execute('show open sources')));
  assert.equal(query, 'q'); assert.equal(refreshes, 0);
  assert.equal(adapter.examples.includes('open <exact ID or title>'), false);
});

test('resolveCollectionTarget: exact id, unique title, never fuzzy or bulk', () => {
  const rows = [{ id: 'a', title: 'Auth' }, { id: 'b', title: 'Billing' }, { id: 'c', title: 'billing' }];
  assert.equal(resolveCollectionTarget('a', rows).id, 'a');
  assert.equal(resolveCollectionTarget('AUTH', rows).id, 'a');
  assert.throws(() => resolveCollectionTarget('billing', rows), /multiple/);
  assert.throws(() => resolveCollectionTarget('Auth*', rows), /No matching/);
});
