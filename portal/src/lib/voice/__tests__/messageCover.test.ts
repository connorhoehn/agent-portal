// G67 (sweep 15): the G41 message cover is bounded like the G66 window. A
// conversation's cover lasts MESSAGE_COVER_MS since the last confirmed or
// covered post to it, ends when the location changes (the shell's pathChanged)
// or the voice itself navigates, and never carries a message the voice
// composed in a turn the user did not speak in. A lapsed cover shows the card
// again and logs `coverage-expired` with its cause (closed vocabulary, no
// target, no words).

import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_COVER_MS, VoiceController } from '../controller.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import type { ToolContext, VoiceToolPlanner, VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000f7';
const env = (d: string, event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
const heard = (at: number) => ({ atMs: at, event: { type: 'session.input_transcript.delta', delta: 'Post it.', start_ms: at, end_ms: at + 50 } });
function turn(at: number, n: number, name: string, args: Record<string, unknown>, said = true) {
  const d = `deleg_${n}`;
  return [
    ...(said ? [heard(at - 100)] : []),
    { atMs: at, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: `r${n}`, target: 'responses' } } },
    { atMs: at + 50, event: env(d, { type: 'response.output_item.done', item: { id: `fc_${n}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: `call_${n}`, name } }) },
    { atMs: at + 60, event: env(d, { type: 'response.completed', response: { id: `r${n}`, status: 'completed', output: [] } }) },
  ];
}
const post = (at: number, n: number, said = true) => turn(at, n, 'message', { target: { kind: 'channel', name: 'platform' }, text: `update ${n}` }, said);

async function session(frames: unknown[], over: Partial<ToolContext> = {}) {
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['message', 'open'], budget: { holdUsd: 5, usdPerMinute: 0.05 },
      mockScript: { onStart: [{ atMs: 0, event: { type: 'session.started', session: { id: 'live_x' } } }, ...frames], onResponseCreate: [], onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested' } }] } }),
  ]);
  const sent: string[] = [];
  const planner: VoiceToolPlanner = async (args) => ({ plan: { title: 'Post to #platform', detail: String(args['text']), data: { channel: 'social:ch:platform' } } });
  const message: VoiceToolRunner = async (a) => { sent.push(String(a['text'])); return { outcome: 'done', output: { kind: 'posted' }, summary: 'Posted' }; };
  // The voice's own navigation goes through the context's navigate, as the open runner's does.
  const open: VoiceToolRunner = async (_a, ctx) => { ctx.navigate('/iq/people'); return { outcome: 'done', output: { kind: 'navigated', path: '/iq/people', say: 'Opened People.', stop: true }, summary: 'Opened People' }; };
  const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch, ...over }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, message, open }, planners: { message: planner } });
  // The session log posts in batches (one request per 500 ms at most): let it flush before reading.
  const covered = async () => { await clock.advance(600, 100); return loggedEvents(log).filter((e) => e['kind'] === 'confirmed' && (e['data'] as Record<string, unknown>)['by'] === 'session').map((e) => e['data'] as Record<string, unknown>); };
  const expired = async () => { await clock.advance(600, 100); return loggedEvents(log).map((e) => (e['data'] ?? {}) as Record<string, unknown>).filter((d) => d['event'] === 'coverage-expired'); };
  return { c, clock, sent, covered, expired };
}

test('G67: the cover is one constant, 120 s', () => {
  assert.equal(MESSAGE_COVER_MS, 120_000);
});

test('G67: each post renews the cover; 120 s after the last one the card returns and the lapse is logged without words', async () => {
  const h = await session([
    ...post(500, 1),                       // card, clicked: covers #platform
    ...post(100_500, 2),                   // 100 s later: covered
    ...post(210_500, 3),                   // 110 s after the last covered post: still covered
    ...post(340_700, 4),                   // 130 s after it: the card again
    ...post(350_000, 5),                   // covered by the new card's call
  ]);
  await h.c.start();
  await h.clock.advance(1000);
  assert.ok(h.c.getSnapshot().pending, 'the first message shows its card');
  h.c.confirm('click');
  await h.clock.advance(339_000, 500);
  assert.equal(h.c.getSnapshot().pending, null, 'messages 2 and 3 rode the renewed cover');
  assert.deepEqual((await h.covered()).map((d) => [d['callId'], d['coveredBy']]), [['call_2', 'call_1'], ['call_3', 'call_1']]);
  await h.clock.advance(1000);
  const card = h.c.getSnapshot().pending;
  assert.equal(card?.title, 'Post to #platform', 'the lapsed cover shows the card again');
  assert.deepEqual((await h.expired()), [{ event: 'coverage-expired', tool: 'message', coveredBy: 'call_1', cause: 'timeout' }]);
  h.c.confirm('click');
  await h.clock.advance(10_000, 100);
  assert.equal(h.c.getSnapshot().pending, null);
  assert.deepEqual((await h.covered()).at(-1)!['coveredBy'], 'call_4', 'the card confirmed afresh is the cover now');
  assert.deepEqual(h.sent, ['update 1', 'update 2', 'update 3', 'update 4', 'update 5']);
  h.c.dispose();
});

test('G67: a change of page or of query ends the cover; the same location does not', async () => {
  const h = await session([...post(500, 1), ...post(3000, 2), ...post(6000, 3)]);
  h.c.pathChanged('/iq/initiatives/p1');
  await h.c.start();
  await h.clock.advance(1000);
  h.c.confirm('click');
  h.c.pathChanged('/iq/initiatives/p1');
  await h.clock.advance(2500);
  assert.equal(h.c.getSnapshot().pending, null, 'the same location keeps the cover');
  assert.equal((await h.covered()).length, 1);
  h.c.pathChanged('/iq/initiatives/p1?tab=decisions#top');
  assert.deepEqual((await h.expired()).map((d) => d['cause']), ['navigation']);
  // The hash alone is not a new location.
  h.c.pathChanged('/iq/initiatives/p1?tab=decisions#other');
  assert.equal((await h.expired()).length, 1);
  await h.clock.advance(3000);
  assert.equal(h.c.getSnapshot().pending?.title, 'Post to #platform', 'after the tab change the message asks again');
  assert.equal((await h.covered()).length, 1);
  h.c.dispose();
});

test('G67: the voice\'s own navigation ends the cover (cause open)', async () => {
  const h = await session([...post(500, 1), ...turn(3000, 2, 'open', { page: 'initiatives' }), ...post(6000, 3)]);
  h.c.pathChanged('/iq/initiatives/p1');
  await h.c.start();
  await h.clock.advance(1000);
  h.c.confirm('click');
  await h.clock.advance(3000);
  assert.deepEqual((await h.expired()).map((d) => d['cause']), ['open']);
  // The shell then reports the location the voice already took: nothing more ends.
  h.c.pathChanged('/iq/people');
  assert.equal((await h.expired()).length, 1);
  await h.clock.advance(3000);
  assert.equal(h.c.getSnapshot().pending?.title, 'Post to #platform');
  assert.equal((await h.covered()).length, 0);
  h.c.dispose();
});

test('G67: a message the voice composes after an inbound note, with no user utterance, shows a card', async () => {
  const h = await session([...post(500, 1), ...post(6000, 2, false), ...post(12_000, 3)]);
  await h.c.start();
  await h.clock.advance(1000);
  h.c.confirm('click');
  await h.clock.advance(2000);
  h.c.noteInbound({ id: 'm1', kind: 'message', sender: 'Sam', where: '#platform', channel: 'social:ch:platform', text: 'Any news?', at: 0 });
  await h.clock.advance(4000);
  assert.equal(h.c.getSnapshot().pending?.title, 'Post to #platform', 'no utterance in this turn: the card asks');
  assert.equal((await h.expired()).length, 0, 'the cover itself has not lapsed');
  h.c.confirm('click');
  await h.clock.advance(7000);
  assert.equal(h.c.getSnapshot().pending, null, 'the next message the user asked for rides the cover again');
  assert.equal((await h.covered()).length, 1);
  assert.equal((await h.covered())[0]!['callId'], 'call_3');
  h.c.dispose();
});
