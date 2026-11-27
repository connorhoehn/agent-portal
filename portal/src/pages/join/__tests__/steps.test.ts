// The candidate's step model (pages/join/steps.ts; docs/interviews-tenant-plan.md row I2.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTHING_ANSWERED, allAnswered, choose, landingStep, miloLocked, stepAfterConsents, waitingAfterKnock, waitingAfterRead, waitingLine, waitingView, type Admission, type ConsentChoices } from '../steps.ts';

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

test('a lost call reads as lost, never as the candidate\'s own Leave, until the call is joined again', () => {
  assert.equal(roomView({ token: 'ready', joined: false, left: true, lost: true }), 'lost');
  // Still holding the dead call (the page leaves it at once): lost, not the call.
  assert.equal(roomView({ token: 'ready', joined: true, left: false, lost: true }), 'lost');
  assert.equal(roomView({ token: 'off', joined: false, left: true, lost: true }), 'unavailable');
  assert.equal(roomView({ token: 'ready', joined: true, left: false, lost: false }), 'call');
});

// ── Row I6.4: a part the deployment requires ─────────────────────────────────────────────────────────────────
import { REQUIRED_LINE, declinedRequired, heldLines, partsInWords } from '../steps.ts';

test('declinedRequired: only a real no to a required part; unanswered declines nothing; an older server sends none', () => {
  assert.deepEqual(declinedRequired({ ...ALL, recording: false }, ['recording']), ['recording']);
  assert.deepEqual(declinedRequired({ ...ALL, recording: false }, ['transcription']), []);
  assert.deepEqual(declinedRequired({ ...NOTHING_ANSWERED }, ['recording']), []);
  assert.deepEqual(declinedRequired({ ...ALL, recording: false }, undefined), []);
  assert.deepEqual(declinedRequired({ recording: true, transcription: false, milo: false }, ['transcription', 'milo']), ['transcription', 'milo']);
});

test('a declined required part lands on the held page, not the device check or the waiting room; admitted still wins', () => {
  const no = { ...ALL, recording: false };
  assert.equal(landingStep(no, null, ['recording']), 'held');
  assert.equal(landingStep(no, adm('waiting'), ['recording']), 'held');
  assert.equal(landingStep(no, adm('admitted'), ['recording']), 'admitted');
  assert.equal(landingStep(no, null, []), 'devices');
  assert.equal(landingStep(no, null), 'devices');
  assert.equal(stepAfterConsents(false, { answers: no, required: ['recording'] }), 'held');
  assert.equal(stepAfterConsents(true, { answers: no, required: ['recording'] }), 'held');
  assert.equal(stepAfterConsents(true, { answers: ALL, required: ['recording'] }), 'waiting');
  assert.equal(stepAfterConsents(false), 'devices');
});

test('the held page says the answer is saved, why the call cannot start, that the recruiter will be in touch, and that it can change', () => {
  assert.deepEqual(heldLines(['recording']), [
    'Your answers are saved.',
    'This interview is set up to need the recording, so it cannot start as it is set up now.',
    'The recruiter has been told and will be in touch with you.',
    'You can change your answers on this page until the interview starts.',
  ]);
  assert.equal(partsInWords(['transcription', 'milo']), 'the transcript and Milo');
  assert.equal(partsInWords(['recording', 'transcription', 'milo']), 'the recording, the transcript and Milo');
  assert.equal(heldLines([])[1], 'This interview cannot start as it is set up now.');
  for (const line of [...heldLines(['recording', 'milo']), REQUIRED_LINE]) assert.doesNotMatch(line, /must|minutes|seconds|deadline|refus|fail|you declined|INTERVIEWS_/i);
});

// ── UI round 2 (lane GUEST): the strip, who the candidate meets, where the bar counts from ─────────────────────
import { WALKED_STEPS, guestCallStartMs, meetingLine, walkedSteps } from '../steps.ts';

