import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceClient, mintFailure, parseFrame, redactDebugEvent, toolOutputEvent, thinkingEvent, voiceDebugEnabled, type ClientEvent, type VoiceFrame } from '../client.ts';
import { FakeClock, fakeFetch, liveEvents, middlewareVoice, route, wireEvent, type Route } from './voiceHarness.ts';

test('parseFrame reads the real Live API frames V1 recorded', async () => {
  const lines = (await liveEvents()).filter((l) => l['s'] === 'live-responses' && l['dir'] === 'in');
  const frames = lines.map((l) => parseFrame(wireEvent(l))!);
  assert.ok(frames.every(Boolean), 'every inbound line is an event');
  const kinds = (k: VoiceFrame['kind']) => frames.filter((f) => f.kind === k);

  assert.equal(kinds('started').length, 1);
  assert.equal(kinds('delegation').length, 2);
  const calls = kinds('call') as Extract<VoiceFrame, { kind: 'call' }>[];
  assert.deepEqual(calls.map((c) => [c.name, JSON.parse(c.arguments)]), [
    ['search_people', { query: 'Kubernetes experts' }],
    ['navigate', { route: '/iq/local-compute' }],
  ]);
  const delegations = kinds('delegation') as Extract<VoiceFrame, { kind: 'delegation' }>[];
  assert.equal(calls[0]!.delegationId, delegations[0]!.delegationId, 'the call names its delegation');
  assert.match(calls[0]!.callId, /^call_/);
  // The message items of a continuation are not calls; response.completed arrives once per nested response.
  assert.equal(kinds('response-completed').length, 4);
  // Each carries its own nested usage (G11): V1's first two were 1,060 / 20 and 1,194 / 28.
  const usages = (kinds('response-completed') as Extract<VoiceFrame, { kind: 'response-completed' }>[]).map((f) => f.usage);
  assert.ok(usages.every((u) => u && u.inputTokens > 0 && u.outputTokens > 0 && u.cachedTokens >= 0 && u.cachedTokens <= u.inputTokens));
  assert.deepEqual(usages.slice(0, 2).map((u) => [u!.inputTokens, u!.outputTokens]), [[1060, 20], [1194, 28]]);
  assert.equal(kinds('input').map((f) => (f as { text: string }).text).join('').trim().startsWith('Hey, I want to do search'), true);
  assert.ok(kinds('output').length > 40);
  assert.equal(kinds('audio').length, 468, 'output audio is its own kind, never a speaking signal');
  assert.deepEqual(kinds('usage').map((f) => (f as { seconds: number }).seconds), [16, 34, 51], 'cumulative, never summed');
  const closed = kinds('closed')[0] as Extract<VoiceFrame, { kind: 'closed' }>;
  assert.equal(typeof closed.seconds, 'number');
  const err = kinds('error')[0] as Extract<VoiceFrame, { kind: 'error' }>;
  assert.equal(err.clientEventId, 'think_bad', 'an error names the client event it refused');
  assert.equal(err.param, 'delegation_id');
  assert.deepEqual(kinds('ack').map((f) => (f as { clientEventId: string }).clientEventId).sort(), ['comm_1', 'instr_1', 'think_1']);
});

