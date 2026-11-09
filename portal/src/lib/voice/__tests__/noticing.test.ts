// G32 and G33 item 4 (docs/voice-navigator-gaps.md): the dock asks for notice.
// A confirm card pulses the control once and the voice says "I need your OK,
// the card is in the dock" (the dock says it itself when the voice has not);
// after a result, six seconds of silence from both sides pulse once more and
// nothing is spoken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_LINE, CARD_LINE_WAIT_MS, CARD_NOTE, IDLE_PULSE_MS, PULSE_MS, VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import type { VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000b2';
type Call = { name: string; arguments: Record<string, unknown>; said: string };

const KUBE: Call = { name: 'search', arguments: { query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null }, said: 'Find me the latest Kubernetes experts.' };
const POST: Call = { name: 'message', arguments: { target: { kind: 'team', name: 'platform' }, text: "I'm out today" }, said: "Tell the platform team I'm out today." };

async function session(call: Call, extraStart: unknown[] = []) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const script = mockLiveScript(SESSION, call);
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: { ...script, onStart: [...script.onStart, ...extraStart] },
    }),
    route('GET', '/api/search', 200, { results: [{ title: 'Priya Natarajan', subtitle: 'Staff platform engineer', href: '/iq/people/p1' }], total: 1 }),
  ]);
  const ctx = toolContext({ fetch });
  const runner: VoiceToolRunner = async () => ({ outcome: 'done', output: { kind: 'posted', posted: true }, summary: 'Posted' });
  const c = new VoiceController({
    fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, message: runner }, planners: {},
  });
  const pulses: number[] = [];
  let was = false;
  c.subscribe(() => { const p = c.getSnapshot().pulse; if (p && !was) pulses.push(clock.t); was = p; });
  return { c, clock, log, pulses };
}

/** Spy on what the dock sends the voice: silent notes, spoken commentary and response requests. */
function spy() {
  const sent: Array<{ type: 'thinking' | 'commentary' | 'response'; text?: string; at: number }> = [];
  const proto = VoiceClient.prototype;
  const orig = { think: proto.appendThinking, say: proto.appendCommentary, resp: proto.requestResponse };
  let clock: FakeClock | null = null;
  proto.appendThinking = function (t: string) { sent.push({ type: 'thinking', text: t, at: clock?.t ?? 0 }); return orig.think.call(this, t); };
  proto.appendCommentary = function (t: string) { sent.push({ type: 'commentary', text: t, at: clock?.t ?? 0 }); return orig.say.call(this, t); };
  proto.requestResponse = function () { sent.push({ type: 'response', at: clock?.t ?? 0 }); return orig.resp.call(this); };
  return { sent, bind: (c: FakeClock) => { clock = c; }, restore: () => { Object.assign(proto, { appendThinking: orig.think, appendCommentary: orig.say, requestResponse: orig.resp }); } };
}

test('G32: a confirm card pulses once, asks the voice for the line, and the dock says it when the voice has not', async () => {
  const s = spy();
  try {
    const h = await session(POST);
    s.bind(h.clock);
    await h.c.start();
    await h.clock.advance(1100);
    assert.ok(h.c.getSnapshot().pending, 'the card is up');
    assert.equal(h.pulses.length, 1, 'one pulse when the card opened');
    assert.equal(h.c.getSnapshot().pulse, true);
    assert.ok(s.sent.some((e) => e.type === 'thinking' && e.text === CARD_NOTE), 'the voice is asked for the line');
    await h.clock.advance(PULSE_MS);
    assert.equal(h.c.getSnapshot().pulse, false, 'the pulse flag drops after one pulse');
    await h.clock.advance(CARD_LINE_WAIT_MS);
    const said = s.sent.filter((e) => e.type === 'commentary');
    assert.equal(said.length, 1);
    assert.match(said[0]!.text!, /I need your OK, the card is in the dock\./);
    assert.ok(h.c.getSnapshot().turns.some((t) => t.text === CARD_LINE), 'the spoken line is in the transcript');
    await h.clock.advance(10_000);
    assert.equal(s.sent.filter((e) => e.type === 'commentary').length, 1, 'said once');
    assert.equal(h.pulses.length, 1, 'no idle pulse while the card waits');
    const events = loggedEvents(h.log);
    assert.equal(events.filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'pulse').length, 1);
    h.c.dispose();
  } finally { s.restore(); }
});

test('G32: when the voice says the line itself, the dock does not repeat it', async () => {
  const s = spy();
  try {
    const h = await session(POST, [{ atMs: 1400, event: { type: 'session.output_transcript.delta', delta: 'I need your OK, the card is in the dock.', start_ms: 2000, end_ms: 3000 } }]);
    s.bind(h.clock);
    await h.c.start();
    await h.clock.advance(1100 + CARD_LINE_WAIT_MS + 500);
    assert.equal(s.sent.filter((e) => e.type === 'commentary').length, 0);
    assert.equal(h.c.getSnapshot().turns.filter((t) => /card is in the dock/.test(t.text)).length, 1);
    h.c.dispose();
  } finally { s.restore(); }
});

test('G33 item 4: silence after a result pulses once and nothing is spoken', async () => {
  const s = spy();
  try {
    const h = await session(KUBE);
    s.bind(h.clock);
    await h.c.start();
    // The result goes out at about 1.0 s; the continuation speaks "Here is what I found." at about 2.0 s.
    await h.clock.advance(2500);
    assert.equal(h.pulses.length, 0);
    const lastSpoken = 2010;
    await h.clock.advance(lastSpoken + IDLE_PULSE_MS - 2500 - 100);
    assert.equal(h.pulses.length, 0, 'not before six seconds of silence');
    const before = s.sent.length;
    await h.clock.advance(400);
    assert.equal(h.pulses.length, 1, 'one pulse after six silent seconds');
    await h.clock.advance(30_000);
    assert.equal(h.pulses.length, 1, 'once');
    assert.deepEqual(s.sent.slice(before), [], 'no commentary, no response, no note: no audio');
    h.c.dispose();
  } finally { s.restore(); }
});

test('G33 item 4: the user speaking after the result stands the idle pulse down', async () => {
  const h = await session(KUBE, [{ atMs: 4500, event: { type: 'session.input_transcript.delta', delta: 'thanks', start_ms: 9000, end_ms: 9400 } }]);
  await h.c.start();
  await h.clock.advance(20_000);
  assert.equal(h.pulses.length, 0);
  h.c.dispose();
});
