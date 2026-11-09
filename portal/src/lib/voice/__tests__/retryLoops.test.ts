// G29 (docs/voice-navigator-gaps.md, the 23:03 session): every refusal names
// what to change, and the second identical refused call of a session is
// terminal: no third call runs. G59: the terminal round is still continued
// (the continuation says the refusal), or the voice falls silent for good.

import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RUNAWAY_CONTINUATIONS, MAX_RUNAWAY_RESTARTS, MAX_STOPPED_CONTINUATIONS, RUNAWAY_STOPPED_LINE, VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { runVoiceTool } from '../tools.ts';
import { FAILED_TWICE_NEXT, FailureGuard, NO_REPEAT, RETRY_NEXT, STOP_NEXT, RefusalGuard, callKey, refusalNext } from '../refusals.ts';
import { REFUSAL_CODES } from '../sessionEvents.ts';
import { listKinds } from '../catalogue.ts';
import { FakeClock, fakeFetch, isToolRow, loggedEvents, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000ab';
/** How many continuations a scripted model keeps calling in (past MAX_STOPPED_CONTINUATIONS), before it lets the round end. */
const REPEATS = 2 + MAX_STOPPED_CONTINUATIONS;

test('refusalNext: every refusal code names a change and ends with the no-repeat rule', () => {
  const reasons: Record<string, Record<string, unknown>> = {
    ambiguous: { kind: 'ambiguous', reason: 'Several match.' },
    'not-found': { reason: 'I found no initiative called "Zeta".' },
    role: { reason: 'Your role cannot read the fleet of computers.' },
    'no-grant': { reason: "You don't have Social access here. I can open the access request.", hint: { item: 'role:social:moderator' } },
    budget: { reason: 'That is over your budget.' },
    allowlist: { reason: 'That command is not on the allowlist.' },
    'not-on-this-page': { reason: 'This page shows no rows I can read.', code: 'not-on-this-page' },
    'other-workspace': { reason: 'That is in another workspace.' },
    'card-open': { reason: 'Another action is waiting for the user to confirm. Ask again after it.' },
    unavailable: { reason: 'Presence is not connected right now. Try again in a moment.' },
    'not-connected': { reason: 'Social is not connected right now. Try again in a moment.', code: 'not-connected' },
    'not-a-member': { reason: 'You are not a member of #General.', code: 'not-a-member' },
    'invalid-arguments': { reason: 'I could not use those details: "kind" must be one of the listed values.' },
    'unknown-tool': { reason: 'There is no "teleport" tool.' },
    'not-in-workspace': { reason: 'computer is not available in this workspace.' },
    'read-failed': { reason: 'The bots could not read (HTTP 500).', code: 'read-failed' },
    'invalid-ref': { reason: 'That is not a message this session has seen.', code: 'invalid-ref' },
    'not-read-yet': { reason: 'There is no row 4 in the last result. List or search first.' },
    'too-many-calls': { reason: 'Too many calls for one request.', code: 'too-many-calls' },
    'repeat-failed': { reason: 'That just failed. Tell the user why; try again only when they ask.', code: 'repeat-failed' },
    navigated: { reason: 'This request already opened a page, so nothing more runs for it.', code: 'navigated' },
    'not-dispatchable': { reason: '"Rotate keys" cannot be dispatched: size this item first.', code: 'not-dispatchable' },
    'not-on-initiative': { reason: '"Rotate keys" is not work of Alpha you can dispatch.', code: 'not-on-initiative' },
    other: { reason: 'Something odd.' },
  };
  assert.deepEqual(Object.keys(reasons).sort(), [...REFUSAL_CODES].sort(), 'one case per code');
  for (const [code, output] of Object.entries(reasons)) {
    const next = refusalNext('summary', output, { tenant: 'orgiq', role: 'sme' });
    assert.ok(next.endsWith(NO_REPEAT), `${code}: ${next}`);
    assert.ok(next.length > NO_REPEAT.length + 20, `${code} names a change: ${next}`);
  }
  // The four shapes the 23:03 session needed.
  assert.match(refusalNext('get', { reason: 'Pass a row\'s ref as a result gave it, such as "initiative:<id>", or its position.' }, { tenant: 'orgiq' }), /kind:id/);
  assert.match(refusalNext('list', { reason: 'There is no "ticket" list in this workspace.' }, { tenant: 'access' }), new RegExp(`The kinds here: ${listKinds('access').join(', ')}\\.`));
  assert.match(refusalNext('message', { reason: 'There is no person called "Ada" you can post to.' }, { tenant: 'orgiq' }), /Name one person/);
  assert.match(refusalNext('message', { reason: "You don't have Social access here. I can open the access request.", hint: {} }, { tenant: 'orgiq' }), /ask for access/);
});

test('a runner\'s refusal reaches the model with `next`; a done result carries none', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/graph/projects', 200, [])]);
  const ctx = toolContext({ fetch });
  const r = await runVoiceTool('get', { ref: 'Alpha' }, ctx);
  assert.equal(r.outcome, 'refused');
  assert.match(String(r.output['next']), /kind:id/);
  const bad = await runVoiceTool('list', { kind: 'ticket' }, ctx);
  assert.equal(bad.outcome, 'refused');
  assert.match(String(bad.output['next']), /kinds here/);
  const ok = await runVoiceTool('list', { kind: 'initiative' }, ctx);
  assert.equal(ok.outcome, 'done');
  assert.equal(ok.output['next'], undefined);
});

