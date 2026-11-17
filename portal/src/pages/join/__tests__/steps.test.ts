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
