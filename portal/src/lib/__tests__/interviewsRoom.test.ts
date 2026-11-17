import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  codeBlockLanguage, consentOffLine, interviewLobbyName, interviewOfLobby, isInterviewLobby, knockPromptId, pollsWaiting, readAdmission,
  roomCallTitle, roomHref, roomStartMs, startsOnJoin, timeLeftLabel, timeLeftTone,
} from '../interviewsRoom.ts';

const MIN = 60_000;
const T0 = Date.parse('2026-11-16T14:00:00.000Z');

test('the lobby name is C1\'s, and only an interview\'s lobby reads as one', () => {
  assert.equal(interviewLobbyName('iv-1'), 'interviews:interview:iv-1');
  assert.equal(interviewOfLobby('interviews:interview:iv-1'), 'iv-1');
  for (const other of ['orgiq:initiative:p-1', 'social:room:abc', 'interviews:interview:iv-1~breakout~r1', 'assessment:team:TEAM-1', '', null, undefined]) {
    assert.equal(isInterviewLobby(other), false, String(other));
  }
  assert.equal(roomHref('iv 1'), '/interviews/rounds/iv%201/room');
});

test('time left is plain words from the start and the round\'s length', () => {
  assert.equal(timeLeftLabel(T0, 45, T0), '45 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 33 * MIN), '12 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 44.5 * MIN), '1 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 45 * MIN), '1 min left');
  assert.equal(timeLeftLabel(T0, 45, T0 + 48 * MIN + 10_000), 'Over by 3 min');
  assert.equal(timeLeftLabel(T0, 45, T0 - 5 * MIN), 'Starts in 5 min');
  assert.equal(timeLeftLabel(null, 45, T0), null);
  assert.equal(timeLeftLabel(T0, 0, T0), null);
  assert.equal(timeLeftTone('Over by 3 min'), 'warning');
  assert.equal(timeLeftTone('12 min left'), 'secondary');
});

test('time counts from the set time, else from when the call started', () => {
  assert.equal(roomStartMs('2026-11-16T14:00:00.000Z', T0 + 9 * MIN), T0);
  assert.equal(roomStartMs(null, T0 + 9 * MIN), T0 + 9 * MIN);
  assert.equal(roomStartMs(null, '2026-11-16T14:00:00.000Z'), T0);
  assert.equal(roomStartMs(null, null), null);
});

test('the lead\'s join starts an accepted or ready interview; nobody else\'s does', () => {
  assert.equal(startsOnJoin({ seat: 'lead', state: 'accepted' }), true);
  assert.equal(startsOnJoin({ seat: 'lead', state: 'ready' }), true);
  assert.equal(startsOnJoin({ seat: 'lead', state: 'live' }), false);
  assert.equal(startsOnJoin({ seat: 'panel', state: 'ready' }), false);
});

test('only the lead asks whether the candidate is waiting, and stops once they are in', () => {
  const waiting = { state: 'waiting' as const, knockedAt: 'k', decidedAt: null };
  assert.equal(pollsWaiting('lead', null, 'ready'), true);
  assert.equal(pollsWaiting('lead', waiting, 'live'), true);
  assert.equal(pollsWaiting('lead', { ...waiting, state: 'admitted' }, 'live'), false);
  assert.equal(pollsWaiting('panel', null, 'live'), false);
  assert.equal(pollsWaiting('lead', null, 'ended'), false);
  // A new knock is a new prompt.
  assert.notEqual(knockPromptId('iv-1', waiting), knockPromptId('iv-1', { ...waiting, knockedAt: 'k2' }));
});

test('a waiting route that is not there reads as nobody waiting', async () => {
  const notFound = (async () => new Response('{"error":"Not found"}', { status: 404 })) as typeof fetch;
  assert.equal(await readAdmission('iv-1', notFound), null);
  const broken = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.equal(await readAdmission('iv-1', broken), null);
  const knocked = (async () => new Response(JSON.stringify({ admission: { state: 'waiting', knockedAt: 'k', decidedAt: null } }))) as typeof fetch;
  assert.deepEqual(await readAdmission('iv-1', knocked), { state: 'waiting', knockedAt: 'k', decidedAt: null });
});

test('what the candidate turned off is one plain line; nothing off is no line', () => {
  assert.equal(consentOffLine(['recording']), 'Recording is off for this interview');
  assert.equal(consentOffLine(['recording', 'transcription']), 'Recording and transcription are off for this interview');
  assert.equal(consentOffLine(['transcription', 'recording', 'milo']), 'Transcription, recording and Milo are off for this interview');
  assert.equal(consentOffLine([]), null);
  assert.equal(consentOffLine(null), null);
});

test('the call\'s name and the code block\'s language', () => {
  assert.equal(roomCallTitle({ round: { id: 'r', name: 'Leadership', type: 'behavioural', minutes: 60 }, candidate: { name: 'Nadia' } }), 'Leadership with Nadia');
  assert.equal(codeBlockLanguage('typescript'), 'ts');
  assert.equal(codeBlockLanguage('javascript'), 'js');
  assert.equal(codeBlockLanguage('swift'), 'text');
});
