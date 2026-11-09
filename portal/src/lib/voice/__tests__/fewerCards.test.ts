// G41 (owner, 9 November): two messages to the same channel in one session
// show one card; a message to another channel shows its own; an attachment
// or a click-only tool always asks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import type { VoiceToolPlanner, VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000e4';
const env = (d: string, event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
function turn(at: number, n: number, args: Record<string, unknown>) {
  const d = `deleg_${n}`;
  return [
    { atMs: at, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: `r${n}`, target: 'responses' } } },
    { atMs: at + 50, event: env(d, { type: 'response.output_item.done', item: { id: `fc_${n}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: `call_${n}`, name: 'message' } }) },
    { atMs: at + 60, event: env(d, { type: 'response.completed', response: { id: `r${n}`, status: 'completed', output: [] } }) },
  ];
}

test('G41: the second message to #platform needs no card; #general does; an attachment always asks', async () => {
  const msg = (name: string, extra: Record<string, unknown> = {}) => ({ target: { kind: 'channel', name }, text: `hello ${name}`, ...extra });
  const onStart = [
    { atMs: 0, event: { type: 'session.started', session: { id: 'live_x' } } },
    ...turn(500, 1, msg('platform')),
    ...turn(3000, 2, msg('platform')),
    ...turn(5000, 3, msg('general')),
    ...turn(8000, 4, msg('platform', { attach: '1' })),
  ];
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['message'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: { onStart, onResponseCreate: [], onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested' } }] } }),
  ]);
  const sent: string[] = [];
  const planner: VoiceToolPlanner = async (args) => {
    const name = String((args['target'] as Record<string, unknown>)['name']);
    return { plan: { title: `Post to #${name}`, detail: String(args['text']), data: { channel: `social:ch:${name}`, ...(args['attach'] ? { attachment: { id: 'w-1' } } : {}) } } };
  };
  const runner: VoiceToolRunner = async (_a, _c, plan) => { sent.push((plan as { channel: string }).channel); return { outcome: 'done', output: { kind: 'posted' }, summary: 'Posted' }; };
  const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, message: runner }, planners: { message: planner } });
  const cards: string[] = [];
  c.subscribe(() => { const p = c.getSnapshot().pending; if (p && cards.at(-1) !== `${p.requestId}`) { cards.push(`${p.requestId}`); setTimeout(() => {}, 0); } });
  await c.start();
  await clock.advance(1000); assert.ok(c.getSnapshot().pending); c.confirm('click');
  await clock.advance(2500); assert.equal(c.getSnapshot().pending, null, 'the second #platform message shows no card');
  assert.deepEqual(sent, ['social:ch:platform', 'social:ch:platform']);
  await clock.advance(2000); assert.equal(c.getSnapshot().pending?.title, 'Post to #general'); c.confirm('click');
  await clock.advance(3000); assert.equal(c.getSnapshot().pending?.title, 'Post to #platform', 'an attachment asks again'); c.confirm('click');
  await clock.advance(3000);
  assert.deepEqual(sent, ['social:ch:platform', 'social:ch:platform', 'social:ch:general', 'social:ch:platform']);
  assert.equal(cards.length, 3, 'three cards for four messages');
  const covered = loggedEvents(log).filter((e) => e['kind'] === 'confirmed' && (e['data'] as Record<string, unknown>)['by'] === 'session');
  assert.equal(covered.length, 1);
  assert.equal((covered[0]!['data'] as Record<string, unknown>)['coveredBy'], 'call_1');
  c.dispose();
});

test('G41 x G48: a retried message never reuses the session cover, and a failed post clears it', async () => {
  const msg = (text: string) => ({ target: { kind: 'channel', name: 'platform' }, text });
  const heard = (at: number, words: string) => ({ atMs: at, event: { type: 'session.input_transcript.delta', delta: words, start_ms: at, end_ms: at + 500 } });
  const onStart = [
    { atMs: 0, event: { type: 'session.started', session: { id: 'live_x' } } },
    ...turn(500, 1, msg('first')),      // card, confirmed, posted: covers #platform
    heard(2900, 'Post the second one.'),
    ...turn(3000, 2, msg('second')),    // covered, no card, the transport fails
    heard(5900, 'Try again.'),
    ...turn(6000, 3, msg('second')),    // the retry must show a card
  ];
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['message'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: { onStart, onResponseCreate: [], onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested' } }] } }),
  ]);
  const planner: VoiceToolPlanner = async (args) => ({ plan: { title: 'Post to #platform', detail: String(args['text']), data: { channel: 'social:ch:platform' } } });
  const ran: string[] = [];
  const runner: VoiceToolRunner = async (_a, _c, plan) => {
    ran.push(String((plan as { channel: string }).channel));
    return ran.length === 2 ? { outcome: 'failed', output: { kind: 'failed', code: 'http-500' }, summary: 'Failed' } : { outcome: 'done', output: { kind: 'posted' }, summary: 'Posted' };
  };
  const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, message: runner }, planners: { message: planner } });
  await c.start();
  await clock.advance(1000); assert.ok(c.getSnapshot().pending, 'the first message shows its card'); c.confirm('click');
  await clock.advance(2500); assert.equal(c.getSnapshot().pending, null, 'success covered the channel: the second message shows no card');
  assert.equal(ran.length, 2, 'the covered post ran and failed');
  await clock.advance(3000);
  assert.equal(c.getSnapshot().pending?.title, 'Post to #platform', 'the retry of the failed post shows a card');
  assert.equal(ran.length, 2, 'and waits for the click');
  c.confirm('click');
  await clock.advance(1000);
  assert.equal(ran.length, 3);
  const covered = loggedEvents(log).filter((e) => e['kind'] === 'confirmed' && (e['data'] as Record<string, unknown>)['by'] === 'session');
  assert.equal(covered.length, 1, 'only the first follow-up rode the cover');
  c.dispose();
});
