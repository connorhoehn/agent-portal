// Milo asks aloud in the room and the candidate's page (rows I3.5, I3.8; contract U9, U10): the pure parts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMiloAnswerLine, lastAskedOf, miloAskReceipt, onPadQuestion, queuePadQuestion, saidOf, sayPath, takePadQuestion } from '../interviewsRoom.ts';

test('said and line are read off an answer body, and nothing else', () => {
  assert.deepEqual(saidOf({ suggestion: null, said: 'spoken' }), { said: 'spoken' });
  assert.deepEqual(saidOf({ said: 'chat', line: 'Milo could not say it aloud. The question is in the call chat.' }), { said: 'chat', line: 'Milo could not say it aloud. The question is in the call chat.' });
  assert.deepEqual(saidOf({ said: 'loud', line: '  ' }), {});
  assert.deepEqual(saidOf(null), {});
});

test('the Have Milo ask receipt says what happened, and why when not aloud', () => {
  assert.equal(miloAskReceipt('spoken'), 'Milo asked it aloud');
  assert.equal(miloAskReceipt('chat', 'voice-off'), 'Milo posted the question in the chat (Milo’s voice is off)');
  assert.equal(miloAskReceipt('chat', 'paused'), 'Milo posted the question in the chat (Milo is paused)');
  assert.equal(miloAskReceipt('chat', 'budget'), 'Milo posted the question in the chat (this interview’s budget does not cover Milo speaking)');
  assert.equal(miloAskReceipt('chat', 'not-heard'), 'Milo posted the question in the chat (Milo could not say it in time)');
  assert.equal(miloAskReceipt('chat', 'not-in-call'), 'Milo posted the question in the chat (Milo is not in the call)');
  assert.equal(miloAskReceipt('chat', 'not-said'), 'Milo posted the question in the chat (Milo could not say it aloud)');
  assert.equal(miloAskReceipt('chat'), 'Milo posted the question in the chat (Milo could not say it aloud)');
  assert.equal(miloAskReceipt('none', 'not-in-call'), 'Not sent: Milo is not in the call. Ask it yourself');
  assert.equal(miloAskReceipt('none', 'not-said'), 'Not sent: Milo could not post it. Ask it yourself');
  assert.equal(sayPath('iv-1'), '/api/interviews/interviews/iv-1/say');
});

test('the receipt never says the words are in the chat unless the server says it posted them', () => {
  for (const said of ['none', undefined] as const) {
    for (const why of [undefined, 'voice-off', 'budget', 'not-in-call', 'not-said'] as const) {
      const r = miloAskReceipt(said, why);
      assert.doesNotMatch(r, /Sent to the call chat|posted the question/, `${said}/${why}: ${r}`);
    }
  }
  assert.equal(miloAskReceipt(undefined), 'Milo did not say whether it was sent. Check the call chat');
});

test('why is read off the answer body only when it is one the server sends', () => {
  assert.deepEqual(saidOf({ suggestion: null, said: 'none', why: 'not-in-call' }), { said: 'none', why: 'not-in-call' });
  assert.deepEqual(saidOf({ said: 'chat', why: 'budget' }), { said: 'chat', why: 'budget' });
  assert.deepEqual(saidOf({ said: 'chat', why: 'gremlins' }), { said: 'chat' });
});

test('the candidate reads the last question Milo asked from the chat frames, never an answer or a person', () => {
  const ch = 'orgiq:huddle:call-1';
  // What a guest receives: Milo's approved lines as plain lines under its name, no assistant keys (contract E9).
  const q = (message: string, userId = 'agent:meeting-assistant') => ({ id: message, userId, message, metadata: { displayName: 'Milo' } });
  let cur = lastAskedOf({ type: 'chat', action: 'history', channel: ch, messages: [q('First?'), q('Second?'), q('About 5 minutes are left in this round.')] }, ch, null);
  assert.equal(cur, 'Second?');
  for (const answer of ['About 1 minute is left in this round.', 'This round is 45 minutes long.', 'This round is at the end of its time.', 'Milo has not asked a question yet.',
    'I can repeat the question or tell you how much time is left. Ask "Milo, repeat the question" or "Milo, how much time is left?"']) assert.equal(isMiloAnswerLine(answer), true, answer);
  assert.equal(isMiloAnswerLine('How long would the migration take?'), false);
  cur = lastAskedOf({ type: 'chat', action: 'message', channel: ch, message: q('A person typed this', 'u-hugo') }, ch, cur);
  assert.equal(cur, 'Second?');
  cur = lastAskedOf({ type: 'chat', action: 'message', channel: 'orgiq:huddle:other', message: q('Elsewhere?') }, ch, cur);
  assert.equal(cur, 'Second?');
  cur = lastAskedOf({ type: 'assistant-audio', channel: ch, data: {} }, ch, cur);
  assert.equal(cur, 'Second?');
  assert.equal(lastAskedOf({ type: 'chat', action: 'message', channel: ch, message: q('Third?') }, ch, cur), 'Third?');
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
