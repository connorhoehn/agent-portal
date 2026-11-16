import test from 'node:test';
import assert from 'node:assert/strict';
import { EARLY_BUFFER_S, EARLY_BUFFER_TTL_MS, JITTER_BUFFER_S, MAX_LATE_S, SCHEDULE_LEAD_S, SPEAKING_HOLD_MS, frameSeconds, keepEarly, speakingHoldMs, muteKey, parseAudioFrame, pcm16ToFloat32, readMutedFrom, runChanged, scheduleFrame, shouldPlay, soundPromptShown } from '../assistantVoiceModel.ts';

test('the mute choice is read under its key, or under the key it was kept under before the rename', () => {
  const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null });
  assert.equal(muteKey('c1'), 'orgiq.assistantMuted:c1');
  assert.equal(readMutedFrom(store({ 'orgiq.assistantMuted:c1': '1' }), 'c1'), true);
  assert.equal(readMutedFrom(store({ 'orgiq.novaMuted:c1': '1' }), 'c1'), true);
  assert.equal(readMutedFrom(store({ 'orgiq.assistantMuted:c1': '0', 'orgiq.novaMuted:c1': '1' }), 'c1'), false, 'the new key wins');
  assert.equal(readMutedFrom(store({ 'orgiq.novaMuted:c2': '1' }), 'c1'), false);
  assert.equal(readMutedFrom(store({}), ''), false);
});

const b64 = (vals: number[]) => { const buf = Buffer.alloc(vals.length * 2); vals.forEach((v, i) => buf.writeInt16LE(v, i * 2)); return buf.toString('base64'); };

test('PCM16 little-endian decodes to floats and an odd byte or bad base64 is harmless', () => {
  const f = pcm16ToFloat32(b64([0, 16384, -32768, 32767]));
  assert.equal(f.length, 4);
  assert.equal(f[0], 0); assert.equal(f[1], 0.5); assert.equal(f[2], -1);
  assert.ok(f[3]! < 1 && f[3]! > 0.999);
  assert.equal(pcm16ToFloat32(Buffer.from([1, 0, 7]).toString('base64')).length, 1);
  assert.equal(pcm16ToFloat32('***').length, 0);
});

test('only well-formed assistant-audio frames parse', () => {
  const ok = { type: 'assistant-audio', channel: 'x', data: { callId: 'c1', seq: 3, sampleRate: 24000, pcm: 'AAA=', last: true } };
  assert.deepEqual(parseAudioFrame(ok), { callId: 'c1', runId: '', seq: 3, sampleRate: 24000, pcm: 'AAA=', last: true });
  assert.equal(parseAudioFrame({ ...ok, type: 'message' }), null);
  assert.equal(parseAudioFrame({ ...ok, data: { ...ok.data, seq: 0 } }), null);
  assert.equal(parseAudioFrame({ ...ok, data: { ...ok.data, pcm: 5 } }), null);
  assert.equal(parseAudioFrame(null), null);
  assert.equal(parseAudioFrame({ ...ok, data: { callId: 'c1', seq: 1, pcm: '' } })?.sampleRate, 24000);
});

test('a new run id means the server counted again from 1, and a frame without one never does', () => {
  const ok = { type: 'assistant-audio', channel: 'x', data: { callId: 'c1', runId: 'run-a', seq: 9, pcm: 'AAA=' } };
  assert.equal(parseAudioFrame(ok)?.runId, 'run-a');
  assert.equal(runChanged('run-a', { runId: 'run-a' }), false);
  assert.equal(runChanged('run-a', { runId: 'run-b' }), true);
  assert.equal(runChanged('run-a', { runId: '' }), false);
});

test('a frame plays only for this call, newer, unmuted, with voice on and Milo listening', () => {
  const g = { callId: 'c1', frameCallId: 'c1', seq: 5, lastSeq: 4, muted: false, voice: true, listening: true };
  assert.equal(shouldPlay(g), true);
  for (const bad of [{ frameCallId: 'c2' }, { seq: 4 }, { seq: 3 }, { muted: true }, { voice: false }, { listening: false }]) assert.equal(shouldPlay({ ...g, ...bad }), false);
});

