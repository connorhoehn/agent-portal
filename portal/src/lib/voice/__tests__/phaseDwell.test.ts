// G36 (docs/voice-navigator-gaps.md, session vs_95e5a6c7 at 23:53:30): the
// phase flapped listening, speaking, thinking within one millisecond and every
// 500 ms. The dock holds a shown phase at least 300 ms and coalesces what
// happens inside the window; the event sink never sees two phase events within
// 300 ms, and a flap that reverts inside the window leaves no event at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PHASE_DWELL_MS, VoiceController } from '../controller.ts';
import { VoiceEventLog } from '../sessionEvents.ts';
import { FakeClock, fakeFetch, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000e1';
type Call = { name: string; arguments: Record<string, unknown>; said: string };
const KUBE: Call = { name: 'search', arguments: { query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null }, said: 'Find me the latest Kubernetes experts.' };

const out = (atMs: number, delta: string) => ({ atMs, event: { type: 'session.output_transcript.delta', delta, start_ms: atMs, end_ms: atMs + 50 } });
const said = (atMs: number, delta: string) => ({ atMs, event: { type: 'session.input_transcript.delta', delta, start_ms: atMs, end_ms: atMs + 50 } });

test('G36: a flapping session logs no two phase events within 300 ms, and the shown phase holds as long', async () => {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const script = mockLiveScript(SESSION, KUBE);
  // After the scripted call: barge-ins and replies in the same millisecond, then every 120 ms for two seconds.
  const flaps: unknown[] = [];
  for (let t = 5000; t < 7000; t += 120) flaps.push(said(t, 'wait '), out(t, 'Sure. '), said(t + 1, 'no '));
  for (let t = 9000; t < 9010; t += 1) flaps.push(out(t, 'a'), said(t, 'b'));
  const clock = new FakeClock();
  const { fetch } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['search'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: { ...script, onStart: [...script.onStart, ...flaps] },
    }),
    route('GET', '/api/search', 200, { results: [], total: 0 }),
  ]);
  // The sink: every event the controller hands the session log, with the virtual time it was handed over.
  const sink: Array<{ at: number; phase: string }> = [];
  const add = VoiceEventLog.prototype.add;
  VoiceEventLog.prototype.add = function (id, e) {
    if (e.kind === 'client' && e.data?.['event'] === 'phase') sink.push({ at: clock.t, phase: String(e.data['phase']) });
    return add.call(this, id, e);
  };
  try {
    const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    const shown: Array<{ at: number; phase: string }> = [];
    c.subscribe(() => { const p = c.getSnapshot().phase; if (shown.at(-1)?.phase !== p) shown.push({ at: clock.t, phase: p }); });
    await c.start();
    await clock.advance(12_000, 1);
    const stopping = c.stop('closed');
    await clock.advance(400, 1);
    await stopping;
    c.dispose();

    assert.ok(sink.length >= 4, `phases were logged: ${JSON.stringify(sink)}`);
    const live = sink.filter((e) => e.phase !== 'ended');
    for (let i = 1; i < live.length; i++) {
      assert.ok(live[i]!.at - live[i - 1]!.at >= PHASE_DWELL_MS, `phase events ${JSON.stringify(live[i - 1])} and ${JSON.stringify(live[i])} are under ${PHASE_DWELL_MS} ms apart`);
    }
    const shownLive = shown.filter((e) => e.phase !== 'ended' && e.phase !== 'off' && e.phase !== 'connecting');
    for (let i = 1; i < shownLive.length; i++) assert.ok(shownLive[i]!.at - shownLive[i - 1]!.at >= PHASE_DWELL_MS);
    // Two seconds of 120 ms flapping (about 50 raw changes) leave at most one change per dwell window.
    const during = sink.filter((e) => e.at >= 5000 && e.at < 7300);
    assert.ok(during.length <= Math.ceil(2300 / PHASE_DWELL_MS), `${during.length} events while flapping`);
    // Ten same-millisecond flaps at 9 s: at most one event, and none at all if the phase came back to where it was.
    const burst = sink.filter((e) => e.at >= 9000 && e.at < 9300);
    assert.ok(burst.length <= 1, JSON.stringify(burst));
    // Each event names a real change: never the same phase twice in a row.
    for (let i = 1; i < sink.length; i++) assert.notEqual(sink[i]!.phase, sink[i - 1]!.phase);
    assert.equal(sink.at(-1)!.phase, 'ended');
  } finally { VoiceEventLog.prototype.add = add; }
});

test('G36: a change inside the dwell shows when the window ends, taken from the machine as it stands then', async () => {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const script = mockLiveScript(SESSION, KUBE);
  const clock = new FakeClock();
  const { fetch } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['search'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: { ...script, onStart: [...script.onStart, said(4000, 'and the rest?')] },
    }),
    route('GET', '/api/search', 200, { results: [], total: 0 }),
  ]);
  const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await c.start();
  await clock.advance(3990, 1);
  assert.equal(c.getSnapshot().phase, 'listening');
  await clock.advance(20, 1);
  // The user spoke and nothing answers: thinking at once (listening had held for well over the dwell).
  assert.equal(c.getSnapshot().phase, 'thinking');
  c.dispose();
});
