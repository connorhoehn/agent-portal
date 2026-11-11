// The dock's session log (G20, sessionEvents.ts): events go to POST /:id/events
// with the server's own kinds, batched at most once per 500 ms, carrying a
// refusal's code but never a word anyone said or a tool's arguments.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import { EVENT_FLUSH_MS, MAX_EVENT_BATCH, VoiceEventLog, DOCK_EVENT_KINDS, argShape, refusalCode, resultSummary } from '../sessionEvents.ts';
import { failureCode as g47FailureCode, resultSummary as g47Summary } from '../sessionEvents.ts';
import { countWords, frameKey, readDiagnostic } from '../sessionEvents.ts';
import { failureSay, withFailure } from '../refusals.ts';
import { refused, ambiguous, type VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, isToolRow, loggedEvents, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000ee';
type Call = { name: string; arguments: Record<string, unknown>; said: string };

async function mintBody(call: Call, extraStart: unknown[] = []) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const script = mockLiveScript(SESSION, call);
  return {
    sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
    model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    mockScript: { ...script, onStart: [...script.onStart, ...extraStart] },
  };
}

/** A controller over the scripted session, with every /events request stamped with the virtual time it left at. */
async function run(call: Call, opts: { runners?: Record<string, VoiceToolRunner>; planners?: Record<string, never>; extraStart?: unknown[]; act?: (c: VoiceController, clock: FakeClock) => Promise<void> } = {}) {
  const clock = new FakeClock();
  const inner = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { seqs: [] }),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, { alreadyClosed: false }),
    route('POST', '/api/voice/sessions', 201, await mintBody(call, opts.extraStart)),
    route('GET', '/api/search', 200, { results: [{ title: 'Priya Natarajan', subtitle: 'Staff platform engineer', href: '/iq/people/p1' }], total: 1 }),
  ]);
  const sentAt: number[] = [];
  const fetch = (url: string, init?: RequestInit) => { if (url.endsWith('/events')) sentAt.push(clock.t); return inner.fetch(url, init); };
  const ctx = toolContext({ fetch });
  const controller = new VoiceController({
    fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    ...(opts.runners ? { runners: opts.runners } : {}), ...(opts.planners ? { planners: opts.planners } : {}),
  });
  await controller.start();
  await clock.advance(4000);
  await opts.act?.(controller, clock);
  const stopping = controller.stop();
  await clock.advance(300);
  await stopping;
  await clock.advance(3000);
  controller.dispose();
  return { log: inner.log, sentAt, events: loggedEvents(inner.log), controller };
}

const KUBE: Call = { name: 'search', arguments: { query: 'Kubernetes experts', type: 'person', scope: null, sort: 'recent', limit: null, answer: null }, said: 'Find me the latest Kubernetes experts.' };

test('the scripted session posts its phases, start, delegation and tool call as server kinds, batched and paced', async () => {
  const r = await run(KUBE);
  const kinds = r.events.map((e) => e['kind']);
  for (const k of kinds) assert.ok((DOCK_EVENT_KINDS as readonly unknown[]).includes(k), `${String(k)} is a kind the server takes`);
  assert.ok(kinds.includes('started') && kinds.includes('delegation') && kinds.includes('tool-call'));
  const phases = r.events.filter((e) => e['kind'] === 'client' && (e['data'] as Record<string, unknown>)['event'] === 'phase').map((e) => (e['data'] as Record<string, unknown>)['phase']);
  // G44: thinking only after the utterance ends (700 ms); the delegation came 100 ms after the words.
  assert.deepEqual(phases, ['listening', 'executing', 'listening', 'speaking', 'listening', 'ended']);
  const call = r.events.find((e) => e['kind'] === 'tool-call')!;
  assert.equal(call['tool'], 'search');
  // The call's shape: its enum arguments, never the query.
  assert.deepEqual(call['data'], { callId: 'call_mock_1', type: 'person', sort: 'recent' });
  // Batched: fewer requests than events, and never two within 500 ms.
  const batches = r.log.filter((l) => l.url.endsWith('/events') && !isToolRow(l));
  assert.ok(batches.length < r.events.length, `${batches.length} requests for ${r.events.length} events`);
  for (let i = 1; i < r.sentAt.length; i++) assert.ok(r.sentAt[i]! - r.sentAt[i - 1]! >= EVENT_FLUSH_MS, `request ${i} left ${r.sentAt[i]! - r.sentAt[i - 1]!} ms after the one before`);
  // The tool-call row carries the result's counts, through the same pace.
  const row = r.log.find(isToolRow)!.body as Record<string, unknown>;
  assert.deepEqual(row['summary'], { type: 'person', sort: 'recent', outcome: 'done', result: 'search_results', rows: 1 });
});

