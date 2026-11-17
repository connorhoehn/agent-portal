// Milo asks aloud in the room and the candidate's page (rows I3.5, I3.8; contract U9, U10): the pure parts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lastAskedOf, miloAskReceipt, onPadQuestion, queuePadQuestion, saidOf, sayPath, takePadQuestion } from '../interviewsRoom.ts';

test('said and line are read off an answer body, and nothing else', () => {
  assert.deepEqual(saidOf({ suggestion: null, said: 'spoken' }), { said: 'spoken' });
  assert.deepEqual(saidOf({ said: 'chat', line: 'Milo could not say it aloud. The question is in the call chat.' }), { said: 'chat', line: 'Milo could not say it aloud. The question is in the call chat.' });
  assert.deepEqual(saidOf({ said: 'loud', line: '  ' }), {});
  assert.deepEqual(saidOf(null), {});
});

test('the Have Milo ask receipt says what happened', () => {
  assert.equal(miloAskReceipt('spoken'), 'Milo asked it aloud');
  assert.equal(miloAskReceipt('chat'), 'In the call chat only');
  assert.equal(miloAskReceipt(undefined), 'Sent to the call chat');
  assert.equal(sayPath('iv-1'), '/api/interviews/interviews/iv-1/say');
});

test('the candidate reads the last approved question from the chat frames, never an answer or a person', () => {
  const ch = 'orgiq:huddle:call-1';
  const q = (message: string, meta: Record<string, unknown>) => ({ id: message, userId: 'agent:milo', message, metadata: meta });
  const approved = { assistant: true, approvedQuestion: true };
  let cur = lastAskedOf({ type: 'chat', action: 'history', channel: ch, messages: [q('First?', approved), q('Second?', approved), q('About 5 minutes are left.', { ...approved, approvedAnswer: true })] }, ch, null);
  assert.equal(cur, 'Second?');
  cur = lastAskedOf({ type: 'chat', action: 'message', channel: ch, message: q('A person typed this', { approvedQuestion: true }) }, ch, cur);
  assert.equal(cur, 'Second?');
  cur = lastAskedOf({ type: 'chat', action: 'message', channel: 'orgiq:huddle:other', message: q('Elsewhere?', approved) }, ch, cur);
  assert.equal(cur, 'Second?');
  cur = lastAskedOf({ type: 'assistant-audio', channel: ch, data: {} }, ch, cur);
  assert.equal(cur, 'Second?');
  assert.equal(lastAskedOf({ type: 'chat', action: 'message', channel: ch, message: q('Third?', approved) }, ch, cur), 'Third?');
});

test('a question queued for the pad is taken once, and its listeners are told', () => {
  let told = 0;
  const off = onPadQuestion(() => { told += 1; });
  queuePadQuestion('iv-1', { id: 'q-1', prompt: 'Reverse a list.', starter: [] });
  assert.equal(told, 1);
  assert.equal(takePadQuestion('iv-2'), null);
  assert.equal(takePadQuestion('iv-1')?.id, 'q-1');
  assert.equal(takePadQuestion('iv-1'), null);
  off();
  queuePadQuestion('iv-1', { id: 'q-2', prompt: 'x', starter: [] });
  assert.equal(told, 1);
});
