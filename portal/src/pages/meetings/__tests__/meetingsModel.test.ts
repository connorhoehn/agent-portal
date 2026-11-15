import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canCreateFor, durationLabel, peopleLabel, summaryLine, transcriptSegments, minutesUrl, transcriptUrl, meetingHref, proposalsLive, proposalsUrl,
  coverageItems, goneCopy, keptLine, meetingsUrl, mergeMeetings, minutesWritten, rewriteUrl, waitingLabel, MINUTES_UNAVAILABLE, type MeetingListRow } from '../meetingsModel.ts';

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

test('the meeting page asks for proposals again only while an answer or a run can change one', () => {
  assert.equal(proposalsUrl('c/1'), '/api/calls/c%2F1/assistant/proposals');
  for (const live of ['open', 'objected', 'consented', 'running']) assert.equal(proposalsLive(['done', live]), true);
  assert.equal(proposalsLive(['done', 'failed', 'dismissed', 'expired']), false);
  assert.equal(proposalsLive([]), false);
});

test('what Nova covered reads as its listening time, a pause only when there was one, and a count of people not transcribed', () => {
  assert.deepEqual(coverageItems({ listenedSeconds: 600, pausedSeconds: 30, untranscribed: 0 }), ['Nova listened for 10 min']);
  assert.deepEqual(coverageItems({ listenedSeconds: 600, pausedSeconds: 300, untranscribed: 1 }), ['Nova listened for 10 min', 'paused for 5 min', '1 person was not transcribed']);
  assert.deepEqual(coverageItems({ listenedSeconds: 3900, pausedSeconds: 0, untranscribed: 2 }), ['Nova listened for 1 h 5 min', '2 people were not transcribed']);
  assert.deepEqual(coverageItems(undefined), []);
});

test('the page says how long the meeting is kept and who can delete it sooner', () => {
  const at = Date.UTC(2026, 11, 14, 12);
  assert.equal(keptLine({ keptUntil: at, invitedByName: 'Vera Green', youAreInviter: false }), 'Kept until 14 Dec 2026. Vera Green can delete it sooner.');
  assert.equal(keptLine({ keptUntil: at, invitedByName: 'Vera Green', youAreInviter: true }), 'Kept until 14 Dec 2026. You can delete it sooner.');
  assert.equal(keptLine({ invitedByName: 'Vera Green', youAreInviter: false }), null);
});

test('a gone meeting is explained only to the people the server told; everyone else reads the neutral sentence', () => {
  assert.equal(goneCopy({ status: 410, code: 'MEETING_DELETED' }).description, 'This meeting\'s record was deleted.');
  assert.equal(goneCopy({ status: 410, code: 'MEETING_EXPIRED' }).description, 'This meeting\'s record was removed after the retention period.');
  assert.equal(goneCopy({ status: 404, code: null }).description, 'There is no meeting record here. It may have been deleted, removed after the retention period, or you were not in that call.');
  assert.equal(goneCopy({ status: 404, code: 'MINUTES_WRITING' }).writing, true);
});

test('unwritten minutes never read as "nothing was decided"', () => {
  assert.equal(minutesWritten({ writer: 'none' }), false);
  assert.equal(minutesWritten({ writer: 'scripted' }), true);
  assert.equal(MINUTES_UNAVAILABLE, 'Not available because the minutes could not be written.');
});

test('the list pages by the server cursor and merges pages once each; the waiting pill counts only when something waits', () => {
  assert.equal(meetingsUrl(), '/api/meetings?limit=50');
  assert.equal(meetingsUrl(1234), '/api/meetings?limit=50&before=1234');
  assert.equal(rewriteUrl('c 1'), '/api/calls/c%201/assistant/minutes/rewrite');
  const row = (callId: string) => ({ callId }) as MeetingListRow;
  assert.deepEqual(mergeMeetings([row('a'), row('b')], [row('b'), row('c')]).map((r) => r.callId), ['a', 'b', 'c']);
  assert.equal(waitingLabel(0), null);
  assert.equal(waitingLabel(undefined), null);
  assert.equal(waitingLabel(2), '2 waiting on you');
});
