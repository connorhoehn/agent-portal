// The device check's words (deviceCheckWords.ts): a blocked microphone is said in one sentence with how to allow it, and Continue
// says what will happen; with everything allowed it is the plain Continue and no warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deviceCheckWords } from '../deviceCheckWords.ts';

test('all allowed (or not asked yet): no warning and the plain Continue', () => {
  for (const state of ['granted', 'prompt'] as const) {
    assert.deepEqual(deviceCheckWords({ camera: state, microphone: state }), { blocked: null, missing: null, continueLabel: 'Continue' });
  }
});

test('the microphone blocked: one sentence that says so and how to allow it; Continue says it goes on without one', () => {
  const w = deviceCheckWords({ camera: 'granted', microphone: 'denied' });
  assert.match(w.blocked!, /blocking your microphone/);
  assert.match(w.blocked!, /site settings/);
  assert.equal(w.blocked!.split('. ').length, 1);
  assert.equal(w.missing, null);
  assert.equal(w.continueLabel, 'Continue without a microphone');
});

test('no microphone found, the camera blocked, or both blocked: each said, and Continue names what is missing', () => {
  assert.equal(deviceCheckWords({ camera: 'granted', microphone: 'unavailable' }).continueLabel, 'Continue without a microphone');
  assert.match(deviceCheckWords({ camera: 'granted', microphone: 'unavailable' }).missing!, /No microphone/);
  assert.equal(deviceCheckWords({ camera: 'denied', microphone: 'granted' }).continueLabel, 'Continue without a camera');
  const both = deviceCheckWords({ camera: 'denied', microphone: 'denied' });
  assert.match(both.blocked!, /camera and microphone/);
  assert.equal(both.continueLabel, 'Continue without a camera or microphone');
});
