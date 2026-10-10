// Run with: cd portal && node --test 'src/components/decks/__tests__/*.test.ts'
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DECK_WRITE_ACTION, canWriteDecks } from '../deckApi.ts';
import { deckRefreshAction, deckSaveState, headRevisionId, keptLockedIds } from '../deckDocumentModel.ts';

test('saved collaboration advances only a clean editor of the previous head', () => {
  assert.equal(deckRefreshAction('r1', 'r1', 'r2', false), 'advance');
  assert.equal(deckRefreshAction('r1', 'r1', 'r2', true), 'conflict');
  assert.equal(deckRefreshAction('r0', 'r1', 'r2', false), 'stay');
  assert.equal(deckRefreshAction('r1', 'r1', 'r1', true), 'stay');
  assert.equal(deckRefreshAction(null, 'r1', 'r2', false), 'stay');
});

test('keptLockedIds drops locks whose slide is gone', () => {
  assert.deepEqual(keptLockedIds(['a', 'b'], [{ id: 'b' }, { id: 'c' }]), ['b']);
  assert.deepEqual(keptLockedIds(undefined, [{ id: 'a' }]), []);
});

test('headRevisionId prefers the active revision, then the newest', () => {
  assert.equal(headRevisionId(null), null);
  assert.equal(headRevisionId({ activeRevisionId: 'r2', revisions: [{ id: 'r3' }] }), 'r2');
  assert.equal(headRevisionId({ activeRevisionId: null, revisions: [{ id: 'r3' }] }), 'r3');
  assert.equal(headRevisionId({ activeRevisionId: null, revisions: [] }), null);
});

test('deckSaveState reports pending, saved, or nothing', () => {
  assert.equal(deckSaveState(false, true, 'v2', undefined), undefined);
  assert.deepEqual(deckSaveState(true, true, 'v2', undefined), { status: 'pending', detail: 'Unsaved changes. Save as v2 to keep them' });
  assert.deepEqual(deckSaveState(true, false, 'v2', { label: 'v1' }), { status: 'saved', detail: 'Saved as v1' });
  assert.equal(deckSaveState(true, false, 'v2', undefined), undefined);
});

test('the deck write rule: one action per tenant, the same the server asks', () => {
  assert.deepEqual({ ...DECK_WRITE_ACTION }, { assessment: 'RunAssessmentAgent', pipelines: 'RunPipeline', orgiq: 'DispatchAgentRun', social: 'PostMessage' });
  assert.equal(canWriteDecks('pipelines', ((a: string) => a === 'RunPipeline') as never), true);
  assert.equal(canWriteDecks('orgiq', ((a: string) => a === 'RunPipeline') as never), false);
});
