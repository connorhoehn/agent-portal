import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callNoun } from '../callCopy.ts';

test('an interview lobby is a call', () => {
  assert.equal(callNoun('interviews:interview:iv-k1p5w8ra'), 'call');
});

test('every other lobby, and no lobby, stays a huddle', () => {
  assert.equal(callNoun('orgiq:initiative:p-1'), 'huddle');
  assert.equal(callNoun('interviews:interview:iv-1~room2'), 'huddle');
  assert.equal(callNoun(null), 'huddle');
  assert.equal(callNoun(undefined), 'huddle');
  assert.equal(callNoun(''), 'huddle');
});
