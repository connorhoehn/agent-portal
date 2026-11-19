// A board question's answer key on the interviewers' side (lib/interviewsAnswerKey.ts): the room's "Provided design"
// tab, the lead's reveal, and the scorecard's red-flag checklist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RED_FLAG_GROUP_LABELS, answerKeyQuestions, onBoardReveal, placeBeside, queueBoardReveal, takeBoardReveal, wasRevealed, redFlagGroups, revealPath, revealProvidedDesign, seenFlagsOf, toggleSeenFlag,
} from '../interviewsAnswerKey.ts';
import { roomTabOf, roomTabs } from '../interviewsRoom.ts';
import * as server from '../../../../middleware/src/lib/interviews/types.ts';
import { TWITTER_RED_FLAGS } from '../../../../middleware/src/mock/interviews-design-twitter.ts';

const key = { providedDesign: { name: 'Provided design', elements: [{ id: 'pd-a', type: 'rectangle', x: 0, y: 10, width: 100, height: 50 }] }, redFlags: TWITTER_RED_FLAGS };

test('a board round with an answer key gets a "Provided design" tab after the board; a pad round, or none, does not', () => {
  assert.deepEqual(roomTabs('technical', 'board', true).map((t) => t.label), ['Board', 'Provided design', 'Questions', 'Milo', 'Chat']);
  assert.deepEqual(roomTabs('technical', 'board').map((t) => t.label), ['Board', 'Questions', 'Milo', 'Chat']);
  assert.deepEqual(roomTabs('technical', 'pad', true).map((t) => t.label), ['Pad', 'Questions', 'Milo', 'Chat']);
  assert.equal(roomTabOf('technical', 'design', 'pad', true), 'design');
  assert.equal(roomTabOf('technical', 'design', 'pad'), 'pad');
  const qs = [{ id: 'q1' }, { id: 'q2', answerKey: key }, { id: 'q3', answerKey: {} }];
  assert.deepEqual(answerKeyQuestions(qs).map((q) => q.id), ['q2']);
});

test('red flags are grouped in the server\'s group order, each group labelled, empty groups left out', () => {
  assert.deepEqual(Object.keys(RED_FLAG_GROUP_LABELS), [...server.RED_FLAG_GROUPS]);
  const groups = redFlagGroups(TWITTER_RED_FLAGS);
  assert.deepEqual(groups.map((g) => g.group), [...new Set(TWITTER_RED_FLAGS.map((f) => f.group))].sort((a, b) => server.RED_FLAG_GROUPS.indexOf(a) - server.RED_FLAG_GROUPS.indexOf(b)));
  assert.equal(groups.reduce((n, g) => n + g.items.length, 0), TWITTER_RED_FLAGS.length);
  assert.equal(groups[0]!.label, 'Over-engineering');
  assert.deepEqual(redFlagGroups(undefined), []);
});

test('the revealed design goes right of what is on the board, top-aligned, and an empty board takes it where it is', () => {
  const on = [{ id: 'mt-a-title', x: -20, y: 40, width: 600, height: 60 }, { id: 'mt-b', x: 700, y: 0, width: 1700, height: 900 }];
  const placed = placeBeside(on, key.providedDesign);
  assert.equal(placed.elements[0]!['x'], 2400 + 160);
  assert.equal(placed.elements[0]!['y'], 0);
  assert.equal(key.providedDesign.elements[0]!['x'], 0, 'the kit\'s copy is untouched');
  assert.deepEqual(placeBeside([], key.providedDesign).elements[0], key.providedDesign.elements[0]);
});

test('the reveal posts the question to the round\'s route and hands back the board; a refusal is null', async () => {
  assert.equal(revealPath('iv-1'), '/api/interviews/interviews/iv-1/board/reveal');
  const calls: Array<{ url: string; body: unknown }> = [];
  const ok = (async (url: string, init: RequestInit) => { calls.push({ url, body: JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ board: key.providedDesign }), { status: 200 }); }) as unknown as typeof fetch;
  assert.deepEqual(await revealProvidedDesign('iv-1', 'q2', ok), key.providedDesign);
  assert.deepEqual(calls[0]!.body, { questionId: 'q2' });
  assert.equal(await revealProvidedDesign('iv-1', 'q2', (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch), null);
});

test('the scorecard\'s seen red flags: a toggle adds or removes one, kept in the question\'s flag order, unknown ones dropped', () => {
  const flags = TWITTER_RED_FLAGS.map((f) => f.text);
  let seen = toggleSeenFlag([], flags[2]!, flags);
  seen = toggleSeenFlag(seen, flags[0]!, flags);
  assert.deepEqual(seen, [flags[0], flags[2]]);
  assert.deepEqual(toggleSeenFlag(seen, flags[0]!, flags), [flags[2]]);
  assert.deepEqual(seenFlagsOf(['nope', flags[1]!], flags), [flags[1]]);
  assert.deepEqual(seenFlagsOf(undefined, flags), []);
});

test('a revealed design waits for the lead\'s board once: taking it clears it, a listener hears it, it counts as revealed', () => {
  const heard: number[] = [];
  const off = onBoardReveal(() => heard.push(1));
  assert.equal(wasRevealed('iv-9', 'q2'), false);
  queueBoardReveal('iv-9', 'q2', key.providedDesign);
  assert.equal(heard.length, 1);
  assert.equal(wasRevealed('iv-9', 'q2'), true);
  assert.deepEqual(takeBoardReveal('iv-9'), key.providedDesign);
  assert.equal(takeBoardReveal('iv-9'), null);
  off();
});
