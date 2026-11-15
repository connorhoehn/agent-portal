import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ASSISTANT_USER_ID, DELETED_RECORD_LINE, LEGACY_DELETED_RECORD_LINES, oneErasedLine } from '../erasedLines.ts';

test('after an erase the chat reads the fixed line once, and people\'s messages stay', () => {
  assert.equal(DELETED_RECORD_LINE, 'This record was deleted by the person who invited Milo.');
  const mine = (id: string) => ({ id, userId: ASSISTANT_USER_ID, content: DELETED_RECORD_LINE });
  const person = (id: string, message: string) => ({ id, userId: 'u-nora', content: message });
  const out = oneErasedLine([mine('n1'), person('p1', 'hello'), mine('n2'), person('p2', DELETED_RECORD_LINE), mine('n3')]);
  assert.deepEqual(out.map((m) => m.id), ['p1', 'p2', 'n3']);
  assert.deepEqual(oneErasedLine(out).map((m) => m.id), ['p1', 'p2', 'n3']);
  const plain = [person('p1', 'hi'), { id: 'n1', userId: ASSISTANT_USER_ID, content: 'Four.' }];
  assert.equal(oneErasedLine(plain), plain);
});

test('messages stored before the rename, under the earlier author id and with the earlier line, are kept once too', () => {
  const old = (id: string) => ({ id, userId: 'agent:nova', content: LEGACY_DELETED_RECORD_LINES[0]! });
  const out = oneErasedLine([old('o1'), { id: 'p1', userId: 'u-nora', content: 'hello' }, old('o2')]);
  assert.deepEqual(out.map((m) => m.id), ['p1', 'o2']);
});