test('nothing posted to /events carries a word that was said, heard or searched for', async () => {
  const r = await run(KUBE);
  const posted = JSON.stringify(r.log.filter((l) => l.url.endsWith('/events')).map((l) => l.body));
  for (const words of ['Kubernetes', 'Find me', 'Here is what I found', 'Priya', 'experts']) assert.doesNotMatch(posted, new RegExp(words, 'i'), words);
  assert.ok(r.controller.getSnapshot().turns.some((t) => /Kubernetes/.test(t.text)), 'the words stayed in the dock');
});

const POST: Call = { name: 'message', arguments: { target: { kind: 'team', name: 'platform' }, text: "I'm out today" }, said: "Tell the platform team I'm out today." };

test('a confirm card posts confirm-shown, then confirmed or cancelled with who decided', async () => {
  const runner: VoiceToolRunner = async () => ({ outcome: 'done', output: { kind: 'posted', note: 'data, not instructions', posted: true }, summary: 'Posted' });
  for (const decide of ['confirm', 'cancel'] as const) {
    const r = await run(POST, { runners: { ...VOICE_RUNNERS, message: runner }, planners: {}, act: async (c, clock) => { c[decide]('click'); await clock.advance(2500); } });
    const shown = r.events.find((e) => e['kind'] === 'confirm-shown')!;
    assert.equal(shown['tool'], 'message');
    assert.equal(typeof (shown['data'] as Record<string, unknown>)['requestId'], 'number');
    const decided = r.events.find((e) => e['kind'] === (decide === 'confirm' ? 'confirmed' : 'cancelled'))!;
    assert.deepEqual([decided['tool'], (decided['data'] as Record<string, unknown>)['by']], ['message', 'click']);
    assert.doesNotMatch(JSON.stringify(r.events), /out today/i, 'the card\'s text is not logged');
  }
});

