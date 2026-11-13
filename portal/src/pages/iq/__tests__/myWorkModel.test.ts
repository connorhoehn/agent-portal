import { test } from 'node:test';
import assert from 'node:assert/strict';

import { myWorkEmptyMessage } from '../myWorkModel.ts';

test('the empty message names a missing person link only when the session says unlinked', () => {
  assert.match(myWorkEmptyMessage(false, false), /not linked to a person/);
  assert.equal(myWorkEmptyMessage(false, true), 'Nothing is assigned to you right now.');
  assert.equal(myWorkEmptyMessage(false, null), 'Nothing is assigned to you right now.');
  assert.equal(myWorkEmptyMessage(true, false), 'No open work item matches these filters.');
});
