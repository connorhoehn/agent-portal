// G66: a spoken confirm counts for VOICE_CONFIRM_WINDOW_MS from the card's
// opening. After it, after a page navigation, or after a new delegation that is
// not the card's answer, the card stays open but takes only a click: its hint
// becomes the click hint, the voice is told once, a spoken yes is ignored and
// logged as `confirm-expired` (closed vocabulary, no words), and a spoken
// cancel still drops it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VOICE_CONFIRM_WINDOW_MS, VoiceController, cardHint, voiceWindowNote } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import type { VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000c6';
type Call = { name: string; arguments: Record<string, unknown>; said: string };
const POST: Call = { name: 'message', arguments: { target: { kind: 'channel', name: 'platform' }, text: 'Deploy is done' }, said: 'Tell #platform the deploy is done.' };
const START: Call = { name: 'computer', arguments: { action: 'start', initiatives: ['p1'] }, said: 'Start a computer for Alpha.' };
const say = (atMs: number, delta: string, startMs = 4000) => ({ atMs, event: { type: 'session.input_transcript.delta', delta, start_ms: startMs, end_ms: startMs + 400 } });
const delegation = (atMs: number, id: string) => ({ atMs, event: { type: 'session.delegation.created', offset_ms: 0, delegation: { id, type: 'delegation', response_id: `resp_${id}`, target: 'responses' } } });
/** The click line of a message card, and its hint, once the window ends. */
const CLICK_LINE = 'Click Send on the card to send.';
const WINDOW_NOTE = voiceWindowNote(CLICK_LINE);

async function session(call: Call, extra: unknown[]) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const script = mockLiveScript(SESSION, call);
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 5, usdPerMinute: 0.05 }, mockScript: { ...script, onStart: [...script.onStart, ...extra] } }),
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
  const events = (name: string) => loggedEvents(log).map((e) => (e['data'] ?? {}) as Record<string, unknown>).filter((d) => d['event'] === name);
  return { c, clock, log, ran, sent, events, restore: () => { proto.appendThinking = orig.t; proto.appendCommentary = orig.c; } };
}

/** The card opens at about 1 s (the request's call lands at 1010 ms). */
const CARD_AT = 1010;

test('G66: the window is one constant, 45 s', () => {
  assert.equal(VOICE_CONFIRM_WINDOW_MS, 45_000);
});

test('G66: a bare "ok" inside the window still confirms', async () => {
  const h = await session(POST, [say(CARD_AT + VOICE_CONFIRM_WINDOW_MS - 2000, 'ok')]);
  try {
    await h.c.start();
    await h.clock.advance(CARD_AT + VOICE_CONFIRM_WINDOW_MS);
    assert.deepEqual(h.ran, ['message']);
    assert.equal(h.events('confirm-window-ended').length, 0);
    h.c.dispose();
  } finally { h.restore(); }
});

