import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../../components/collections/collectionCommands.ts';
import {
  OBSERVABILITY_GRAMMARS, approvalTarget, guardrailRuleTarget, invocationTarget, matchesAny,
  memoryEventTarget, sessionTarget, type ObservabilityCollection,
} from '../observabilityCommands.ts';

// The pages that reveal an existing record (a run page, a session, an event
// row, a rule's interventions, an approval's payload). The rest have no
// record detail and must not advertise `open`.
const OPENABLE = new Set<ObservabilityCollection>(['runs', 'sessions', 'memory', 'guardrails', 'approvals']);

function harness(collection: ObservabilityCollection) {
  const grammar = OBSERVABILITY_GRAMMARS[collection];
  const state = { query: 'q', filter: 'f', refreshes: 0, opened: '', extra: '' };
  const hasFilter = Object.keys(grammar.filters ?? {}).length > 0;
  const adapter = collectionCommandAdapter(grammar, {
    setQuery: (v) => { state.query = v; },
    ...(hasFilter ? { setFilter: (v: string) => { state.filter = v; } } : {}),
    refresh: () => { state.refreshes++; },
    scopeNote: 'Loaded rows only.',
    ...(OPENABLE.has(collection) ? { open: (t: string) => { state.opened = t; return `Opened ${t}.`; } } : {}),
    ...(grammar.extra?.length ? { extra: (p: string) => { state.extra = p; return { message: p }; } } : {}),
  });
  return { grammar, state, adapter };
}

for (const collection of Object.keys(OBSERVABILITY_GRAMMARS) as ObservabilityCollection[]) {
  test(`${collection}: every advertised example drives the controlled state`, async () => {
    const { grammar, state, adapter } = harness(collection);
    assert.equal(adapter.examples.includes('open <exact ID or title>'), OPENABLE.has(collection));
    for (const example of adapter.examples.filter((e) => !e.startsWith('open <'))) {
      await assert.doesNotReject(() => Promise.resolve(adapter.execute(example)), example);
    }
    await adapter.execute(`search ${grammar.noun} for "orgiq-search"`);
    assert.equal(state.query, 'orgiq-search');
    for (const [phrase, value] of Object.entries(grammar.filters ?? {})) {
      await adapter.execute(`show ${phrase} ${grammar.noun}`);
      assert.equal(state.filter, value);
    }
    const before = state.refreshes;
    await adapter.execute('refresh');
    assert.equal(state.refreshes, before + 1);
    await adapter.execute('reset filters');
    assert.equal(state.query, '');
    if (grammar.filters) assert.equal(state.filter, '');
    for (const phrase of grammar.extra ?? []) {
      await adapter.execute(phrase);
      assert.equal(state.extra, phrase);
    }
  });

  test(`${collection}: unsupported and destructive phrases change nothing`, async () => {
    const { state, adapter } = harness(collection);
    const snapshot = { ...state };
    for (const phrase of [
      'approve all', 'reject tx-001', 'approve tx-001', 'delete all sessions', 'run the harness',
      'cancel run inv-1', 'grant admin to u-eli', 'expire memory', 'disable the guardrail', 'open all',
      'open selected rows', 'show everything from last week', 'summarize these', '',
    ]) {
      await assert.rejects(() => Promise.resolve(adapter.execute(phrase)), phrase);
    }
    assert.deepEqual(state, snapshot);
  });
}

test('agents, approvals, sessions and model compare offer no filter; a filter phrase is refused', async () => {
  for (const collection of ['agents', 'approvals', 'sessions', 'modelCompare'] as const) {
    const { state, adapter } = harness(collection);
    await assert.rejects(() => Promise.resolve(adapter.execute('show failing tools')));
    assert.equal(state.filter, 'f');
  }
});

test('open resolves exact IDs or titles on the current rows only', () => {
  const runs = [{ id: 'inv-Abc' }, { id: 'inv-def' }].map(invocationTarget);
  assert.equal(resolveCollectionTarget('inv-Abc', runs).id, 'inv-Abc');
  assert.throws(() => resolveCollectionTarget('inv-abc', [runs[1]]), /No matching/);
  assert.throws(() => resolveCollectionTarget('inv', runs), /No matching/);

  const sessions = [
    { sessionId: 's-1', title: 'Who knows auth?' },
    { sessionId: 's-2', title: 'Who knows auth?' },
    { sessionId: 's-3' },
  ].map(sessionTarget);
  assert.equal(resolveCollectionTarget('s-3', sessions).id, 's-3');
  assert.throws(() => resolveCollectionTarget('who knows auth?', sessions), /multiple/);
  assert.equal(resolveCollectionTarget('who knows AUTH?', sessions.slice(1)).id, 's-2');

  const approvals = [{ approvalId: 'ap-1', txId: 'tx-001' }, { approvalId: 'ap-2', txId: 'tx-002' }].map(approvalTarget);
  assert.equal(resolveCollectionTarget('TX-002', approvals).id, 'ap-2');
  assert.throws(() => resolveCollectionTarget('tx-00', approvals), /No matching/);

  const events = [{ memoryEventId: 'me-1' }].map(memoryEventTarget);
  assert.equal(resolveCollectionTarget('me-1', events).id, 'me-1');
  assert.throws(() => resolveCollectionTarget('me-1', []), /No matching/);

  const rules = [{ ruleName: 'PII.email' }, { ruleName: 'topic.violence' }].map(guardrailRuleTarget);
  assert.equal(resolveCollectionTarget('pii.EMAIL', rules).id, 'PII.email');
  assert.throws(() => resolveCollectionTarget('PII', rules), /No matching/);
});

test('matchesAny: case-insensitive substring, empty query matches, nullish fields ignored', () => {
  assert.equal(matchesAny('', null), true);
  assert.equal(matchesAny('  ', 'x'), true);
  assert.equal(matchesAny('SEARCH', 'orgiq-search'), true);
  assert.equal(matchesAny('scoring', 'orgiq-search', undefined, null), false);
});