test('the first frame waits for the jitter buffer; later ones follow on gaplessly', () => {
  const first = scheduleFrame({ currentTime: 10, nextStartTime: 0, frameSeconds: 0.1, utteranceStarted: false });
  assert.ok(first.play && Math.abs(first.startAt - (10 + JITTER_BUFFER_S)) < 1e-9);
  assert.ok(first.play && Math.abs(first.nextStartTime - 10.25) < 1e-9);
  const next = scheduleFrame({ currentTime: 10.05, nextStartTime: 10.25, frameSeconds: 0.1, utteranceStarted: true });
  assert.ok(next.play && next.startAt === 10.25);
});

test('a frame behind the clock starts just ahead of it, and one more than 500 ms late starts a new utterance', () => {
  const behind = scheduleFrame({ currentTime: 10.3, nextStartTime: 10.2, frameSeconds: 0.1, utteranceStarted: true });
  assert.ok(behind.play && Math.abs(behind.startAt - (10.3 + SCHEDULE_LEAD_S)) < 1e-9);
  const late = scheduleFrame({ currentTime: 11, nextStartTime: 10.4, frameSeconds: 0.1, utteranceStarted: true });
  assert.ok(late.play && Math.abs(late.startAt - (11 + JITTER_BUFFER_S)) < 1e-9, 'a late frame is re-buffered, not dropped');
  assert.ok(MAX_LATE_S === 0.5);
  assert.equal(scheduleFrame({ currentTime: 10, nextStartTime: 0, frameSeconds: 0.1, utteranceStarted: false, running: false }).play, false, 'nothing is scheduled while the context is suspended');
});

test('"Click to hear Milo" shows as soon as the voice is on and the browser waits for a click, before any reply; not muted, not off, not once allowed', () => {
  const on = { present: true, voiceOn: true, muted: false, needsGesture: true };
  // No frame count in the condition at all: it is shown before Milo's first reply.
  assert.equal(soundPromptShown(on), true);
  assert.equal(soundPromptShown({ ...on, needsGesture: false }), false); // sound allowed (a click, or a browser that never blocks)
  assert.equal(soundPromptShown({ ...on, voiceOn: false }), false); // the voice turned off
  assert.equal(soundPromptShown({ ...on, muted: true }), false); // this person muted Milo
  assert.equal(soundPromptShown({ ...on, present: false }), false); // Milo not in the call (left, or not invited)
});

test('the speaking mark lasts until the scheduled playout ends, plus the hold (sweep 4 in-call 8)', () => {
  assert.equal(speakingHoldMs(10, 10), SPEAKING_HOLD_MS);
  // A released hold of two seconds arrives as one burst: the mark stays on for the two seconds it takes to play.
  assert.equal(speakingHoldMs(10, 12), 2000 + SPEAKING_HOLD_MS);
  assert.equal(speakingHoldMs(10, 9), SPEAKING_HOLD_MS, 'nothing scheduled ahead: the hold alone');
});

test('frames that come while the voice is believed off are kept, up to one second, never while muted (sweep 4 in-call 7)', () => {
  // 0.25 s of 24 kHz 16-bit mono: 6000 samples, 12000 bytes, 16000 base64 characters.
  const quarter = (seq: number) => ({ callId: 'c', runId: 'r', seq, sampleRate: 24000, pcm: 'A'.repeat(16000), last: false });
  assert.equal(frameSeconds(quarter(1)), 0.25);
  assert.equal(keepEarly(null, quarter(1), { muted: true, lastSeq: 0, now: 0 }), null, 'never kept for someone who muted Milo');
  assert.equal(keepEarly(null, quarter(3), { muted: false, lastSeq: 3, now: 0 }), null, 'never a frame already played');
  let buf = keepEarly(null, quarter(1), { muted: false, lastSeq: 0, now: 100 });
  assert.ok(buf);
  for (const seq of [2, 3, 4]) buf = keepEarly(buf, quarter(seq), { muted: false, lastSeq: 0, now: 200 }) ?? buf;
  assert.deepEqual(buf!.frames.map((f) => f.seq), [1, 2, 3, 4]);
  assert.equal(buf!.seconds, EARLY_BUFFER_S);
  assert.equal(keepEarly(buf, quarter(5), { muted: false, lastSeq: 0, now: 300 }), null, 'past one second nothing more is kept');
  assert.equal(keepEarly(buf, quarter(2), { muted: false, lastSeq: 0, now: 300 }), null, 'a frame is kept once');
  const later = keepEarly(buf, quarter(9), { muted: false, lastSeq: 0, now: 100 + EARLY_BUFFER_TTL_MS + 1 });
  assert.deepEqual(later!.frames.map((f) => f.seq), [9], 'a stale buffer starts over');
});
