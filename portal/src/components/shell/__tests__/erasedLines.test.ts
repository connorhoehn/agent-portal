import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DELETED_RECORD_LINE, NOVA_USER_ID, oneErasedLine } from '../erasedLines.ts';

test('after an erase the chat reads the fixed line once, and people\'s messages stay', () => {
  const nova = (id: string) => ({ id, userId: NOVA_USER_ID, content: DELETED_RECORD_LINE });
  const person = (id: string, message: string) => ({ id, userId: 'u-nora', content: message });
  const out = oneErasedLine([nova('n1'), person('p1', 'hello'), nova('n2'), person('p2', DELETED_RECORD_LINE), nova('n3')]);
  assert.deepEqual(out.map((m) => m.id), ['p1', 'p2', 'n3']);
  assert.deepEqual(oneErasedLine(out).map((m) => m.id), ['p1', 'p2', 'n3']);
  const plain = [person('p1', 'hi'), { id: 'n1', userId: NOVA_USER_ID, content: 'Four.' }];
  assert.equal(oneErasedLine(plain), plain);
});