test('the strip names the four walked steps and marks the one the candidate is on', () => {
  assert.deepEqual(walkedSteps('landing').map((s) => s.label), [...WALKED_STEPS]);
  const marks = (step: Parameters<typeof walkedSteps>[0]) => walkedSteps(step).map((s) => (s.active ? 'a' : s.done ? 'd' : 't')).join('');
  assert.equal(marks('landing'), 'attt');
  assert.equal(marks('consents'), 'datt');
  assert.equal(marks('held'), 'datt');
  assert.equal(marks('devices'), 'ddat');
  assert.equal(marks('waiting'), 'ddda');
  assert.equal(marks('ended'), 'dddd');
  assert.deepEqual(walkedSteps('waiting').map((s) => s.step), [1, 2, 3, 4]);
});

test('the waiting page says who the candidate is meeting, by name and count only', () => {
  assert.equal(meetingLine({ lead: 'Hugo Marchetti', others: 0 }), 'You are meeting Hugo Marchetti.');
  assert.equal(meetingLine({ lead: 'Hugo Marchetti', others: 1 }), 'You are meeting Hugo Marchetti and one other interviewer.');
  assert.equal(meetingLine({ lead: 'Wen Zhao', others: 2 }), 'You are meeting Wen Zhao and 2 other interviewers.');
  assert.equal(meetingLine({ lead: null, others: 1 }), 'You are meeting your interviewer and one other interviewer.');
  assert.equal(meetingLine({ lead: '  ', others: -1 }), 'You are meeting your interviewer.');
  assert.equal(meetingLine(undefined), null);
});

test('the bar counts from the interview\'s start or the join, never from the set time', () => {
  const start = '2026-11-17T10:00:00.000Z';
  assert.equal(guestCallStartMs(start, 5), Date.parse(start));
  assert.equal(guestCallStartMs(null, 1234), 1234);
  assert.equal(guestCallStartMs('not a time', 1234), 1234);
  assert.equal(guestCallStartMs(null, null), null);
  assert.equal(guestCallStartMs(undefined, Number.NaN), null);
});

test('the waiting page says the interviewer was told only when the server holds the knock', () => {
  assert.deepEqual(waitingAfterKnock({ kind: 'knocked', admission: adm('waiting') }), { kind: 'wait', knocked: true });
  // A knock with no answer (network, 5xx) may not have landed: keep waiting and knock again on the next tick.
  assert.deepEqual(waitingAfterKnock({ kind: 'failed' }), { kind: 'wait', knocked: false });
  // A 200 that still reads not-knocked is not a knock the server holds.
  assert.deepEqual(waitingAfterKnock({ kind: 'knocked', admission: adm('not-knocked') }), { kind: 'wait', knocked: false });
});

test('a knock leaves the waiting page for admitted, turned away, held, answers needed and a dead link', () => {
  assert.deepEqual(waitingAfterKnock({ kind: 'knocked', admission: adm('admitted') }), { kind: 'admitted' });
  assert.deepEqual(waitingAfterKnock({ kind: 'knocked', admission: adm('turned-away') }), { kind: 'turned-away' });
  assert.deepEqual(waitingAfterKnock({ kind: 'held' }), { kind: 'held' });
  assert.deepEqual(waitingAfterKnock({ kind: 'refused' }), { kind: 'answers-needed' });
  assert.deepEqual(waitingAfterKnock({ kind: 'dead' }), { kind: 'dead' });
});

test('an admission read after the knock: no answer changes nothing; not-knocked means knock again', () => {
  assert.deepEqual(waitingAfterRead(null), { kind: 'wait', knocked: true });
  assert.deepEqual(waitingAfterRead(adm('waiting')), { kind: 'wait', knocked: true });
  assert.deepEqual(waitingAfterRead(adm('not-knocked')), { kind: 'wait', knocked: false });
  assert.deepEqual(waitingAfterRead(adm('admitted')), { kind: 'admitted' });
  assert.deepEqual(waitingAfterRead(adm('turned-away')), { kind: 'turned-away' });
});

test("the candidate room read is only a slow fallback: the lead end arrives as a live hint (lib/interviewsRoom.ts hintsAfter)", () => {
  assert.equal(ROOM_POLL_MS, 15_000);
});

test('the waiting line says "told" only when the server says so, and "will be told" while it holds the knock but nobody knows', () => {
  assert.equal(waitingLine(false, false), 'telling');
  assert.equal(waitingLine(false, true), 'telling');
  assert.equal(waitingLine(true, false), 'will-tell');
  assert.equal(waitingLine(true, true), 'told');
});