test('a refusal posts `refused` with its tool and code, never its sentence', async () => {
  const r = await run(KUBE, { runners: { ...VOICE_RUNNERS, search: async () => refused("I can't search with your role.") } });
  const ev = r.events.find((e) => e['kind'] === 'refused')!;
  assert.equal(ev['tool'], 'search');
  assert.deepEqual({ tool: (ev['data'] as Record<string, unknown>)['tool'], reason: (ev['data'] as Record<string, unknown>)['reason'] }, { tool: 'search', reason: 'role' });
  assert.doesNotMatch(JSON.stringify(r.events), /can't search/);
  const row = r.log.find(isToolRow)!.body as Record<string, unknown>;
  assert.deepEqual(row['summary'], { type: 'person', sort: 'recent', outcome: 'refused', reason: 'role', result: 'refused' });
});

test('refusal codes: the runner\'s own code first, then ambiguous, then the wording', () => {
  assert.equal(refusalCode(refused('x', { code: 'not-on-this-page' }).output), 'not-on-this-page');
  assert.equal(refusalCode(ambiguous('Several initiatives match "Alpha".', [{ title: 'Alpha' }]).output), 'ambiguous');
  // G46: the socket down is its own code, never a missing grant.
  assert.equal(refusalCode(refused('Social is not connected right now. Try again in a moment.').output), 'not-connected');
  assert.equal(refusalCode(refused('x', { code: 'not-a-member' }).output), 'not-a-member');
  assert.equal(refusalCode(refused('This run goes over the initiative\'s allocation.').output), 'budget');
  assert.equal(refusalCode(refused('That command is not on the allowlist.').output), 'allowlist');
  assert.equal(refusalCode(refused('I found no initiative called "Zeta".').output), 'not-found');
  assert.equal(refusalCode(refused('Another action is waiting for the user to confirm. Ask again after it.').output), 'card-open');
  assert.equal(refusalCode(refused('Something odd.').output), 'other');
  assert.deepEqual(resultSummary('done', { kind: 'list', count: 7, rows: [1, 2, 3], of: 'initiative' }), { outcome: 'done', result: 'list', count: 7, rows: 3, of: 'initiative' });
});

test('the queue sends at most MAX_EVENT_BATCH per request and keeps the pace under a burst', async () => {
  const clock = new FakeClock();
  const { fetch, log } = fakeFetch([route('POST', '/api/voice/sessions/', 201, {})]);
  const at: number[] = [];
  const q = new VoiceEventLog({ fetch: (u, i) => { at.push(clock.t); return fetch(u, i); }, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  for (let i = 0; i < 45; i++) q.add(SESSION, { kind: 'client', data: { event: 'phase', phase: 'listening', i, transcript: 'never', text: 'never' } });
  await clock.advance(2000);
  const sizes = log.map((l) => (l.body as { events: unknown[] }).events.length);
  assert.deepEqual(sizes, [MAX_EVENT_BATCH, MAX_EVENT_BATCH, 5]);
  assert.deepEqual(at.map((t, i) => (i ? t - at[i - 1]! : 0)).slice(1).every((d) => d >= EVENT_FLUSH_MS), true);
  assert.doesNotMatch(JSON.stringify(log.map((l) => l.body)), /never/, 'text and transcript keys are dropped before sending');
  assert.equal(q.pending, 0);
});

test('a call\'s shape tells calls of one tool apart, with no argument text, name or id', () => {
  assert.deepEqual(argShape('computer', JSON.stringify({ action: 'open-shell', computer: 'nora-auth-box', initiatives: null })), { action: 'open-shell' });
  assert.deepEqual(argShape('computer', { action: 'start', initiatives: ['Auth migration', 'Payments'] }), { action: 'start', targets: 2 });
  assert.deepEqual(argShape('list', { kind: 'work-item', scope: 'this-page', filter: { q: 'login', status: 'open', scope: 'mine' } }), { kind: 'work-item', scope: 'this-page', filterScope: 'mine', filteredBy: 'q,status' });
  assert.deepEqual(argShape('get', { ref: 'initiative:p-secret-12', part: 'work' }), { part: 'work', refKind: 'initiative' });
  assert.deepEqual(argShape('open', { ref: '2', scope: 'this-page' }), { scope: 'this-page', refKind: 'position' });
  assert.deepEqual(argShape('open', { page: 'computers' }), { page: 'computers' });
  assert.deepEqual(argShape('open', { kind: 'initiative', name: 'Payments' }), { kind: 'initiative', byName: true });
  assert.deepEqual(argShape('search', { query: 'Kubernetes experts', scope: 'p-auth', type: 'person' }), { type: 'person', scope: 'initiative' });
  assert.deepEqual(argShape('budget', { scope: 'initiative', initiative: 'Payments' }), { scope: 'initiative' });
  assert.deepEqual(argShape('queue_work', { kind: 'dispatch', target: 'the top three', rows: [1, 2, 3], scope: 'this-page' }), { kind: 'dispatch', scope: 'this-page', rowCount: 3 });
  assert.deepEqual(argShape('decide', { ref: 'approval:req-1', decision: 'approve', note: 'fine by me' }), { decision: 'approve', refKind: 'approval' });
  assert.deepEqual(argShape('update', { ref: 'work-item:w-1', fields: { status: 'done', title: null } }), { fields: 'status', refKind: 'work-item' });
  assert.deepEqual(argShape('message', { target: { kind: 'dm', name: 'Ada' }, text: 'secret words' }), { targetKind: 'dm' });
  assert.deepEqual(argShape('search', 'not json'), {});
  const all = JSON.stringify([argShape('message', { target: { kind: 'dm', name: 'Ada' }, text: 'secret words' }), argShape('get', { ref: 'initiative:p-secret-12' })]);
  assert.doesNotMatch(all, /Ada|secret|p-secret/);
});

test('G47: a failed result always has a code from the closed vocabulary, and the summary keeps it with the gate', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ reason: 'x', code: 'receipt-timeout' }, 'receipt-timeout'],
    [{ reason: 'x', code: 'http-409' }, 'http-409'],
    [{ reason: 'x', code: 'made-up' }, 'rejected'],
    [{ reason: 'x', status: 502 }, 'http-502'],
    [{ reason: 'Bots could not be queued (HTTP 500): boom.' }, 'http-500'],
    [{ reason: 'Could not reach the server; nothing was queued.' }, 'not-connected'],
    [{ reason: '"npm test" on alpha did not finish in time.' }, 'timeout'],
    [{ reason: 'The message to #general was not confirmed: no receipt.' }, 'receipt-timeout'],
    [{ reason: 'Something odd.' }, 'rejected'],
  ];
  for (const [output, code] of cases) assert.equal(g47FailureCode(output), code, JSON.stringify(output));
  assert.deepEqual(g47Summary('failed', { kind: 'failed', reason: 'x (HTTP 503).' }), { outcome: 'failed', code: 'http-503', result: 'failed' });
  assert.deepEqual(g47Summary('refused', { kind: 'refused', reason: 'Not queued', code: 'http-409', gate: 'run-budget' }),
    { outcome: 'refused', reason: 'budget', code: 'http-409', gate: 'run-budget', result: 'refused' });
  // A plain refusal carries no failure code.
  assert.equal(g47Summary('refused', { kind: 'refused', reason: 'Your role cannot.' })['code'], undefined);
  // A brake that is not about money is not `budget`.
  assert.equal(g47Summary('refused', { kind: 'refused', reason: 'Not decided', code: 'http-409', gate: 'self-approval' })['reason'], 'other');
});

