// G67 (sweep 15, L3): the location a card opened on is the path and the query
// (never the hash), so a new tab or search query ends a card's spoken confirm
// (G66) as a new page does. The voice's own navigation is taken when its tool
// runs: a card a later call of the same delegation opens (after
// `open {scope:'this-page', tab}`) opens on the new location, and the shell's
// pathChanged for that navigation, arriving after the card, does not expire it.
// A navigation that ends the request (G51) leaves no card to open in that turn.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController, locationKey } from '../controller.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import type { ToolContext, VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000f8';
const INITIATIVE = '/iq/initiatives/p1';
const env = (d: string, event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
const say = (at: number, delta: string) => ({ atMs: at, event: { type: 'session.input_transcript.delta', delta, start_ms: at, end_ms: at + 300 } });
const delegation = (at: number, d: string) => ({ atMs: at, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: `r_${d}`, target: 'responses' } } });
const call = (at: number, d: string, n: number, name: string, args: Record<string, unknown>) => [
  { atMs: at, event: env(d, { type: 'response.output_item.done', item: { id: `fc_${n}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: `call_${n}`, name } }) },
  { atMs: at + 10, event: env(d, { type: 'response.completed', response: { id: `r_${d}_${n}`, status: 'completed', output: [] } }) },
];
const POST = { target: { kind: 'channel', name: 'platform' }, text: 'Decisions are in.' };

async function session(frames: unknown[], over: Partial<ToolContext> = {}) {
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['message', 'open'], budget: { holdUsd: 5, usdPerMinute: 0.05 },
      mockScript: { onStart: [{ atMs: 0, event: { type: 'session.started', session: { id: 'live_x' } } }, ...frames], onResponseCreate: [], onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested' } }] } }),
  ]);
  const ran: string[] = [];
  const message: VoiceToolRunner = async () => { ran.push('message'); return { outcome: 'done', output: { kind: 'posted' }, summary: 'Posted' }; };
  const ctx = toolContext({ fetch, tabs: () => ({ path: INITIATIVE, tab: 'work', tabs: ['work', 'decisions', 'people'] }), ...over });
  const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, message }, planners: {} });
  const events = async (name: string) => { await clock.advance(600, 100); return loggedEvents(log).map((e) => (e['data'] ?? {}) as Record<string, unknown>).filter((d) => d['event'] === name); };
  return { c, clock, ran, ctx, events, log };
}

test('G67: a location is its path and query, never its hash', () => {
  assert.equal(locationKey('/iq/initiatives/p1?tab=decisions#x'), '/iq/initiatives/p1?tab=decisions');
  assert.equal(locationKey('/iq/search?q=alpha'), '/iq/search?q=alpha');
  assert.equal(locationKey('/iq/people?'), '/iq/people');
  assert.notEqual(locationKey('/iq/search?q=alpha'), locationKey('/iq/search?q=beta'));
});

test('G67: a new tab (the query) ends the card\'s spoken confirm; a new hash does not', async () => {
  const h = await session([say(400, 'Tell platform the decisions are in.'), delegation(500, 'd1'), ...call(550, 'd1', 1, 'message', POST), say(8000, 'okay')]);
  h.c.pathChanged(INITIATIVE);
  await h.c.start();
  await h.clock.advance(1500);
  assert.equal(h.c.getSnapshot().pending!.confirmBy, 'voice');
  h.c.pathChanged(`${INITIATIVE}#notes`);
  assert.equal(h.c.getSnapshot().pending!.confirmBy, 'voice', 'the hash is not a new location');
  h.c.pathChanged(`${INITIATIVE}?tab=people`);
  assert.equal(h.c.getSnapshot().pending!.confirmBy, 'click');
  await h.clock.advance(8000);
  assert.deepEqual(h.ran, [], 'the later "okay" sends nothing');
  assert.deepEqual((await h.events('confirm-window-ended')).map((d) => d['cause']), ['navigation']);
  h.c.dispose();
});

test('G67: a search query change ends it too', async () => {
  const h = await session([say(400, 'Tell platform the decisions are in.'), delegation(500, 'd1'), ...call(550, 'd1', 1, 'message', POST)]);
  h.c.pathChanged('/iq/search?q=alpha&tab=results');
  await h.c.start();
  await h.clock.advance(1500);
  h.c.pathChanged('/iq/search?q=beta&tab=results');
  assert.equal(h.c.getSnapshot().pending!.confirmBy, 'click');
  h.c.dispose();
});

test('G67: the voice\'s own tab open, then a card in the same delegation: the shell\'s late pathChanged does not expire it', async () => {
  // "Open decisions and tell platform they are in": open {scope this-page, tab} (no stop), then message.
  const h = await session([
    say(400, 'Open decisions and tell platform they are in.'),
    delegation(500, 'd1'),
    ...call(550, 'd1', 1, 'open', { scope: 'this-page', tab: 'decisions' }),
    ...call(1500, 'd1', 2, 'message', POST),
    say(4000, 'yes'),
  ]);
  h.c.pathChanged(INITIATIVE);
  await h.c.start();
  await h.clock.advance(1000);
  // The open ran (and navigated) before the card: the order the dock relies on.
  assert.deepEqual((h.ctx as unknown as { navigations: string[] }).navigations, [`${INITIATIVE}?tab=decisions`]);
  assert.equal(h.c.getSnapshot().pending, null, 'no card before the navigation');
  await h.clock.advance(1000);
  const card = h.c.getSnapshot().pending!;
  assert.ok(card, 'the message card opened after the tab');
  // The router's effect lands after the card opened, with the location the voice already took.
  h.c.pathChanged(`${INITIATIVE}?tab=decisions`);
  assert.equal(h.c.getSnapshot().pending!.confirmBy, 'voice', 'the card the same delegation opened keeps its spoken confirm');
  await h.clock.advance(3000);
  assert.deepEqual(h.ran, ['message'], 'the spoken yes confirmed it');
  assert.equal((await h.events('confirm-window-ended')).length, 0);
  h.c.dispose();
});

test('G67 x G51: after a navigation that ends the request, no card opens in that turn', async () => {
  const h = await session([
    say(400, 'Open the initiatives and tell platform.'),
    delegation(500, 'd1'),
    ...call(550, 'd1', 1, 'open', { page: 'initiatives' }),
    ...call(1500, 'd1', 2, 'message', POST),
  ]);
  h.c.pathChanged(INITIATIVE);
  await h.c.start();
  await h.clock.advance(2500);
  assert.equal(h.c.getSnapshot().pending, null);
  assert.deepEqual(h.ran, []);
  const refused = loggedEvents(h.log).filter((e) => e['kind'] === 'refused').map((e) => (e['data'] as Record<string, unknown>)['reason']);
  assert.deepEqual(refused, ['navigated']);
  h.c.dispose();
});
