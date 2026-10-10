import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeDiscussionChannel } from '../scopeDiscussionModel.ts';

test('the thread uses the presence channel; a focused work item wins', () => {
  assert.equal(scopeDiscussionChannel('p-soc2'), 'orgiq:initiative:p-soc2');
  assert.equal(scopeDiscussionChannel('p-soc2', 'w-9'), 'orgiq:work:w-9');
});
