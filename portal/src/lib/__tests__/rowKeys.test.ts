// Stable keys for an editable list of plain strings (lib/rowKeys.ts): removing a row keeps every other row's key, so React
// keeps each input with its own text (the kit editor's clarifying questions and follow-ups; review WB-1, minor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RowKeys } from '../rowKeys.ts';

test('a removed row takes its key with it; the rows after it keep theirs; an added row gets a new one', () => {
  const keys = new RowKeys();
  const three = keys.for(3);
  assert.equal(new Set(three).size, 3);
  keys.remove(1);
  assert.deepEqual(keys.for(2), [three[0], three[2]]);
  const four = keys.for(3);
  assert.deepEqual(four.slice(0, 2), [three[0], three[2]]);
  assert.ok(!three.includes(four[2]!));
});

test('a list that shrank or grew from outside (a reload) is trimmed or extended from the end', () => {
  const keys = new RowKeys();
  const five = keys.for(5);
  assert.deepEqual(keys.for(2), five.slice(0, 2));
  assert.equal(keys.for(4).length, 4);
});