test('the arguments-done event (no name) is never read as a call', () => {
  const f = parseFrame({ type: 'response.event', delegation_id: 'item_1', event: { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{}' } });
  assert.equal(f?.kind, 'response-progress');
  assert.equal(parseFrame('not json'), null);
  assert.equal(parseFrame({ no: 'type' }), null);
});

test('outbound events are the shapes the probe sent', async () => {
  const sent = (await liveEvents()).filter((l) => l['s'] === 'live-responses' && l['dir'] === 'out');
  const create = sent.find((l) => l['type'] === 'response.item.create')!;
  const item = create['item'] as { call_id: string; output: string };
  assert.deepEqual(toolOutputEvent(item.call_id, item.output), { type: create['type'], item: create['item'] });
  const think = sent.find((l) => l['event_id'] === 'think_1')!;
  assert.deepEqual(thinkingEvent(String(think['content'])), { type: think['type'], delegation_id: null, content: think['content'] });
});

test('mint refusals map to unavailable (will not work now) or failed (try again)', () => {
  assert.deepEqual(mintFailure(503, { error: 'voice-unavailable', reason: 'no-key' }), { kind: 'unavailable', reason: 'Voice unavailable: no key on this deployment' });
  assert.equal(mintFailure(503, { error: 'voice-unavailable', reason: 'provider' }).kind, 'failed');
  assert.equal(mintFailure(403, { error: 'over', gate: 'user-budget', reason: 'budget' }).kind, 'unavailable');
  assert.match(mintFailure(409, { error: 'confirm', reason: 'budget' }).reason, /budget/);
  assert.match(mintFailure(403, { code: 'voice-demo-refused' }).reason, /demo identity/);
  assert.match(mintFailure(403, { error: 'Forbidden', action: 'VoiceNavigate' }).reason, /no voice access/);
  assert.equal(mintFailure(429, {}).kind, 'failed');
  // The daily minutes (G13): a 429 in the voice-unavailable shape is unavailable, not a retry, and says what is left.
  assert.deepEqual(mintFailure(429, { error: 'voice-unavailable', reason: 'daily-minutes', minutesLeft: 0, dailyMinutes: 60 }),
    { kind: 'unavailable', reason: "You have used today's 60 minutes of voice. Voice is back at midnight UTC." });
  assert.match(mintFailure(429, { error: 'voice-unavailable', reason: 'daily-minutes', minutesLeft: 1, dailyMinutes: 60 }).reason, /^Only 1 minute of voice is left today/);
});

async function mockMint(sessionId = 'vs_00000000-0000-0000-0000-000000000001') {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: unknown) => unknown }>('openai.ts');
  return {
    sessionId, voiceSessionId: sessionId, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
    model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['search'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    mockScript: mockLiveScript(sessionId, { name: 'search', arguments: { query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null }, said: 'Find me the latest Kubernetes experts.' }),
  };
}

test('a mock mint plays its script through the parser, replays on response.create and closes once with the seconds', async () => {
  const mint = await mockMint();
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([
    route('POST', '/api/voice/sessions/vs_', 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, mint),
  ]);
  const events: ClientEvent[] = [];
  const client = new VoiceClient({ fetch, media: null, onEvent: (e) => events.push(e), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  await client.start();
  assert.equal(log[0]!.url, '/api/voice/sessions');
  assert.deepEqual(log[0]!.body, {}, 'no media: no sdp; the mock mint does not need one');
  await clock.advance(1300);
  const kinds = events.filter((e) => e.type === 'frame').map((e) => (e as { frame: VoiceFrame }).frame.kind);
  assert.deepEqual(kinds.filter((k) => k !== 'response-progress'), ['started', 'input', 'delegation', 'call', 'response-completed', 'usage']);
  client.sendToolOutput('call_mock_1', '{}');
  client.requestResponse();
  await clock.advance(1100);
  assert.ok(events.some((e) => e.type === 'frame' && e.frame.kind === 'output'), 'the continuation speaks');
  // stop() resolves once the scripted session.closed has arrived (100 ms later on the fake clock)
  const stopping = client.stop('closed');
  await clock.advance(200);
  await stopping;
  const closes = log.filter((r) => r.url.endsWith('/close'));
  assert.equal(closes.length, 1);
  // The delegated tokens: the script's two nested response.completed usages, summed (G11).
  assert.deepEqual(closes[0]!.body, { seconds: 15, reason: 'closed', delegated: { inputTokens: 2254, outputTokens: 48, cachedTokens: 0, responses: 2 } });
  await client.stop('closed');
  assert.equal(log.filter((r) => r.url.endsWith('/close')).length, 1, 'a second stop posts nothing');
  assert.deepEqual(events.at(-1), { type: 'ended', reason: 'closed', seconds: 15 });
});

test('a 503 no-key mint is reported unavailable and nothing else is sent', async () => {
  const { fetch, log } = fakeFetch([route('POST', '/api/voice/sessions', 503, { error: 'voice-unavailable', reason: 'no-key' })]);
  const events: ClientEvent[] = [];
  const client = new VoiceClient({ fetch, media: null, onEvent: (e) => events.push(e) });
  await client.start();
  assert.deepEqual(events, [{ type: 'unavailable', reason: 'Voice unavailable: no key on this deployment' }]);
  await client.stop();
  assert.equal(log.length, 1);
});

test('no microphone is unavailable before any mint', async () => {
  const { fetch, log } = fakeFetch([]);
  const { MediaUnavailable } = await import('../client.ts');
  const events: ClientEvent[] = [];
  const client = new VoiceClient({ fetch, media: async () => { throw new MediaUnavailable('Microphone unavailable: permission denied'); }, onEvent: (e) => events.push(e) });
  await client.start();
  assert.deepEqual(events, [{ type: 'unavailable', reason: 'Microphone unavailable: permission denied' }]);
  assert.equal(log.length, 0);
});

test('the debug log sees every frame in and out (VITE_VOICE_DEBUG or localStorage voiceDebug)', async () => {
  const mint = await mockMint();
  const clock = new FakeClock();
  const { fetch } = fakeFetch([
    route('POST', '/api/voice/sessions/vs_', 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, mint),
  ]);
  const seen: Array<[string, string]> = [];
  const client = new VoiceClient({
    fetch, media: null, onEvent: () => {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    debugLog: (dir, ev) => { seen.push([dir, String((ev as { type?: unknown }).type)]); },
  });
  await client.start();
  await clock.advance(1300);
  client.sendToolOutput('call_mock_1', '{}');
  const types = (dir: string) => seen.filter(([d]) => d === dir).map(([, t]) => t);
  assert.deepEqual(types('in').slice(0, 3), ['session.started', 'session.input_transcript.delta', 'session.delegation.created']);
  assert.ok(types('in').includes('response.event'), 'the nested function_call envelope is logged');
  assert.deepEqual(types('out'), ['response.item.create']);
  // Off by default outside a browser with the flag (node has neither the env flag nor localStorage voiceDebug).
  assert.equal(voiceDebugEnabled(), false);
  const stopping = client.stop('closed');
  await clock.advance(200);
  await stopping;
});

test('the debug sink never sees words: transcript deltas and text become character counts, a tool output\'s body is dropped (sweep 2 M4)', async () => {
  const mint = await mockMint();
  const clock = new FakeClock();
  const { fetch } = fakeFetch([
    route('POST', '/api/voice/sessions/vs_', 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, mint),
  ]);
  const seen: Array<[string, unknown]> = [];
  const client = new VoiceClient({
    fetch, media: null, onEvent: () => {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    debugLog: (dir, ev) => { seen.push([dir, ev]); },
  });
  await client.start();
  await clock.advance(1300);
  client.sendToolOutput('call_mock_1', JSON.stringify({ kind: 'results', rows: [{ title: 'Priya Natarajan, secret row' }] }));
  client.requestResponse();
  await clock.advance(1100);
  const text = JSON.stringify(seen);
  assert.doesNotMatch(text, /Kubernetes experts\./, 'the user\'s words never reach the log');
  assert.doesNotMatch(text, /Priya|secret row/, 'a tool output\'s body never reaches the log');
  const input = seen.find(([d, e]) => d === 'in' && (e as { type?: string }).type === 'session.input_transcript.delta')![1] as Record<string, unknown>;
  assert.equal(input['delta'], `[${'Find me the latest Kubernetes experts.'.length} chars]`);
  assert.equal(typeof input['start_ms'], 'number', 'timings stay');
  const output = seen.find(([d, e]) => d === 'out' && (e as { type?: string }).type === 'response.item.create')![1] as { item: Record<string, unknown> };
  assert.deepEqual(Object.keys(output.item).sort(), ['call_id', 'output', 'type']);
  assert.match(String(output.item['output']), /^\[\d+ chars\]$/);
  assert.equal(output.item['call_id'], 'call_mock_1', 'ids stay');
  assert.ok(seen.some(([d, e]) => d === 'in' && (e as { type?: string }).type === 'session.output_transcript.delta'), 'the spoken reply is logged as an event');
  // Any depth, and the three word fields.
  assert.deepEqual(redactDebugEvent({ type: 'response.event', event: { type: 'response.completed', response: { output: [{ content: [{ text: 'hello there', transcript: 'hi' }] }] } } }),
    { type: 'response.event', event: { type: 'response.completed', response: { output: [{ content: [{ text: '[11 chars]', transcript: '[2 chars]' }] }] } } });
  assert.equal(redactDebugEvent('not json at all'), '[15 chars]');
  const stopping = client.stop('closed');
  await clock.advance(200);
  await stopping;
});

/** POST /api/voice/sessions answered from a list, one answer per call (the last one repeats). */
function mintSequence(answers: Array<{ status: number; body: unknown }>): Route {
  let i = 0;
  return (req) => (req.method === 'POST' && req.url === '/api/voice/sessions' ? answers[Math.min(i++, answers.length - 1)] : undefined);
}

test('a mint refused with session-open closes that session (zero seconds, reason dropped) and mints again, once', async () => {
  const OTHER = 'vs_00000000-0000-0000-0000-0000000000ff';
  const SESSION_OPEN = { status: 409, body: { error: 'voice-unavailable', reason: 'session-open', message: 'A voice session is already open for you.', openSessionId: OTHER } };
  const mint = await mockMint();
  for (const [label, answers, known, expect] of [
    ['retry works', [SESSION_OPEN, { status: 201, body: mint }], null, 'minted'],
    ['its own session reports its own seconds', [SESSION_OPEN, { status: 201, body: mint }], 42, 'minted'],
    ['refused again: failed, no third mint', [SESSION_OPEN, SESSION_OPEN], null, 'failed'],
  ] as const) {
    const clock = new FakeClock();
    const { fetch, log } = fakeFetch([
      route('POST', `/api/voice/sessions/${OTHER}/close`, 200, { alreadyClosed: false }),
      route('POST', '/api/voice/sessions/vs_', 200, { alreadyClosed: false }),
      mintSequence([...answers]),
    ]);
    const events: ClientEvent[] = [];
    const client = new VoiceClient({
      fetch, media: null, onEvent: (e) => events.push(e), now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      knownSeconds: (id) => (id === OTHER ? known : null),
    });
    await client.start();
    assert.deepEqual(log.map((r) => [r.method, r.url, r.body]), [
      ['POST', '/api/voice/sessions', {}],
      ['POST', `/api/voice/sessions/${OTHER}/close`, { seconds: known ?? 0, reason: 'dropped' }],
      ['POST', '/api/voice/sessions', {}],
    ], label);
    assert.equal(events[0]!.type, expect, label);
    if (expect === 'failed') assert.match((events[0] as { reason: string }).reason, /Another voice session/);
    const stopping = client.stop('closed');
    await clock.advance(200);
    await stopping;
  }
});

test('after session.close the client sends nothing else (a delegation still in flight cannot answer)', async () => {
  const mint = await mockMint();
  const clock = new FakeClock();
  const { fetch } = fakeFetch([
    route('POST', '/api/voice/sessions/vs_', 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, mint),
  ]);
  const out: string[] = [];
  const client = new VoiceClient({
    fetch, media: null, onEvent: () => {}, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    debugLog: (dir, ev) => { if (dir === 'out') out.push(String((ev as { type?: unknown }).type)); },
  });
  await client.start();
  await clock.advance(1300);
  const stopping = client.stop('closed');
  assert.equal(client.sendToolOutput('call_mock_1', '{}'), null);
  assert.equal(client.requestResponse(), null);
  await clock.advance(200);
  await stopping;
  assert.deepEqual(out, ['session.close']);
});
