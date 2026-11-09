// G29 (docs/voice-navigator-gaps.md, the 23:03 session): every refusal names
// what to change, and the second identical refused call of a session is
// terminal: one spoken refusal, no continuation, no third call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { runVoiceTool } from '../tools.ts';
import { NO_REPEAT, STOP_NEXT, RefusalGuard, callKey, refusalNext } from '../refusals.ts';
import { REFUSAL_CODES } from '../sessionEvents.ts';
import { listKinds } from '../catalogue.ts';
import { FakeClock, fakeFetch, isToolRow, loggedEvents, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000ab';

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

/** A scripted session whose delegation asks for `get` again after every continuation: the retry loop of 23:03. */
function retryScript(args: Record<string, unknown>) {
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
    onResponseCreate: [
      { atMs: 150, event: call(2) },
      { atMs: 200, event: env({ type: 'response.completed', response: { id: 'resp_2', status: 'completed', output: [], usage: { input_tokens: 1100, output_tokens: 20 } } }) },
    ],
    onClose: [{ atMs: 100, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 12 } } }],
  };
}

test('G29 acceptance: a scripted session that refuses get twice with the same ref speaks one refusal and makes no third call', async () => {
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
      mockScript: retryScript({ ref: 'initiative:nope', part: null }),
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

    assert.equal(outputs.length, 2, 'two calls answered, no third');
    assert.equal(outputs[0]!['kind'], 'refused');
    assert.match(String(outputs[0]!['next']), /kind:id|list or search/);
    assert.equal(outputs[0]!['stop'], undefined);
    assert.equal(outputs[1]!['stop'], true);
    assert.equal(outputs[1]!['next'], STOP_NEXT);
    assert.equal(continuations, 1, 'only the first refusal is continued');
    assert.equal(commentary.length, 1, 'the dock speaks the refusal once');
    assert.match(commentary[0]!, /I found no initiative "nope" that you can read\./);
    const lines = c.getSnapshot().turns.filter((t) => t.role === 'assistant' && /I found no initiative/.test(t.text));
    assert.equal(lines.length, 1, 'the strip shows the line once');
    assert.equal(c.getSnapshot().phase === 'executing', false, 'the delegation is closed');
    // Both refusals are on the log with their code, and the repeat is marked.
    const events = loggedEvents(log);
    assert.equal(events.filter((e) => e['kind'] === 'refused').length, 2);
    assert.equal(events.filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === 'refusal-repeated').length, 1);
    assert.equal(log.filter((r) => isToolRow(r)).length, 2);
    c.dispose();
  } finally {
    proto.sendToolOutput = orig.out; proto.appendCommentary = orig.com; proto.requestResponse = orig.resp;
  }
});
