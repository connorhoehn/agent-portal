import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleHuddleDraft } from '../huddleDraft.ts';
const empty = { html: '', files: [] };
const submitted = { html: '<p>Confirm the dependency map</p>', files: [] };
test('a receipt after navigation settles the shared submitted draft', () => {
  assert.equal(settleHuddleDraft(submitted, submitted, true, empty), empty);
  assert.equal(settleHuddleDraft(empty, submitted, false, empty), submitted);
});
test('late success or failure never replaces a newer message or staged file', () => {
  for (const next of [{ html: '<p>Next question</p>', files: [] }, { html: '', files: [{ name: 'review.txt' }] }]) {
    assert.equal(settleHuddleDraft(next, submitted, true, empty), next);
    assert.equal(settleHuddleDraft(next, submitted, false, empty), next);
  }
});