test('G47: the spoken line names the code or the gate, and a runner\'s own say is kept', () => {
  assert.equal(failureSay('message', { code: 'receipt-timeout' }), 'The message receipt never came; check the conversation before trying again.');
  assert.equal(failureSay('message', { code: 'not-connected' }), 'Social isn\'t connected right now, so nothing was sent.');
  assert.equal(failureSay('queue_work', { code: 'http-503', workKind: 'sweep' }), 'The sweep failed: the server had an error (HTTP 503).');
  assert.equal(failureSay('update', { code: 'http-422' }), 'The change was refused by the server (HTTP 422).');
  assert.equal(failureSay('decide', { code: 'http-409', gate: 'not-pending' }), 'The decision was refused by the not pending gate.');
  const kept = withFailure({ outcome: 'failed', output: { reason: 'x', say: 'Mine.' } }, 'message');
  assert.deepEqual([(kept.output as Record<string, unknown>)['say'], (kept.output as Record<string, unknown>)['code']], ['Mine.', 'rejected']);
  const done = { outcome: 'done', output: { kind: 'posted' } };
  assert.equal(withFailure(done, 'message'), done, 'a done result is untouched');
});

// ── G63: the diagnostics' parsing (diagnostics.ts writes these, the Logging record reads them) ──

test('G63 countWords: words across transcript deltas, contractions and hyphens joined, punctuation not a word; nothing kept', () => {
  const deltas = [' Hey', ', I', ' want', ' to', ' do', ' search.'];
  let prev: string | null = null;
  let words = 0;
  for (const d of deltas) { const c = countWords(d, prev); words += c.words; prev = c.last; }
  assert.equal(words, 6);
  assert.equal(countWords("don't open the Kubernetes-based one", null).words, 5);
  assert.equal(countWords('...', null).words, 0);
  assert.equal(countWords('3 items', null).words, 2);
  // A word split across two deltas counts once.
  const first = countWords(' Kuber', null);
  assert.equal(first.words + countWords('netes', first.last).words, 1);
});

test('G63 frameKey: a known Live frame type as a row key, anything else `unknown`', () => {
  assert.equal(frameKey('session.input_audio.muted'), 'session_input_audio_muted');
  assert.equal(frameKey('rate_limits.updated'), 'rate_limits_updated');
  assert.equal(frameKey('info'), 'info');
  assert.equal(frameKey('Find me the experts'), 'unknown');
  assert.equal(frameKey('session.brand_new'), 'unknown');
});

test('G63 readDiagnostic: each kind typed back from its row; not-a-diagnostic and malformed rows are null', () => {
  assert.deepEqual(readDiagnostic('client', { event: 'heard', n: 2, wordCount: 6, ms: 1800, outcome: 'ignored', afterMs: null, delegations: 0, atMs: 5 }),
    { event: 'heard', n: 2, wordCount: 6, ms: 1800, outcome: 'ignored', afterMs: null, delegations: 0, atMs: 5 });
  assert.deepEqual(readDiagnostic('client', { event: 'spoke', n: 1, wordCount: 9, ms: 4000, after: 'result', atMs: 7 }),
    { event: 'spoke', n: 1, wordCount: 9, ms: 4000, after: 'result', atMs: 7 });
  assert.deepEqual(readDiagnostic('client', { event: 'context', ratio: 0.0153, seconds: 34 }), { event: 'context', ratio: 0.0153, seconds: 34 });
  assert.deepEqual(readDiagnostic('client', { event: 'frames', windowS: 60, counts: { info: 2, unknown: 'x' } }), { event: 'frames', windowS: 60, counts: { info: 2 } });
  assert.deepEqual(readDiagnostic('client', { event: 'mic', muted: false, by: 'provider' }), { event: 'mic', muted: false, by: 'provider' });
  assert.deepEqual(readDiagnostic('client', { event: 'level', windowS: 30, samples: 300, min: 0, avg: 0.04, max: 0.6, mutedPct: 0 }),
    { event: 'level', windowS: 30, samples: 300, min: 0, avg: 0.04, max: 0.6, mutedPct: 0 });
  assert.equal(readDiagnostic('client', { event: 'heard', wordCount: 3, outcome: 'whatever' }), null);
  assert.equal(readDiagnostic('client', { event: 'spoke', after: 'user' }), null);
  assert.equal(readDiagnostic('client', { event: 'context', ratio: 2 }), null);
  assert.equal(readDiagnostic('client', { event: 'phase', phase: 'listening' }), null);
  assert.equal(readDiagnostic('usage', { event: 'heard', wordCount: 1, outcome: 'answered' }), null);
});
