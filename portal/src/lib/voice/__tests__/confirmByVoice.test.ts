// G40 (sessions of 9 November 00:42): the voice asks for the word. A message
// card is confirmed by saying "confirm" (logged by: voice, phrase: confirm,
// afterMs); "stop" cancels; a computer start card ignores a spoken yes and the
// voice says to click; the Voice log record lists the confirmations.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_HINT, VoiceController, cardHint, cardNote, confirmPhrase } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import { confirmLabelOf, confirmLine, type PreparedCall, type VoiceToolRunner } from '../tools.ts';
import { confirmationsLine } from '../../../pages/voice/voiceLogModel.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000c4';
type Call = { name: string; arguments: Record<string, unknown>; said: string };
const POST: Call = { name: 'message', arguments: { target: { kind: 'channel', name: 'platform' }, text: 'Deploy is done' }, said: 'Tell #platform the deploy is done.' };
const START: Call = { name: 'computer', arguments: { action: 'start', initiatives: ['p1'] }, said: 'Start a computer for Alpha.' };
const say = (atMs: number, delta: string) => ({ atMs, event: { type: 'session.input_transcript.delta', delta, start_ms: 4000, end_ms: 4400 } });

async function session(call: Call, extra: unknown[]) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const script = mockLiveScript(SESSION, call);
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, mockScript: { ...script, onStart: [...script.onStart, ...extra] } }),
  ]);
  const ran: string[] = [];
  const stub = (name: string): VoiceToolRunner => async () => { ran.push(name); return { outcome: 'done', output: { kind: 'ok' }, summary: 'ok' }; };
  const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, message: stub('message'), computer: stub('computer') }, planners: {} });
  const sent: Array<{ type: string; text: string }> = [];
  const proto = VoiceClient.prototype;
  const orig = { t: proto.appendThinking, c: proto.appendCommentary };
  proto.appendThinking = function (t: string) { sent.push({ type: 'thinking', text: t }); return orig.t.call(this, t); };
  proto.appendCommentary = function (t: string) { sent.push({ type: 'commentary', text: t }); return orig.c.call(this, t); };
  return { c, clock, log, ran, sent, restore: () => { proto.appendThinking = orig.t; proto.appendCommentary = orig.c; } };
}

test('G40: "confirm" after a message card sends it, logged by voice with the word and the wait; the card and the voice ask for it', async () => {
  const h = await session(POST, [say(1500, 'confirm')]);
  try {
    await h.c.start();
    await h.clock.advance(1200);
    const card = h.c.getSnapshot().pending!;
    assert.equal(card.hint, CARD_HINT.voice);
    assert.equal(card.confirmBy, 'voice');
    // ui-components 2.516.0: the button says Send; the spoken vocabulary stays "confirm".
    assert.deepEqual(card.card, { confirmLabel: 'Send' });
    assert.ok(h.sent.some((s) => s.type === 'thinking' && s.text === cardNote('Say confirm to send.')));
    await h.clock.advance(2000);
    assert.deepEqual(h.ran, ['message']);
    const confirmed = loggedEvents(h.log).filter((e) => e['kind'] === 'confirmed');
    assert.equal(confirmed.length, 1);
    const d = confirmed[0]!['data'] as Record<string, unknown>;
    assert.equal(d['by'], 'voice');
    assert.equal(d['phrase'], 'confirm');
    assert.ok(typeof d['afterMs'] === 'number' && (d['afterMs'] as number) > 0 && (d['afterMs'] as number) < 3000);
    assert.match(confirmationsLine([{ kind: 'confirmed', data: { ...d, tool: 'message' } }])!, /^message confirmed by voice "confirm", \d\.\d s$/);
    h.c.dispose();
  } finally { h.restore(); }
});

test('G40: "stop" cancels the card and sends nothing', async () => {
  const h = await session(POST, [say(1500, 'stop')]);
  try {
    await h.c.start();
    await h.clock.advance(3000);
    assert.deepEqual(h.ran, []);
    const cancelled = loggedEvents(h.log).find((e) => e['kind'] === 'cancelled');
    assert.equal((cancelled!['data'] as Record<string, unknown>)['phrase'], 'stop');
    h.c.dispose();
  } finally { h.restore(); }
});

test('G40: a computer start card ignores a spoken "confirm"; the voice says to click, and the click runs it', async () => {
  const h = await session(START, [say(1500, 'confirm')]);
  try {
    await h.c.start();
    await h.clock.advance(1200);
    assert.equal(h.c.getSnapshot().pending!.hint, CARD_HINT.click);
    assert.equal(h.c.getSnapshot().pending!.card, undefined, 'a computer start keeps Confirm');
    await h.clock.advance(2000);
    assert.deepEqual(h.ran, [], 'nothing started by voice');
    assert.ok(h.c.getSnapshot().pending, 'the card waits for the click');
    assert.ok(h.sent.some((s) => s.type === 'commentary' && /Click confirm on the card to go ahead\./.test(s.text)));
    assert.ok(loggedEvents(h.log).some((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'click-required'));
    h.c.confirm('click');
    await h.clock.advance(500);
    assert.deepEqual(h.ran, ['computer']);
    const d = loggedEvents(h.log).find((e) => e['kind'] === 'confirmed')!['data'] as Record<string, unknown>;
    assert.equal(d['by'], 'click');
    assert.equal(d['phrase'], undefined);
    h.c.dispose();
  } finally { h.restore(); }
});

test('G40: the logged word is the closed vocabulary, never the utterance', () => {
  assert.equal(confirmPhrase('Confirm, send it to the whole team'), 'confirm');
  assert.equal(confirmPhrase('yeah go'), 'yeah');
  assert.equal(confirmPhrase('no wait'), 'no');
  assert.equal(confirmPhrase('please do the thing'), null);
});

test('2.516.0: the card button says the action\'s verb; click lines name it, spoken lines still say confirm', () => {
  const call = (name: string, args: Record<string, unknown> = {}, sayToConfirm = 'go ahead') =>
    ({ spec: { name, sayToConfirm }, args }) as unknown as PreparedCall;
  assert.equal(confirmLabelOf(call('message')), 'Send');
  assert.equal(confirmLabelOf(call('queue_work')), 'Queue');
  assert.equal(confirmLabelOf(call('create', { kind: 'sprint' })), 'Create');
  assert.equal(confirmLabelOf(call('create', { kind: 'access-request' })), 'Request');
  assert.equal(confirmLabelOf(call('computer', { action: 'start' })), undefined);
  assert.equal(confirmLabelOf(call('decide'), { title: 't', data: null, card: { confirmLabel: 'Resolve' } }), 'Resolve');
  assert.equal(confirmLine(call('message', {}, 'send'), 'voice', 'Send'), 'Say confirm to send.');
  assert.equal(confirmLine(call('create', {}, 'create it'), 'click', 'Request'), 'Click Request on the card to create it.');
  assert.equal(confirmLine(call('computer'), 'click'), 'Click confirm on the card to go ahead.');
  assert.equal(cardHint('voice', 'Send'), CARD_HINT.voice);
  assert.equal(cardHint('click', 'Reject'), 'Click Reject on the card; say cancel to drop it.');
  assert.equal(cardHint('click'), CARD_HINT.click);
});
