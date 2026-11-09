import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMachine, phaseAt, reduce, MIC_QUIET_MS, SPEAKING_HOLD_MS, SPEECH_RUN_MS, THINKING_MAX_MS, UTTERANCE_END_MS, type MachineEvent, type MachineState } from '../machine.ts';

const run = (events: MachineEvent[], from: MachineState = initialMachine) => events.reduce(reduce, from);
const live = run([{ type: 'start' }, { type: 'started' }]);

test('connecting, then listening on session.started', () => {
  assert.equal(phaseAt(initialMachine, 0), 'off');
  assert.equal(phaseAt(run([{ type: 'start' }]), 0), 'connecting');
  assert.equal(phaseAt(live, 0), 'listening');
});

test('speaking needs a transcript delta within 1.5 s or output level above 0.08, never audio frames alone', () => {
  const spoke = reduce(live, { type: 'output', at: 1000 });
  assert.equal(phaseAt(spoke, 1000 + SPEAKING_HOLD_MS), 'speaking');
  assert.equal(phaseAt(spoke, 1001 + SPEAKING_HOLD_MS), 'listening');
  // V1: output audio streams near-silence continuously; a low level is not speech.
  assert.equal(phaseAt(reduce(live, { type: 'levels', at: 0, input: 0, output: 0.05 }), 0), 'listening');
  assert.equal(phaseAt(reduce(live, { type: 'levels', at: 0, input: 0, output: 0.2 }), 0), 'speaking');
});

test('thinking runs from the end of the utterance (700 ms with no words and no speech run) until output or a delegation (G44)', () => {
  const said = run([{ type: 'levels', at: 900, input: 0.3, output: 0 }, { type: 'input', at: 1000 }], live);
  assert.equal(phaseAt(said, 1000), 'listening', 'the user just spoke');
  assert.equal(phaseAt(said, 1000 + MIC_QUIET_MS), 'listening', 'a 300 ms pause inside an utterance is not thinking (G44)');
  assert.equal(phaseAt(said, 1000 + UTTERANCE_END_MS), 'thinking');
  assert.equal(phaseAt(said, 1000 + THINKING_MAX_MS), 'listening', 'an ignored utterance stops spinning');
  assert.equal(phaseAt(reduce(said, { type: 'output', at: 1300 }), 1300), 'speaking');
  assert.equal(phaseAt(reduce(said, { type: 'delegation', id: 'd1' }), 1300), 'executing');
  // A blip (one loud tick, a cough) does not end thinking; a run of speech of SPEECH_RUN_MS does.
  const blip = run([{ type: 'levels', at: 1800, input: 0.3, output: 0 }], said);
  assert.equal(phaseAt(blip, 1850), 'thinking');
  const talk = run([1800, 1900, 2000, 2100, 2150].map((at) => ({ type: 'levels' as const, at, input: 0.3, output: 0 })), said);
  assert.ok(2150 - 1800 >= SPEECH_RUN_MS);
  assert.equal(phaseAt(talk, 2200), 'listening', 'new speech ends thinking');
});

test('executing holds through the delegation and running calls; confirming outranks it', () => {
  let s = run([{ type: 'delegation', id: 'd1' }, { type: 'output', at: 10 }], live);
  assert.equal(phaseAt(s, 10), 'executing', 'the spoken acknowledgement does not hide the progress');
  s = run([{ type: 'call-running', callId: 'c1' }, { type: 'confirm-shown', callId: 'c2' }], s);
  assert.equal(phaseAt(s, 10), 'confirming');
  s = run([{ type: 'confirm-resolved', callId: 'c2' }], s);
  assert.equal(phaseAt(s, 10), 'executing');
  s = run([{ type: 'call-done', callId: 'c1' }, { type: 'delegation-done', id: 'd1' }], s);
  assert.equal(phaseAt(s, 10), 'speaking');
});

test('barge-in: the user talking ends the speaking hold', () => {
  const s = run([{ type: 'output', at: 0 }, { type: 'input', at: 200 }], live);
  assert.notEqual(phaseAt(s, 250), 'speaking');
});

test('stop and close end the session; unavailable and failed carry the reason; start retries', () => {
  assert.equal(phaseAt(run([{ type: 'stop' }], live), 0), 'ended');
  assert.equal(phaseAt(run([{ type: 'stop' }, { type: 'closed' }], live), 0), 'ended');
  const un = run([{ type: 'start' }, { type: 'unavailable', reason: 'Voice unavailable: no key on this deployment' }]);
  assert.equal(phaseAt(un, 0), 'unavailable');
  assert.equal(un.reason, 'Voice unavailable: no key on this deployment');
  assert.equal(phaseAt(reduce(un, { type: 'start' }), 0), 'connecting');
  assert.equal(reduce(live, { type: 'start' }), live, 'no second session while one is open');
  const failed = run([{ type: 'start' }, { type: 'failed', reason: 'Try again' }]);
  assert.deepEqual([phaseAt(failed, 0), failed.reason], ['ended', 'Try again']);
});
