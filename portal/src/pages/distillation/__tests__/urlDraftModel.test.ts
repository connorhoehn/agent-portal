// Run with:  cd portal && node --test 'src/pages/distillation/__tests__/urlDraftModel.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adoptUrlValue, needsCommit } from '../urlDraftModel.ts';

test('adoptUrlValue: our own write arriving late never overwrites newer typing', () => {
  // Typed "zz", the box committed "zz", the person typed on to "zzz" before
  // the router delivered ?q=zz. Adopting it is how "zzznope" became "zzp".
  assert.deepEqual(adoptUrlValue({ text: 'zzz', pending: ['zz'] }, 'zz'), { text: 'zzz', pending: [] });
});

test('adoptUrlValue: two writes in flight are matched in order', () => {
  assert.deepEqual(adoptUrlValue({ text: 'ADOT', pending: ['AD', 'ADO'] }, 'AD'), { text: 'ADOT', pending: ['ADO'] });
  assert.deepEqual(adoptUrlValue({ text: 'ADOT', pending: ['ADO'] }, 'ADO'), { text: 'ADOT', pending: [] });
});

test('adoptUrlValue: a value the box already shows keeps its surrounding space', () => {
  assert.deepEqual(adoptUrlValue({ text: 'Aurora ', pending: [] }, 'Aurora'), { text: 'Aurora ', pending: [] });
});

test('adoptUrlValue: a change from outside the box (Back, Clear filters, a link) wins', () => {
  assert.deepEqual(adoptUrlValue({ text: 'ADOT', pending: [] }, ''), { text: '', pending: [] });
  assert.deepEqual(adoptUrlValue({ text: 'ADOT', pending: ['ADOT'] }, 'Fargate'), { text: 'Fargate', pending: [] });
});

test('needsCommit: only a change in the trimmed value is written to the URL', () => {
  assert.equal(needsCommit('ADOT', ''), true);
  assert.equal(needsCommit('ADOT ', 'ADOT'), false);
  assert.equal(needsCommit('', ''), false);
});
