import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_POLL_LISTENING_MS, LIVE_POLL_PAUSED_MS, LIVE_READS_START, LIVE_TAIL, liveAfterUrl, livePlan, liveSegments, liveStateWords, liveTailUrl, mergeLines, mergeSpeakers,
  newestSeq, oldestSeq, readEnded, readStarted, readToStart, readsAtPhase, type LiveLine, type LiveReads,
} from '../liveTranscriptModel.ts';
import { liveTranscriptOn, setLiveTranscript } from '../liveTranscript.ts';

const line = (seq: number, over: Partial<LiveLine> = {}): LiveLine => ({ seq, userId: 'u1', speakerName: 'Ada', text: `line ${seq}`, at: 1_000 + seq * 1000, ...over });

test('nothing is fetched while the view is off, whatever Nova is doing', () => {
  for (const phase of ['loading', 'none', 'invited', 'listening', 'paused', 'left'] as const) assert.deepEqual(livePlan(false, phase, false), { kind: 'idle' });
});

test('the view polls every 2 s while Nova listens, every 5 s while paused, reads once more after Nova leaves, then stops', () => {
  assert.deepEqual(livePlan(true, 'listening', false), { kind: 'poll', everyMs: LIVE_POLL_LISTENING_MS });
  assert.equal(LIVE_POLL_LISTENING_MS, 2000);
  assert.deepEqual(livePlan(true, 'invited', false), { kind: 'poll', everyMs: 2000 });
  assert.deepEqual(livePlan(true, 'paused', false), { kind: 'poll', everyMs: LIVE_POLL_PAUSED_MS });
  assert.equal(LIVE_POLL_PAUSED_MS, 5000);
  assert.deepEqual(livePlan(true, 'left', false), { kind: 'final' });
  assert.deepEqual(livePlan(true, 'left', true), { kind: 'done' });
  assert.deepEqual(livePlan(true, 'none', false), { kind: 'done' });
});

test('the first read is the newest lines; earlier pages and polls page from what is held', () => {
  assert.equal(liveTailUrl('call 1'), `/api/calls/call%201/assistant/transcript?tail=${LIVE_TAIL}`);
  assert.equal(liveTailUrl('c', 41), `/api/calls/c/assistant/transcript?tail=${LIVE_TAIL}&before=41`);
  assert.equal(liveAfterUrl('c', 140), '/api/calls/c/assistant/transcript?after=140&limit=500');
  const held = [line(41), line(42), line(43)];
  assert.equal(newestSeq(held), 43); assert.equal(oldestSeq(held), 41);
  assert.equal(newestSeq([], 7), 7); assert.equal(oldestSeq([]), null);
});

test('merging keeps lines oldest first and each seq once (overlapping polls, an earlier page prepended)', () => {
  const held = [line(3), line(4)];
  assert.deepEqual(mergeLines(held, [line(4), line(5)]).map((l) => l.seq), [3, 4, 5]);
  assert.deepEqual(mergeLines(held, [line(1), line(2)]).map((l) => l.seq), [1, 2, 3, 4]);
  assert.equal(mergeLines(held, []), held);
});

test('rows name the speaker with the portrait the answer carried; an unattributed line reads as the meeting page reads it', () => {
  const speakers = mergeSpeakers(new Map(), [{ userId: 'u1', name: 'Ada Park', avatarUrl: 'https://x/ada.png' }]);
  const rows = liveSegments([line(1), line(2, { userId: null, speakerName: '' }), line(3, { userId: 'u9', speakerName: 'Sam' })], speakers, 1_000);
  assert.deepEqual(rows.map((r) => [r.id, r.speakerLabel, r.speakerAvatarUrl]), [['1', 'Ada Park', 'https://x/ada.png'], ['2', 'Unknown', null], ['3', 'Sam', null]]);
  assert.equal(rows[0]!.startMs, 1000);
  assert.equal('speakerId' in rows[1]!, false);
});

test('the state after "Live transcript"', () => {
  assert.equal(liveStateWords('listening'), 'Nova is listening');
  assert.equal(liveStateWords('paused'), 'Nova is paused, nothing is being transcribed');
  assert.equal(liveStateWords('left'), 'Nova has left; this is what it heard');
});

test('the view is on for one call at a time and turns off per call', () => {
  setLiveTranscript('c1', true);
  assert.equal(liveTranscriptOn('c1'), true); assert.equal(liveTranscriptOn('c2'), false); assert.equal(liveTranscriptOn(null), false);
  setLiveTranscript('c2', false);
  assert.equal(liveTranscriptOn('c1'), true);
  setLiveTranscript('c1', false);
  assert.equal(liveTranscriptOn('c1'), false);
});

test('Nova invited back and leaving again: the new period forgets the last final read, so the second leave reads once more', () => {
  let r: LiveReads = readsAtPhase(LIVE_READS_START, 'listening');
  r = readsAtPhase(r, 'left');
  assert.equal(readToStart(r, false), 'final');
  r = readEnded(readStarted(r, 'final'));
  assert.equal(r.final, 'done');
  assert.equal(readToStart(r, true), null); // nothing more while Nova is away
  r = readsAtPhase(r, 'invited'); // a second listening period
  assert.equal(r.final, 'none');
  assert.equal(readToStart(r, true), 'poll');
  r = readsAtPhase(readsAtPhase(r, 'listening'), 'paused');
  assert.equal(r.final, 'none');
  r = readsAtPhase(readsAtPhase(r, 'listening'), 'left');
  assert.equal(readToStart(r, false), 'final'); // the second leave is read too
  r = readEnded(readStarted(r, 'final'));
  assert.equal(r.final, 'done');
  assert.equal(livePlan(true, 'left', r.final === 'done').kind, 'done');
});

test('a poll in flight as Nova leaves: the final read waits for it, then is made (that poll may predate her last lines)', () => {
  let r: LiveReads = readsAtPhase(LIVE_READS_START, 'listening');
  assert.equal(readToStart(r, true), 'poll');
  r = readStarted(r, 'poll');
  r = readsAtPhase(r, 'left');
  assert.equal(r.final, 'owed');
  assert.equal(readToStart(r, false), null); // one read at a time: wait for the poll
  r = readEnded(r);
  assert.equal(r.final, 'owed'); // the poll that came back was not the final read
  assert.equal(readToStart(r, false), 'final');
  r = readEnded(readStarted(r, 'final'));
  assert.equal(r.final, 'done');
});

test('a final read still out when Nova is invited back again counts as a poll: the next leave is still read', () => {
  let r: LiveReads = readsAtPhase(readsAtPhase(LIVE_READS_START, 'listening'), 'left');
  r = readStarted(r, 'final');
  r = readsAtPhase(r, 'listening');
  r = readsAtPhase(r, 'left');
  r = readEnded(r);
  assert.equal(r.final, 'owed');
  assert.equal(readToStart(r, false), 'final');
});

