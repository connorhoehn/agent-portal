// The candidate's caption for what Milo says (guestMiloCaption.ts): which kind a line is, its label, the repeat, the echo, and when
// it clears.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTION_ECHO_MS, captionClearsAt, captionFromChat, captionFromRequest, captionHoldMs, captionKindLabel, replacesCaption,
} from '../guestMiloCaption.ts';

const Q = { text: 'How would you design a rate limiter?', asked: true };
const SAID = { text: "Hi, I'm Milo. I'm here to take notes for the panel.", asked: false };

test('a question Milo asked is a question, marked; anything Milo said (the intro, a confirmation) is said, unmarked', () => {
  const q = captionFromChat(Q, 1, 1000);
  assert.equal(q.kind, 'question');
  assert.equal(captionKindLabel(q.kind), 'Question');
  const s = captionFromChat(SAID, 2, 2000);
  assert.equal(s.kind, 'said');
  assert.equal(captionKindLabel(s.kind), null);
  assert.equal(s.source, 'chat');
});

test('a request answer is something said; "Repeat the question" answering with the question is the question again', () => {
  const time = captionFromRequest({ text: 'About 5 minutes are left in this round.', ok: true, at: 5000 }, Q, 3);
  assert.deepEqual([time.kind, time.source], ['said', 'request']);
  const repeat = captionFromRequest({ text: ` ${Q.text} `, ok: true, at: 6000 }, Q, 4);
  assert.deepEqual([repeat.kind, repeat.source, repeat.text], ['question', 'chat', Q.text]);
  // Before Milo asked anything, the fixed sentence is just said.
  assert.equal(captionFromRequest({ text: 'Milo has not asked a question yet.', ok: true, at: 7000 }, null, 5).kind, 'said');
  // The last line being something said is no question to repeat.
  assert.equal(captionFromRequest({ text: SAID.text, ok: true, at: 8000 }, SAID, 6).kind, 'said');
});

test('the next line replaces the caption, but the same words arriving again moments later do not re-show it', () => {
  const q = captionFromChat(Q, 1, 10_000);
  assert.equal(replacesCaption(null, q), true);
  assert.equal(replacesCaption(q, captionFromChat(SAID, 2, 11_000)), true);
  assert.equal(replacesCaption(q, captionFromChat(Q, 2, 12_000)), false, 'the repeat\'s chat echo');
  assert.equal(replacesCaption(q, captionFromChat(Q, 2, 10_000 + CAPTION_ECHO_MS)), true, 'asked again later');
  assert.equal(replacesCaption(q, captionFromChat({ ...Q, asked: false }, 2, 11_000)), true, 'same words, another kind');
});

test('a question stays long enough to answer; something said only long enough to read; a long line stays longer, within bounds', () => {
  assert.equal(captionHoldMs({ text: 'Done.', kind: 'said' }), 8_000);
  assert.equal(captionHoldMs({ text: 'Why?', kind: 'question' }), 25_000);
  const long = Array.from({ length: 40 }, () => 'word').join(' ');
  assert.equal(captionHoldMs({ text: long, kind: 'said' }), 18_000);
  assert.equal(captionHoldMs({ text: long, kind: 'question' }), 34_000);
  const huge = Array.from({ length: 400 }, () => 'word').join(' ');
  assert.equal(captionHoldMs({ text: huge, kind: 'said' }), 20_000);
  assert.equal(captionHoldMs({ text: huge, kind: 'question' }), 60_000);
});

test('the caption never clears while Milo is speaking, and its hold counts from when the voice stopped', () => {
  const s = captionFromChat({ text: 'Added a helper.', asked: false }, 1, 1_000);
  assert.equal(captionClearsAt(s, true, null), null);
  assert.equal(captionClearsAt(s, false, null), 1_000 + 8_000);
  assert.equal(captionClearsAt(s, false, 4_000), 4_000 + 8_000);
  // A stop from before this line arrived does not shorten it.
  assert.equal(captionClearsAt(s, false, 500), 1_000 + 8_000);
});