test('RefusalGuard: the second identical refused call is terminal and speaks once; other arguments and card-open never count', () => {
  const g = new RefusalGuard();
  const out = { reason: 'I found no initiative "nope" that you can read.' };
  assert.deepEqual(g.refused('get', { ref: 'initiative:nope', part: null }, out), { terminal: false, speak: false });
  assert.deepEqual(g.refused('get', { ref: 'initiative:other' }, out), { terminal: false, speak: false }, 'other arguments');
  // The raw string and the prepared arguments of one call agree (nulls are "not given").
  assert.equal(callKey('get', '{"ref":"initiative:nope","part":null}'), callKey('get', { ref: 'initiative:nope' }));
  assert.deepEqual(g.refused('get', '{"part":null,"ref":"initiative:nope"}', out), { terminal: true, speak: true });
  assert.deepEqual(g.refused('get', { ref: 'initiative:nope' }, out), { terminal: true, speak: false }, 'spoken once');
  const card = { reason: 'Another action is waiting for the user to confirm. Ask again after it.' };
  g.refused('message', { text: 'hi' }, card);
  assert.equal(g.refused('message', { text: 'hi' }, card).terminal, false);
});

/**
 * A scripted session whose delegation asks for `get` again after every continuation: the retry loop of 23:03.
 * `repeats`: after that many continuations the model stops calling and the continuation only completes (G64).
 */
