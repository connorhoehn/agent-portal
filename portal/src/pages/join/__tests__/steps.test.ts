// The candidate's step model (pages/join/steps.ts; docs/interviews-tenant-plan.md row I2.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTHING_ANSWERED, allAnswered, choose, landingStep, miloLocked, stepAfterConsents, waitingView, type Admission, type ConsentChoices } from '../steps.ts';

const ALL: ConsentChoices = { recording: true, transcription: true, milo: true };
const adm = (state: Admission['state']): Admission => ({ state, knockedAt: null, decidedAt: null });

test('a guest with nothing answered starts at the landing, whatever the admission says short of admitted', () => {
  assert.equal(landingStep(NOTHING_ANSWERED, null), 'landing');
  assert.equal(landingStep({ ...ALL, milo: null }, adm('not-knocked')), 'landing');
  assert.equal(landingStep(NOTHING_ANSWERED, adm('waiting')), 'landing');
  assert.equal(landingStep(NOTHING_ANSWERED, adm('turned-away')), 'landing');
});

test('answered but not knocked goes to the device check; knocked goes back to waiting; admitted to the call', () => {
  assert.equal(landingStep(ALL, null), 'devices');
  assert.equal(landingStep({ recording: false, transcription: false, milo: false }, adm('not-knocked')), 'devices');
  assert.equal(landingStep(ALL, adm('waiting')), 'waiting');
  assert.equal(landingStep(ALL, adm('turned-away')), 'waiting');
  assert.equal(landingStep(ALL, adm('admitted')), 'admitted');
  assert.equal(landingStep(NOTHING_ANSWERED, adm('admitted')), 'admitted');
});

test('three answers are needed, and false counts as an answer', () => {
  assert.equal(allAnswered(NOTHING_ANSWERED), false);
  assert.equal(allAnswered({ recording: false, transcription: false, milo: false }), true);
  assert.equal(allAnswered({ recording: true, transcription: true, milo: null }), false);
});

test('declining the transcript declines Milo and locks it; turning it back on asks about Milo again, never yes', () => {
  let a = choose(NOTHING_ANSWERED, 'milo', true);
  a = choose(a, 'transcription', false);
  assert.deepEqual(a, { recording: null, transcription: false, milo: false });
  assert.equal(miloLocked(a), true);
  assert.deepEqual(choose(a, 'milo', true), a);
  a = choose(a, 'transcription', true);
  assert.deepEqual(a, { recording: null, transcription: true, milo: null });
  assert.equal(miloLocked(a), false);
  assert.deepEqual(choose(ALL, 'transcription', true), ALL);
});

test('after the consents the device check runs once per visit', () => {
  assert.equal(stepAfterConsents(false), 'devices');
  assert.equal(stepAfterConsents(true), 'waiting');
});

test('a missing admission is still waiting, never an error', () => {
  assert.equal(waitingView(null), 'waiting');
  assert.equal(waitingView(adm('not-knocked')), 'waiting');
  assert.equal(waitingView(adm('waiting')), 'waiting');
  assert.equal(waitingView(adm('turned-away')), 'turned-away');
  assert.equal(waitingView(adm('admitted')), 'admitted');
});

// ── The room (row I2.4, the candidate's side; contract D1) ──
import { ROOM_POLL_MS, roomMaxPolls, roomStepAfterRead, roomView, type GuestRoom } from '../steps.ts';

const ROOM: GuestRoom = {
  interviewId: 'iv-1', lobbyName: 'interviews:interview:iv-1', self: { userId: 'guest:inv-1', displayName: 'Candidate' },
  round: { name: 'System design', type: 'technical', minutes: 60 }, scheduledAt: null, startedAt: null, state: 'open',
};

test('a read of the room: open stays in the room; ended or not-found opens the ended page; a failed read changes nothing', () => {
  assert.equal(roomStepAfterRead({ kind: 'room', room: ROOM }), 'admitted');
  assert.equal(roomStepAfterRead({ kind: 'room', room: { ...ROOM, state: 'ended' } }), 'ended');
  assert.equal(roomStepAfterRead({ kind: 'gone' }), 'ended');
  assert.equal(roomStepAfterRead({ kind: 'failed' }), null);
});

test('the room asks every few seconds for the round\'s length and an hour more, and no longer', () => {
  assert.equal(roomMaxPolls(60) * ROOM_POLL_MS, 120 * 60_000);
  assert.equal(roomMaxPolls(45) * ROOM_POLL_MS, 105 * 60_000);
  assert.equal(roomMaxPolls(0), roomMaxPolls(60));
  assert.equal(roomMaxPolls(Number.NaN), roomMaxPolls(60));
});

test('what the room shows: a plain line when the call cannot open here; join, the call, then rejoin after Leave', () => {
  assert.equal(roomView({ token: 'off', joined: false, left: false }), 'unavailable');
  assert.equal(roomView({ token: 'off', joined: true, left: true }), 'unavailable');
  assert.equal(roomView({ token: 'loading', joined: false, left: false }), 'loading');
  assert.equal(roomView({ token: 'ready', joined: false, left: false }), 'join');
  assert.equal(roomView({ token: 'ready', joined: true, left: false }), 'call');
  assert.equal(roomView({ token: 'ready', joined: false, left: true }), 'rejoin');
});
