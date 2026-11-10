// The scripted session's turns (MOCK_VOICE; middleware lib/voice/openai.ts mockLiveTurns, PUT /api/voice/mock-script):
// several requests in one session, each spoken once the one before it was continued, and the user's "confirm"
// spoken once a card opens. The demo journey (scripts/journeys/demo-moments.mjs) drives the dock with these; here
// the real middleware script runs against the real dock, with the runners stubbed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { MOCK_FRAME_EVENT, VoiceClient, type MockScript } from '../client.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import { SAY_MAX_WORDS, withSay } from '../contextWindow.ts';
import type { VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000d7';
type Turn = { said: string; call?: { name: string; arguments: Record<string, unknown> }; on?: 'card' };
type Turns = (id: string, turns: Turn[]) => MockScript;

async function session(turns: Turn[]) {
  const { mockLiveTurns } = await middlewareVoice<{ mockLiveTurns: Turns }>('openai.ts');
  const script = mockLiveTurns(SESSION, turns);
  const clock = new FakeClock();
  const names = [...new Set(turns.flatMap((t) => (t.call ? [t.call.name] : [])))];
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: names, budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, mockScript: script }),
  ]);
  const ran: string[] = [];
  const stub = (name: string, summary: string): VoiceToolRunner => async () => { ran.push(name); return { outcome: 'done', output: { kind: 'ok' }, summary }; };
  const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, open: stub('open', 'Opened Alpha'), message: stub('message', 'Posted to #platform'), computer: stub('computer', 'Started a computer') }, planners: {} });
  const outputs: Array<Record<string, unknown>> = [];
  const proto = VoiceClient.prototype;
  const orig = proto.sendToolOutput;
  proto.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.call(this, id, o); };
  return { c, clock, log, ran, outputs, script, restore: () => { proto.sendToolOutput = orig; } };
}

const OPEN: Turn = { said: 'Open Alpha.', call: { name: 'open', arguments: { kind: 'initiative', name: 'Alpha' } } };
const POST: Turn = { said: 'Tell #platform the deploy is done.', call: { name: 'message', arguments: { target: { kind: 'channel', name: 'platform' }, text: 'Deploy is done' } } };
const START: Turn = { said: 'Start a computer for Alpha.', call: { name: 'computer', arguments: { action: 'start', initiatives: ['p1'] } } };

test('one request is exactly the single-call script mockLiveScript always returned', async () => {
  const m = await middlewareVoice<{ mockLiveTurns: Turns; mockLiveScript: (id: string, c: { name: string; arguments: Record<string, unknown>; said: string }) => MockScript }>('openai.ts');
  const call = { name: 'search', arguments: { query: 'Kubernetes experts' }, said: 'Find the Kubernetes experts.' };
  assert.deepEqual(m.mockLiveTurns(SESSION, [{ said: call.said, call: { name: call.name, arguments: call.arguments } }]), m.mockLiveScript(SESSION, call));
  assert.equal(m.mockLiveScript(SESSION, call).onResponseCreateSeq, undefined);
});

test('two requests and a spoken confirm: open runs, then the message, which "confirm" sends; each result carries a terse say line', async () => {
  const h = await session([OPEN, POST, { said: 'confirm', on: 'card' }]);
  try {
    await h.c.start();
    await h.clock.advance(1500);
    assert.deepEqual(h.ran, ['open'], 'the first request runs first');
    await h.clock.advance(4000);
    assert.ok(h.c.getSnapshot().pending || h.ran.includes('message'), 'the second request reached its card');
    await h.clock.advance(4000);
    assert.deepEqual(h.ran, ['open', 'message']);
    const confirmed = loggedEvents(h.log).filter((e) => e['kind'] === 'confirmed');
    assert.equal(confirmed.length, 1);
    assert.equal((confirmed[0]!['data'] as Record<string, unknown>)['by'], 'voice');
    // withSay: a done result with no line of its own speaks the dock's summary, one sentence.
    assert.deepEqual(h.outputs.map((o) => o['say']), ['Opened Alpha.', 'Posted to #platform.']);
    h.c.dispose();
  } finally { h.restore(); }
});

