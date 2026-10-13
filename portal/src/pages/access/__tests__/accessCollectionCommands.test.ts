import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCollectionCommand } from '../../../components/collections/collectionCommands.ts';
import { ACCESS_GRAMMARS, ACCESS_SCOPE_NOTES, accessCollectionAdapter, resolveAccessTarget, type AccessCollection } from '../accessCollectionCommands.ts';

const COLLECTIONS = Object.keys(ACCESS_GRAMMARS) as AccessCollection[];

for (const collection of COLLECTIONS) {
  const grammar = ACCESS_GRAMMARS[collection];
  test(`${collection}: bounded search, reset, refresh and exact open parse`, () => {
    assert.deepEqual(parseCollectionCommand(`search ${grammar.noun} for "SME"`, grammar), { kind: 'search', query: 'SME' });
    assert.deepEqual(parseCollectionCommand(`show all ${grammar.noun}`, grammar), { kind: 'reset' });
    assert.deepEqual(parseCollectionCommand(`refresh ${grammar.noun}`, grammar), { kind: 'refresh' });
    assert.deepEqual(parseCollectionCommand('open req-0001', grammar), { kind: 'open', target: 'req-0001' });
  });
  test(`${collection}: decisions, submissions and bulk verbs are refused`, () => {
    for (const text of ['approve req-0001', 'reject all', 'withdraw req-0001', 'grant sme to rhea', 'submit', 'revoke everything',
      'override policy', 'open all', 'open ""', 'delete policy sod-1']) {
      assert.throws(() => parseCollectionCommand(text, grammar), Error, text);
    }
  });
  test(`${collection}: the scope note says what commands never do`, () => {
    assert.match(ACCESS_SCOPE_NOTES[collection], /never|change nothing|records no decision|nothing is submitted/i);
  });
}

test('filters map only to the toolbar values each page owns', () => {
  assert.deepEqual(parseCollectionCommand('show open requests', ACCESS_GRAMMARS.requests), { kind: 'filter', value: 'open' });
  assert.deepEqual(parseCollectionCommand('filter closed', ACCESS_GRAMMARS.requests), { kind: 'filter', value: 'closed' });
  assert.deepEqual(parseCollectionCommand('show work catalog items', ACCESS_GRAMMARS.catalog), { kind: 'filter', value: 'orgiq' });
  assert.deepEqual(parseCollectionCommand('show blocking policies', ACCESS_GRAMMARS.policies), { kind: 'filter', value: 'block' });
  assert.deepEqual(parseCollectionCommand('filter override', ACCESS_GRAMMARS.audit), { kind: 'filter', value: 'sod-override' });
  assert.throws(() => parseCollectionCommand('show open approvals', ACCESS_GRAMMARS.approvals));
});

test('the adapter drives toolbar state and opens only through the page handler', async () => {
  const calls: string[] = [];
  const adapter = accessCollectionAdapter('requests', {
    setQuery: v => { calls.push(`query:${v}`); }, setFilter: v => { calls.push(`filter:${v}`); }, refresh: () => { calls.push('refresh'); },
    open: t => { calls.push(`open:${t}`); return `Opened ${t}.`; },
  });
  assert.equal(adapter.id, 'access-requests-commands');
  assert.ok(adapter.examples.includes('open <exact ID or title>'));
  await adapter.execute('search requests for Rhea');
  await adapter.execute('show open requests');
  await adapter.execute('reset filters');
  await adapter.execute('refresh');
  await adapter.execute('open req-0002');
  await assert.rejects(() => Promise.resolve(adapter.execute('approve req-0002')));
  assert.deepEqual(calls, ['query:Rhea', 'filter:open', 'query:', 'filter:', 'refresh', 'open:req-0002']);
});

test('pages without an open handler refuse open without touching state', async () => {
  const adapter = accessCollectionAdapter('reviews', {
    setQuery() { assert.fail('must not search'); }, refresh() { assert.fail('must not refresh'); },
  });
  await assert.rejects(() => Promise.resolve(adapter.execute('open campaign-1')), /not available/);
  assert.ok(!adapter.examples.some(e => e.startsWith('open ')));
});

test('record resolution keeps exact ids, needs a unique title and only sees shown rows', () => {
  const rows = [{ id: 'req-0001', title: 'SME in Work' }, { id: 'req-0002', title: 'SME in Work' }, { id: 'req-0003', title: 'Operator in Pipelines' }];
  assert.equal(resolveAccessTarget('req-0001', rows), rows[0]);
  assert.equal(resolveAccessTarget('operator in pipelines', rows), rows[2]);
  assert.throws(() => resolveAccessTarget('SME in Work', rows), /multiple/);
  assert.throws(() => resolveAccessTarget('REQ-0001', rows));
  assert.throws(() => resolveAccessTarget('req-0001', rows.slice(1)));
});