function retryScript(args: Record<string, unknown>, repeats = Infinity) {
  const d = 'item_mock_delegation_1';
  const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
  const call = (n: number) => env({ type: 'response.output_item.done', item: { id: `fc_${n}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: `call_${n}`, name: 'get' }, output_index: 0 });
  return {
    onStart: [
      { atMs: 0, event: { type: 'session.started', session: { id: 'live_mock', model: 'gpt-live-1', status: 'active' } } },
      { atMs: 400, event: { type: 'session.input_transcript.delta', delta: 'Read the Zeta initiative.', start_ms: 0, end_ms: 1800 } },
      { atMs: 500, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: 'resp_1', target: 'responses' } } },
      { atMs: 1000, event: call(1) },
      { atMs: 1050, event: env({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 1000, output_tokens: 20 } } }) },
    ],
    // Every continuation retries the identical call (a fresh call id each time it plays would not change the args).
    onResponseCreate: Number.isFinite(repeats) ? [
      { atMs: 200, event: env({ type: 'response.completed', response: { id: 'resp_end', status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ] : [
      { atMs: 150, event: call(2) },
      { atMs: 200, event: env({ type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ],
    ...(Number.isFinite(repeats) ? { onResponseCreateSeq: Array.from({ length: repeats }, (_, i) => [
      { atMs: 150, event: call(2 + i) },
      { atMs: 200, event: env({ type: 'response.completed', response: { id: `resp_${2 + i}`, status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ]) } : {}),
    onClose: [{ atMs: 100, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 12 } } }],
  };
}

test('G29 + G59 acceptance: a scripted session that refuses get twice with the same ref runs no third call, and the stopped round is still continued', async () => {
  const outputs: Array<Record<string, unknown>> = [];
  const commentary: string[] = [];
  let continuations = 0;
  const proto = VoiceClient.prototype;
  const orig = { out: proto.sendToolOutput, com: proto.appendCommentary, resp: proto.requestResponse };
  proto.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.out.call(this, id, o); };
  proto.appendCommentary = function (c: string) { commentary.push(c); return orig.com.call(this, c); };
  proto.requestResponse = function () { continuations += 1; return orig.resp.call(this); };
  try {
    const clock = new FakeClock();
    const mintBody = {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['get'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      // The model asks again four times (two past MAX_STOPPED_CONTINUATIONS), then lets the round end.
      mockScript: retryScript({ ref: 'initiative:nope', part: null }, 2 + MAX_STOPPED_CONTINUATIONS),
    };
    const { fetch, log } = fakeFetch([
      route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
      route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
      route('POST', '/api/voice/sessions', 201, mintBody),
      route('GET', '/api/graph/projects/nope', 404, { error: 'not found' }),
    ]);
    const ctx = toolContext({ fetch });
    const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await c.start();
    await clock.advance(6000);

    assert.equal(outputs[0]!['kind'], 'refused');
    assert.match(String(outputs[0]!['next']), /kind:id|list or search/);
    assert.equal(outputs[0]!['stop'], undefined);
    assert.equal(outputs[1]!['stop'], true);
    assert.equal(outputs[1]!['next'], STOP_NEXT);
    // G59 + G64: the stopped round is continued; each later call is refused before it runs (stop), and every output
    // is continued, past MAX_STOPPED_CONTINUATIONS too (G64: the dock never lets a delegation go uncontinued).
    assert.equal(outputs.length, 3 + MAX_STOPPED_CONTINUATIONS);
    assert.equal(continuations, outputs.length, 'one continuation per output, none skipped');
    assert.ok(outputs.slice(2).every((o) => o['kind'] === 'refused' && o['stop'] === true), JSON.stringify(outputs.slice(2)));
    assert.equal(log.filter((r) => r.url.startsWith('/api/graph/projects/nope')).length, 2, 'no third call runs');
    assert.equal(commentary.length, 0, 'the continuation says the refusal; the dock adds nothing');
    assert.equal(c.getSnapshot().phase === 'executing', false, 'the delegation is closed');
    // The refusals are on the log with their code, the repeat is marked, and the dock giving up is too.
    const events = loggedEvents(log);
    assert.equal(events.filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'refusal-repeated').length, 1);
    assert.equal(events.filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'delegation-stuck').length, 1);
    assert.equal(log.filter((r) => isToolRow(r)).length, outputs.length);
    c.dispose();
  } finally {
    proto.sendToolOutput = orig.out; proto.appendCommentary = orig.com; proto.requestResponse = orig.resp;
  }
});

test('G64: a model that never stops calling is continued every time, then the session restarts (`runaway`) rather than going deaf', async () => {
  let continuations = 0, outputs = 0;
  const restarts: Array<{ cause: string; outputs: number }> = [];
  const proto = VoiceClient.prototype;
  const orig = { out: proto.sendToolOutput, resp: proto.requestResponse, restart: VoiceController.prototype.restart };
  proto.sendToolOutput = function (id: string, o: string) { outputs += 1; return orig.out.call(this, id, o); };
  proto.requestResponse = function () { continuations += 1; return orig.resp.call(this); };
  // The restart itself is G61's (tested in silence.test.ts); here only when it is asked for.
  VoiceController.prototype.restart = async function (cause?: 'unanswered' | 'runaway') { restarts.push({ cause: cause ?? 'unanswered', outputs }); };
  try {
    const clock = new FakeClock();
    const { fetch } = fakeFetch([
      route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
      route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
      route('POST', '/api/voice/sessions', 201, {
        sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
        model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['get'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
        mockScript: retryScript({ ref: 'initiative:nope' }),
      }),
      route('GET', '/api/graph/projects/nope', 404, { error: 'not found' }),
    ]);
    const ctx = toolContext({ fetch });
    const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await c.start();
    await clock.advance(6000);
    // Outputs: the first refusal, the terminal repeat, then one per stopped continuation up to the cap.
    assert.deepEqual(restarts, [{ cause: 'runaway', outputs: 2 + MAX_RUNAWAY_CONTINUATIONS }]);
    assert.equal(continuations, 1 + MAX_RUNAWAY_CONTINUATIONS, 'every output before the cap was continued');
    c.dispose();
  } finally {
    proto.sendToolOutput = orig.out; proto.requestResponse = orig.resp; VoiceController.prototype.restart = orig.restart;
  }
});

test('Sweep 8: one automatic runaway restart per resume chain; the second ends the session unavailable and only a click starts it again', async () => {
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['get'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: retryScript({ ref: 'initiative:nope' }),
    }),
    route('GET', '/api/graph/projects/nope', 404, { error: 'not found' }),
  ]);
  const ctx = toolContext({ fetch });
  const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const mints = () => log.filter((r) => r.method === 'POST' && r.url === '/api/voice/sessions').length;
  await c.start();
  await clock.advance(30_000);
  assert.equal(MAX_RUNAWAY_RESTARTS, 1);
  assert.equal(mints(), 1 + MAX_RUNAWAY_RESTARTS, 'one automatic restart, then no more mints');
  assert.equal(c.getSnapshot().phase, 'unavailable');
  assert.equal(c.getSnapshot().reason, RUNAWAY_STOPPED_LINE);
  await clock.advance(30_000);
  assert.equal(mints(), 1 + MAX_RUNAWAY_RESTARTS, 'nothing restarts by itself');
  // A click is a new chain: it may be restarted once again.
  await c.start();
  await clock.advance(30_000);
  assert.equal(mints(), 2 + 2 * MAX_RUNAWAY_RESTARTS, 'the click starts a session and its chain gets one restart');
  assert.equal(c.getSnapshot().phase, 'unavailable');
  c.dispose();
});

test('G48 FailureGuard: a failure may be retried once in a later turn; never in the same turn, never a third time', () => {
  const g = new FailureGuard();
  const t1 = {}, t2 = {}, t3 = {};
  assert.equal(g.check('get', { ref: 'initiative:p1' }, t1), null, 'nothing failed yet');
  assert.deepEqual(g.failed('get', { ref: 'initiative:p1' }, t1), { last: false });
  assert.equal(g.check('get', { ref: 'initiative:p1' }, t1)?.code, 'repeat-failed', 'the model retrying on its own');
  assert.equal(g.check('get', { ref: 'initiative:p2' }, t1), null, 'other arguments');
  assert.equal(g.check('get', '{"ref":"initiative:p1","part":null}', t2), null, 'the user asked again: one retry runs');
  assert.deepEqual(g.failed('get', { ref: 'initiative:p1' }, t2), { last: true });
  assert.match(g.check('get', { ref: 'initiative:p1' }, t3)!.reason, /failed twice/);
  g.succeeded('get', { ref: 'initiative:p1' });
  assert.equal(g.check('get', { ref: 'initiative:p1' }, t3), null, 'a landed call starts again');
});

/** A scripted session: `get` once; every continuation asks it again, after the user's words when `userAsks`. */
function failScript(args: Record<string, unknown>, userAsks: boolean) {
  const d = 'item_mock_delegation_1';
  const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
  let n = 0;
  const call = () => env({ type: 'response.output_item.done', item: { id: `fc_${++n}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(args), call_id: `call_${n}`, name: 'get' }, output_index: 0 });
  const first = call();
  const again = call();
  return {
    onStart: [
      { atMs: 0, event: { type: 'session.started', session: { id: 'live_mock', model: 'gpt-live-1', status: 'active' } } },
      { atMs: 400, event: { type: 'session.input_transcript.delta', delta: 'Read Alpha.', start_ms: 0, end_ms: 1800 } },
      { atMs: 500, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: 'resp_1', target: 'responses' } } },
      { atMs: 1000, event: first },
      { atMs: 1050, event: env({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 1000, output_tokens: 20 } } }) },
    ],
    // The model asks again on each of the first REPEATS continuations, then lets the round end (G64: it must end).
    onResponseCreate: [
      { atMs: 200, event: env({ type: 'response.completed', response: { id: 'resp_end', status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ],
    onResponseCreateSeq: Array.from({ length: REPEATS }, () => [
      ...(userAsks ? [{ atMs: 50, event: { type: 'session.input_transcript.delta', delta: 'Try again.', start_ms: 3000, end_ms: 3600 } }] : []),
      { atMs: 150, event: again },
      { atMs: 200, event: env({ type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ]),
    onClose: [{ atMs: 100, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 12 } } }],
  };
}

async function failSession(userAsks: boolean, status = 500) {
  const outputs: Array<Record<string, unknown>> = [];
  const proto = VoiceClient.prototype;
  const orig = proto.sendToolOutput;
  proto.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.call(this, id, o); };
  try {
    const clock = new FakeClock();
    const mintBody = {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['get'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: failScript({ ref: 'initiative:p1' }, userAsks),
    };
    let reads = 0;
    const { fetch } = fakeFetch([
      route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
      route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
      route('POST', '/api/voice/sessions', 201, mintBody),
      (req) => (req.method === 'GET' && req.url.startsWith('/api/graph/projects/p1') ? (reads++, { status, body: { error: 'boom' } }) : undefined),
    ]);
    const ctx = toolContext({ fetch });
    const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await c.start();
    await clock.advance(6000);
    c.dispose();
    return { outputs, reads };
  } finally {
    proto.sendToolOutput = orig;
  }
}

test('G48 acceptance: failed then the same call runs once the user asked; on its own it is refused; a refusal repeated is refused as a repeat', async () => {
  const asked = await failSession(true);
  assert.equal(asked.outputs[0]!['kind'], 'failed');
  assert.equal(asked.outputs[0]!['next'], RETRY_NEXT);
  assert.equal(asked.outputs[1]!['kind'], 'failed', 'the retry ran');
  assert.equal(asked.reads >= 2, true, 'the retry read again');
  assert.equal(asked.outputs[1]!['next'], FAILED_TWICE_NEXT);
  assert.equal(asked.outputs[1]!['stop'], true);
  const own = await failSession(false);
  assert.equal(own.outputs[0]!['kind'], 'failed');
  assert.equal(own.outputs[1]!['kind'], 'refused', 'the model\'s own retry is refused');
  assert.equal(own.outputs[1]!['code'], 'repeat-failed');
  assert.equal(own.reads, asked.reads / 2, 'and read nothing');
  // A refusal (404) repeated is still the G29 repeat, user turn or not.
  const refusedTwice = await failSession(true, 404);
  assert.deepEqual(refusedTwice.outputs.slice(0, 2).map((o) => [o['kind'], o['stop'] ?? null]), [['refused', null], ['refused', true]]);
  // G59: the stopped round is continued; what the script's delegation calls after it is refused before it runs.
  assert.ok(refusedTwice.outputs.slice(2).every((o) => o['kind'] === 'refused' && o['stop'] === true));
});

/** A scripted turn: the first call, then each continuation asks the second (the 01:40 turn that opened four pages). */
function twoCallScript(first: { name: string; args: Record<string, unknown> }, second: { name: string; args: Record<string, unknown> }) {
  const d = 'item_mock_delegation_1';
  const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
  const call = (n: number, c: { name: string; args: Record<string, unknown> }) => env({ type: 'response.output_item.done', item: { id: `fc_${n}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(c.args), call_id: `call_${n}`, name: c.name }, output_index: 0 });
  return {
    onStart: [
      { atMs: 0, event: { type: 'session.started', session: { id: 'live_mock', model: 'gpt-live-1', status: 'active' } } },
      { atMs: 400, event: { type: 'session.input_transcript.delta', delta: 'Open designs and runbooks.', start_ms: 0, end_ms: 1800 } },
      { atMs: 500, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: 'resp_1', target: 'responses' } } },
      { atMs: 1000, event: call(1, first) },
      { atMs: 1050, event: env({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 1000, output_tokens: 20 } } }) },
    ],
    onResponseCreate: [
      { atMs: 200, event: env({ type: 'response.completed', response: { id: 'resp_end', status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ],
    onResponseCreateSeq: Array.from({ length: REPEATS }, () => [
      { atMs: 150, event: call(2, second) },
      { atMs: 200, event: env({ type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ]),
    onClose: [{ atMs: 100, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 12 } } }],
  };
}

async function twoCalls(first: { name: string; args: Record<string, unknown> }, second: { name: string; args: Record<string, unknown> }, over: Parameters<typeof toolContext>[0] = {}) {
  const outputs: Array<Record<string, unknown>> = [];
  const commentary: string[] = [];
  const proto = VoiceClient.prototype;
  const orig = { out: proto.sendToolOutput, com: proto.appendCommentary };
  proto.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.out.call(this, id, o); };
  proto.appendCommentary = function (c: string) { commentary.push(c); return orig.com.call(this, c); };
  try {
    const clock = new FakeClock();
    const mintBody = {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['open', 'list'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
      mockScript: twoCallScript(first, second),
    };
    const { fetch } = fakeFetch([
      route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
      route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
      route('POST', '/api/voice/sessions', 201, mintBody),
    ]);
    const ctx = toolContext({ fetch, role: 'org-leader', ...over });
    const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
    await c.start();
    await clock.advance(6000);
    c.dispose();
    return { outputs, commentary, navigations: ctx.navigations };
  } finally {
    proto.sendToolOutput = orig.out; proto.appendCommentary = orig.com;
  }
}

test('G51 + G59 acceptance: a turn asking for two pages opens the first and stops; the refusal carries the page line for the continuation', async () => {
  const r = await twoCalls({ name: 'open', args: { page: 'designs' } }, { name: 'open', args: { page: 'runbooks' } });
  assert.equal(r.outputs[0]!['kind'], 'navigated');
  assert.equal(r.outputs[0]!['stop'], true);
  assert.match(String(r.outputs[0]!['say']), /^Opened /);
  assert.equal(r.outputs[1]!['kind'], 'refused');
  assert.equal(r.outputs[1]!['code'], 'navigated');
  assert.equal(r.outputs[1]!['stop'], true);
  assert.equal(r.outputs[1]!['say'], r.outputs[0]!['say'], 'the continuation is handed the page line to say');
  assert.equal(r.navigations.length, 1, 'the second page never opens');
  assert.equal(r.commentary.length, 0, 'G59: the continuation says the line; the dock adds none');
});

test('G51: a get of the record just opened, by its ref, is a read of that page (vs_5144e356 13:29:44)', async () => {
  const page = { path: '/iq/projects/p1', record: { ref: 'initiative:p1', title: 'Alpha' }, rows: [] };
  const r = await twoCalls({ name: 'open', args: { ref: 'initiative:p1' } }, { name: 'get', args: { ref: 'initiative:p1', part: 'decisions' } }, { page: () => page });
  assert.equal(r.outputs[0]!['stop'], true);
  assert.notEqual(r.outputs[1]!['code'], 'navigated', JSON.stringify(r.outputs[1]));
  const other = await twoCalls({ name: 'open', args: { ref: 'initiative:p1' } }, { name: 'get', args: { ref: 'initiative:p2', part: 'decisions' } }, { page: () => page });
  assert.equal(other.outputs[1]!['code'], 'navigated', 'another record is still another request');
});

test('G51: a read of the page just opened may follow; a row or tab of the page in view does not end the turn', async () => {
  const page = { path: '/iq/projects/p1', record: { ref: 'initiative:p1', title: 'Alpha' }, rowsLabel: 'work items', rows: [{ ref: 'work-item:w1', title: 'Rotate keys', href: '/iq/projects/p1?item=w1' }] };
  const read = await twoCalls({ name: 'open', args: { ref: 'initiative:p1' } }, { name: 'list', args: { kind: 'work-item', scope: 'this-page' } }, { page: () => page });
  assert.equal(read.outputs[0]!['stop'], true);
  assert.equal(read.outputs[1]!['kind'], 'list', 'the this-page read runs');
  const onPage = await twoCalls({ name: 'open', args: { scope: 'this-page', ref: '1' } }, { name: 'open', args: { page: 'runbooks' } }, { page: () => page });
  assert.equal(onPage.outputs[0]!['stop'], undefined, 'a row of the page in view does not end the request');
  assert.equal(onPage.outputs[1]!['kind'], 'navigated');
});
