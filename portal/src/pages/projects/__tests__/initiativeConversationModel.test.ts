import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initiativeConversationMessages } from '../initiativeConversationModel.ts';

test('dialogue keeps contextual conversation while work comments stay available through All messages', () => {
  const messages = [
    { id: 'initiative', metadata: {} },
    { id: 'leaf-dialogue', metadata: { pageReference: { kind: 'work-item', id: 'wi-a' } } },
    { id: 'work-note', metadata: { workComment: true, pageReference: { kind: 'work-item', id: 'wi-a' } } },
  ];
  assert.deepEqual(initiativeConversationMessages(messages, 'dialogue').map(m => m.id), ['initiative', 'leaf-dialogue']);
  assert.deepEqual(initiativeConversationMessages(messages, 'initiative').map(m => m.id), ['initiative']);
  assert.deepEqual(initiativeConversationMessages(messages, 'all').map(m => m.id), messages.map(m => m.id));
  assert.equal(messages.length, 3);
});
