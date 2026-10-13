import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askScopeBody, encodeAskScope, parseAskScope } from '../askScope.ts';

test('a scope round-trips through the about= param', () => {
  for (const scope of [{ kind: 'initiatives' }, { kind: 'initiative', id: 'p-llm-platform' }, { kind: 'work', id: 'wi-obs-e2-b4' }] as const) {
    assert.deepEqual(parseAskScope(encodeAskScope(scope)), scope);
  }
});

test('an unrecognised about= is no scope, never a guess', () => {
  for (const raw of [null, '', 'everything', 'initiative:', 'person:p-001', 'work:has space']) assert.equal(parseAskScope(raw), null);
});

test('the invoke body gets scope + advise-only stance only when there is a scope', () => {
  assert.deepEqual(askScopeBody({ kind: 'initiatives' }), { scope: { kind: 'initiatives' }, stance: 'advise' });
  assert.deepEqual(askScopeBody(null), {});
});