test('G66: after 45 s the card turns click-only; a later "ok" is ignored and logged without words; the voice is told once', async () => {
  const h = await session(POST, [say(CARD_AT + VOICE_CONFIRM_WINDOW_MS + 5000, 'ok'), say(CARD_AT + VOICE_CONFIRM_WINDOW_MS + 9000, 'yes', 9000)]);
  try {
    await h.c.start();
    await h.clock.advance(1500);
    assert.equal(h.c.getSnapshot().pending!.confirmBy, 'voice');
    await h.clock.advance(VOICE_CONFIRM_WINDOW_MS);
    const card = h.c.getSnapshot().pending!;
    assert.ok(card, 'the card stays open');
    assert.equal(card.confirmBy, 'click');
    assert.equal(card.hint, cardHint('click', 'Send'));
    assert.equal(card.hint, 'Click Send on the card; say cancel to drop it.');
    const ended = h.events('confirm-window-ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0]!['cause'], 'timeout');
    await h.clock.advance(12_000);
    assert.deepEqual(h.ran, [], 'a late yes sends nothing');
    assert.ok(h.c.getSnapshot().pending, 'still waiting for the click');
    const expired = h.events('confirm-expired');
    assert.equal(expired.length, 2);
    for (const d of expired) {
      assert.deepEqual(Object.keys(d).sort(), ['cause', 'event', 'requestId', 'tool']);
      assert.equal(d['cause'], 'timeout');
      assert.equal(d['tool'], 'message');
    }
    assert.equal(h.events('click-required').length, 0, 'the expired card is not the G40 click card');
    // Told once, silently; the dock does not speak the click line over the voice on each yes.
    assert.equal(h.sent.filter((s) => s.text === WINDOW_NOTE).length, 1);
    assert.equal(h.sent.filter((s) => s.type === 'thinking' && s.text === WINDOW_NOTE).length, 1);
    assert.equal(h.sent.filter((s) => s.type === 'commentary' && s.text.includes(CLICK_LINE)).length, 0);
    assert.equal(loggedEvents(h.log).filter((e) => e['kind'] === 'confirmed').length, 0);
    // The click still confirms.
    h.c.confirm('click');
    await h.clock.advance(500);
    assert.deepEqual(h.ran, ['message']);
    h.c.dispose();
  } finally { h.restore(); }
});

test('G66: a spoken cancel still drops an expired card', async () => {
  const h = await session(POST, [say(CARD_AT + VOICE_CONFIRM_WINDOW_MS + 3000, 'cancel')]);
  try {
    await h.c.start();
    await h.clock.advance(CARD_AT + VOICE_CONFIRM_WINDOW_MS + 5000);
    assert.equal(h.c.getSnapshot().pending, null);
    assert.deepEqual(h.ran, []);
    const cancelled = loggedEvents(h.log).find((e) => e['kind'] === 'cancelled')!['data'] as Record<string, unknown>;
    assert.equal(cancelled['by'], 'voice');
    h.c.dispose();
  } finally { h.restore(); }
});

test('G66: a page navigation ends the spoken confirm at once; the same path does not', async () => {
  const h = await session(POST, [say(8000, 'okay')]);
  try {
    h.c.pathChanged('/iq/initiatives/p1');
    await h.c.start();
    await h.clock.advance(1500);
    h.c.pathChanged('/iq/initiatives/p1');
    assert.equal(h.c.getSnapshot().pending!.confirmBy, 'voice', 'the same page keeps the window');
    h.c.pathChanged('/iq/people');
    assert.equal(h.c.getSnapshot().pending!.confirmBy, 'click');
    assert.equal(h.c.getSnapshot().pending!.hint, 'Click Send on the card; say cancel to drop it.');
    await h.clock.advance(8000);
    assert.deepEqual(h.ran, []);
    assert.equal(h.events('confirm-window-ended')[0]?.['cause'], 'navigation');
    assert.equal(h.events('confirm-expired')[0]?.['cause'], 'navigation');
    // Coming back does not reopen the window.
    h.c.pathChanged('/iq/initiatives/p1');
    assert.equal(h.c.getSnapshot().pending!.confirmBy, 'click');
    await h.clock.advance(500);
    assert.equal(h.events('confirm-window-ended').length, 1);
    h.c.dispose();
  } finally { h.restore(); }
});

// The scripted session holds a new delegation while a call is open (G59, as the real API did), so these hand the
// frame to the client directly: the dock must still do the right thing if the voice ever opens one.
const deliver = (c: VoiceController, event: Record<string, unknown>) =>
  (c as unknown as { client: { deliver(data: string): void } }).client.deliver(JSON.stringify(event));

test('G66: a new delegation that is not the card\'s answer ends the spoken confirm', async () => {
  const h = await session(POST, [say(4000, 'open the people page'), say(9000, 'yes', 9000)]);
  try {
    await h.c.start();
    await h.clock.advance(4300);
    deliver(h.c, delegation(0, 'item_other').event);
    assert.equal(h.c.getSnapshot().pending!.confirmBy, 'click');
    await h.clock.advance(7000);
    assert.deepEqual(h.ran, []);
    assert.equal(h.events('confirm-window-ended')[0]?.['cause'], 'delegation');
    assert.equal(h.events('confirm-expired')[0]?.['cause'], 'delegation');
    h.c.dispose();
  } finally { h.restore(); }
});

test('G66: a delegation that follows the card\'s own "yes" decides it first', async () => {
  // The yes has not ended (no 700 ms of quiet yet) when the voice opens a delegation for it.
  const h = await session(POST, [say(4000, 'yes')]);
  try {
    await h.c.start();
    await h.clock.advance(4200);
    deliver(h.c, delegation(0, 'item_after_yes').event);
    await h.clock.advance(1500);
    assert.deepEqual(h.ran, ['message']);
    assert.equal(h.events('confirm-window-ended').length, 0);
    h.c.dispose();
  } finally { h.restore(); }
});

test('G66: a click-only card has no window: after 45 s a spoken yes is still the G40 click-required', async () => {
  const h = await session(START, [say(CARD_AT + VOICE_CONFIRM_WINDOW_MS + 3000, 'confirm')]);
  try {
    await h.c.start();
    await h.clock.advance(CARD_AT + VOICE_CONFIRM_WINDOW_MS + 5000);
    assert.deepEqual(h.ran, []);
    assert.equal(h.events('confirm-window-ended').length, 0);
    assert.equal(h.events('confirm-expired').length, 0);
    assert.equal(h.events('click-required').length, 1);
    h.c.dispose();
  } finally { h.restore(); }
});

test('G66: a card answered in time leaves no window timer behind', async () => {
  const h = await session(POST, [say(3000, 'confirm')]);
  try {
    await h.c.start();
    await h.clock.advance(5000);
    assert.deepEqual(h.ran, ['message']);
    await h.clock.advance(VOICE_CONFIRM_WINDOW_MS);
    assert.equal(h.events('confirm-window-ended').length, 0);
    h.c.dispose();
  } finally { h.restore(); }
});
