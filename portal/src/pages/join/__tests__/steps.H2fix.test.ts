// The late candidate's way back (pages/join/steps.ts answersStand; hardening H2, walk step I2.3f).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTHING_ANSWERED, answersStand, stepAfterConsents, type ConsentChoices } from '../steps.ts';

const ALL: ConsentChoices = { recording: true, transcription: true, milo: true };

test('a refused change leaves a way back to waiting when the stored answers are complete', () => {
  assert.equal(answersStand({ answers: ALL }), true);
  assert.equal(stepAfterConsents(true, { answers: ALL, required: [] }), 'waiting');
});

test('no way back when nothing stands (a changed notice asks for fresh answers)', () => {
  assert.equal(answersStand({ answers: NOTHING_ANSWERED }), false);
  assert.equal(answersStand({ answers: { ...ALL, milo: null } }), false);
  assert.equal(answersStand(null), false);
});
