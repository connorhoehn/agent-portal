import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canCreateFor, durationLabel, peopleLabel, summaryLine, transcriptSegments, minutesUrl, transcriptUrl, meetingHref } from '../meetingsModel.ts';

test('duration reads in minutes and hours', () => {
  assert.equal(durationLabel(0, 20_000), 'under a minute');
  assert.equal(durationLabel(0, 12 * 60_000), '12 min');
  assert.equal(durationLabel(0, 65 * 60_000), '1 h 5 min');
  assert.equal(durationLabel(0, 120 * 60_000), '2 h');
});

test('people read as a sentence and long rosters fold', () => {
  assert.equal(peopleLabel(['Vera']), 'Vera');
  assert.equal(peopleLabel(['Vera', 'Nora']), 'Vera and Nora');
  assert.equal(peopleLabel(['A', 'B', 'C']), 'A, B and C');
  assert.equal(peopleLabel(['A', 'B', 'C', 'D', 'E', 'F']), 'A, B, C and 3 more');
});

test('the summary line is the first sentence, cut when long', () => {
  assert.equal(summaryLine('Vera said: hello there. Nora said: hi.'), 'Vera said: hello there.');
  assert.ok(summaryLine('x'.repeat(300)).length <= 140);
});

test('segments name speakers from the roster and place lines without media offsets by clock time', () => {
  const roster = [{ userId: 'u-1', name: 'Vera Green' }];
  const seg = transcriptSegments([
    { seq: 1, userId: 'u-1', speakerName: 'u-1', text: 'hi', at: 5_000 },
    { seq: 2, userId: null, speakerName: 'Someone', text: 'yo', at: 6_000, startMs: 4000, endMs: 4500 },
  ], roster, 1_000);
  assert.deepEqual(seg[0], { startMs: 4000, endMs: 5000, speakerId: 'u-1', speakerLabel: 'Vera Green', text: 'hi' });
  assert.deepEqual(seg[1], { startMs: 4000, endMs: 4500, speakerLabel: 'Someone', text: 'yo' });
});

test('a work item can be created from an item that is the viewer\'s own or nobody\'s', () => {
  assert.equal(canCreateFor({ text: 'a' }, 'u-1'), true);
  assert.equal(canCreateFor({ text: 'a', ownerUserId: 'u-1' }, 'u-1'), true);
  assert.equal(canCreateFor({ text: 'a', ownerUserId: 'u-2' }, 'u-1'), false);
  assert.equal(canCreateFor({ text: 'a', ownerUserId: 'u-1', done: true }, 'u-1'), false);
});

test('urls are encoded', () => {
  assert.equal(minutesUrl('a/b'), '/api/calls/a%2Fb/assistant/minutes');
  assert.equal(transcriptUrl('c', 5, 100), '/api/calls/c/assistant/transcript?after=5&limit=100');
  assert.equal(meetingHref('c1'), '/iq/meetings/c1');
});