test('a card turn is cued on its own request\'s card: a click-only card hears "confirm", runs nothing, and waits for the click', async () => {
  const h = await session([START, { said: 'confirm', on: 'card' }]);
  try {
    await h.c.start();
    await h.clock.advance(4000);
    assert.deepEqual(h.ran, []);
    assert.ok(h.c.getSnapshot().pending, 'the card waits');
    assert.ok(loggedEvents(h.log).some((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'click-required'));
    h.c.confirm('click');
    await h.clock.advance(500);
    assert.deepEqual(h.ran, ['computer']);
    h.c.dispose();
  } finally { h.restore(); }
});

test('the card cue waits for its request: a "confirm" after the second request never answers the first one\'s card', async () => {
  const m = await middlewareVoice<{ mockLiveTurns: Turns }>('openai.ts');
  const s = m.mockLiveTurns(SESSION, [START, POST, { said: 'confirm', on: 'card' }]);
  assert.equal(s.onResponseCreateSeq?.length, 2);
  assert.deepEqual(s.onSent?.map((c) => [c.type, c.minResponses]), [['session.thinking.append', 1]]);
  // The second request is spoken inside the first one's continuation, under its own delegation and call ids.
  const second = s.onResponseCreateSeq![0]!.map((f) => f.event);
  assert.ok(second.some((e) => e['type'] === 'session.input_transcript.delta' && e['delta'] === POST.said));
  assert.ok(second.some((e) => (e['delegation'] as { id?: string } | undefined)?.id === 'item_mock_delegation_2'));
});

test('a scripted session raises MOCK_FRAME_EVENT for every frame in and out; a result frame carries its say line', async () => {
  const seen: Array<{ dir: string; event: Record<string, unknown> }> = [];
  const g = globalThis as unknown as { dispatchEvent?: (e: Event) => boolean };
  const had = g.dispatchEvent;
  g.dispatchEvent = (e: Event) => { if (e.type === MOCK_FRAME_EVENT) seen.push((e as CustomEvent).detail); return true; };
  const h = await session([OPEN]);
  try {
    await h.c.start();
    await h.clock.advance(3000);
    assert.ok(seen.some((f) => f.dir === 'in' && f.event['type'] === 'session.input_transcript.delta'));
    const out = seen.find((f) => f.dir === 'out' && f.event['type'] === 'response.item.create');
    assert.equal(JSON.parse(String((out!.event['item'] as { output: string }).output))['say'], 'Opened Alpha.');
    h.c.dispose();
  } finally { h.restore(); if (had) g.dispatchEvent = had; else delete g.dispatchEvent; }
});

test('withSay: a done result keeps its own line; else one sentence of the summary, at most SAY_MAX_WORDS words; a refusal gets none', () => {
  assert.equal(withSay('message', 'done', { say: 'Opened Alpha.' }, 'whatever')['say'], 'Opened Alpha.');
  assert.equal(withSay('message', 'done', {}, 'Resolved: "Cutover order" (Riskiest first)')['say'], 'Resolved: "Cutover order" (Riskiest first).');
  assert.equal(withSay('message', 'done', {}, 'Queued. The portal shows its progress.')['say'], 'Queued.');
  const long = withSay('message', 'done', {}, Array.from({ length: 40 }, (_, i) => `w${i}`).join(' '))['say'] as string;
  assert.equal(long.split(' ').length, SAY_MAX_WORDS);
  assert.ok(long.endsWith('…'));
  assert.equal(withSay('message', 'refused', { reason: 'no' }, 'Refused')['say'], undefined);
  // list, search and get make their own line (G33), or none when every row was asked for.
  assert.equal(withSay('list', 'done', { rows: [] }, '10 work items')['say'], undefined);
});
