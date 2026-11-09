// G43 (session vs_f86d7b03, 00:42:55: eight calls over 28 s in one
// delegation): a delegation runs at most four calls; the next is refused
// too-many-calls with stop: true, the round asks for no continuation, and the
// dock says the line itself.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CALLS_PER_DELEGATION, TOO_MANY_LINE, VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { FakeClock, fakeFetch, loggedEvents, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000d7';
const D = 'item_mock_delegation_1';
const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: D, event });
const fc = (i: number, name: string, args: Record<string, unknown>) => ({ atMs: 600 + i * 50, event: env({ type: 'response.output_item.done', item: { id: `fc_${i}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: `call_${i}`, name } }) });

async function run(calls: Array<[string, Record<string, unknown>]>) {
  const clock = new FakeClock();
  const onStart = [
    { atMs: 0, event: { type: 'session.started', session: { id: 'live_x' } } },
    { atMs: 400, event: { type: 'session.input_transcript.delta', delta: 'find that message', start_ms: 0, end_ms: 900 } },
    { atMs: 500, event: { type: 'session.delegation.created', delegation: { id: D, type: 'delegation', response_id: 'r1', target: 'responses' } } },
    ...calls.map(([n, a], i) => fc(i, n, a)),
    { atMs: 600 + calls.length * 50 + 20, event: env({ type: 'response.completed', response: { id: 'r1', status: 'completed', output: [] } }) },
  ];
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, { sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['search', 'list'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: { onStart, onResponseCreate: [], onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested' } }] } }),
    route('GET', '/api/search', 200, { results: [], total: 0 }),
    route('GET', '/api/graph/projects', 200, []),
  ]);
  const outputs: Array<Record<string, unknown>> = [];
  const said: string[] = [];
  let responses = 0;
  const proto = VoiceClient.prototype;
  const orig = { out: proto.sendToolOutput, c: proto.appendCommentary, r: proto.requestResponse };
  proto.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.out.call(this, id, o); };
  proto.appendCommentary = function (t: string) { said.push(t); return orig.c.call(this, t); };
  proto.requestResponse = function () { responses++; return orig.r.call(this); };
  try {
    const c = new VoiceController({ fetch, media: null, toolContext: () => toolContext({ fetch }), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await c.start();
    await clock.advance(12_000);
    c.dispose();
    return { outputs, said, responses, log };
  } finally { Object.assign(proto, { sendToolOutput: orig.out, appendCommentary: orig.c, requestResponse: orig.r }); }
}

test('G43 + G59: six calls in one delegation: four run, the fifth and sixth are too-many-calls, and the round is still continued once', async () => {
  const lists: Array<[string, Record<string, unknown>]> = Array.from({ length: 6 }, (_, i) => ['list', { kind: 'initiative', filter: { q: `x${i}` } }]);
  const r = await run(lists);
  assert.equal(r.outputs.length, 6);
  assert.deepEqual(r.outputs.map((o) => o['kind']), ['list', 'list', 'list', 'list', 'refused', 'refused']);
  assert.equal(r.outputs[4]!['code'], 'too-many-calls');
  assert.equal(r.outputs[4]!['stop'], true);
  assert.equal(r.outputs[4]!['say'], TOO_MANY_LINE);
  // G59: the stopped round is continued (no continuation left the voice silent for good, vs_d69bbb23); the
  // continuation's own text says TOO_MANY_LINE, so the dock appends no commentary of its own.
  assert.equal(r.responses, 1, 'the stopped round is continued once');
  assert.equal(r.said.filter((s) => s.includes(TOO_MANY_LINE)).length, 0);
  const refusedEvents = loggedEvents(r.log).filter((e) => e['kind'] === 'refused').map((e) => (e['data'] as Record<string, unknown>)['reason']);
  assert.ok(refusedEvents.includes('too-many-calls'), JSON.stringify(loggedEvents(r.log).map((e) => e['kind'])));
  assert.equal(MAX_CALLS_PER_DELEGATION, 4);
});

test('G43: a search that only changes its query counts double', async () => {
  const s = (q: string): [string, Record<string, unknown>] => ['search', { query: q, type: 'person', scope: null, sort: 'recent', limit: null, answer: null }];
  // 1 + 2 = 3 used; the third search would make 5: refused.
  const r = await run([s('kubernetes'), s('k8s experts'), s('cluster people')]);
  assert.deepEqual(r.outputs.map((o) => o['kind']), ['search_results', 'search_results', 'refused']);
});
