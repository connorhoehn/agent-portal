// G59–G62 (docs/voice-navigator-gaps.md, "Real sessions, 9 November 2026
// 13:47–14:01"): the voice that hears but never answers.
//
// G59: a stopped round (G51 navigated, G43 too many calls, G29 repeat) sent
// its outputs without the response.create that continues them, so the
// delegation never resolved and the Live API kept the voice silent for the
// rest of the session (vs_5144e356 13:29:44, vs_d69bbb23 01:41:41). The
// scripted session now keeps that rule (client.ts mockDeliver: a later
// delegation is held while one is unresolved), so these replays fail on the
// old controller. G60: a delegation that calls nothing and leaves the voice
// silent gets a silent note. G61: three unanswered utterances raise the
// restart card, which resumes the session. G62: one candidate opens.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATION_EMPTY_MS, DELEGATION_EMPTY_NOTE, RESUME_NOTE, STALLED_CARD, STALLED_TEXT, UNANSWERED_WAIT_MS, VoiceController,
} from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { VOICE_RUNNERS } from '../actions.ts';
import type { VoiceToolRunner } from '../tools.ts';
import { FakeClock, fakeFetch, loggedEvents, route, toolContext, type Route } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000c9';
const SESSION2 = 'vs_00000000-0000-0000-0000-0000000000ca';

type Frame = { atMs: number; event: Record<string, unknown> };
type Call = { id: string; name: string; args: Record<string, unknown> };

const env = (d: string, event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
const said = (atMs: number, text: string): Frame => ({ atMs, event: { type: 'session.input_transcript.delta', delta: text, start_ms: atMs, end_ms: atMs + 300 } });
const voice = (atMs: number, text: string): Frame => ({ atMs, event: { type: 'session.output_transcript.delta', delta: text, start_ms: atMs, end_ms: atMs + 300 } });
const fc = (d: string, c: Call) => env(d, { type: 'response.output_item.done', item: { id: `fc_${c.id}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(c.args), call_id: c.id, name: c.name } });
const completed = (d: string) => env(d, { type: 'response.completed', response: { id: `r_${d}`, status: 'completed', output: [] } });

/** The voice delegates at `at`: the backend calls `call` (or nothing) and its response completes. */
function delegate(at: number, d: string, call?: Call, opts: { complete?: boolean } = {}): Frame[] {
  return [
    { atMs: at, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: `r_${d}`, target: 'responses' } } },
    ...(call ? [{ atMs: at + 20, event: fc(d, call) }] : []),
    ...(opts.complete === false ? [] : [{ atMs: at + 30, event: completed(d) }]),
  ];
}
/** A continuation that answers in text: it completes and the voice says `line`. */
const answer = (line: string): Frame[] => [{ atMs: 100, event: completed('$continued') }, { atMs: 300, event: { type: 'session.output_transcript.delta', delta: line, start_ms: 0, end_ms: 300 } }];
/** A continuation that calls again (the backend going on after a result). */
const callAgain = (c: Call): Frame[] => [{ atMs: 100, event: fc('$continued', c) }, { atMs: 120, event: completed('$continued') }];

const PAGE = {
  path: '/iq/projects/p1', record: { ref: 'initiative:p1', title: 'Alpha' }, rowsLabel: 'work items',
  rows: [{ ref: 'work-item:w1', title: 'Rotate keys', href: '/iq/projects/p1?item=w1' }, { ref: 'work-item:w2', title: 'Ship docs', href: '/iq/projects/p1?item=w2' }],
};

function mintBody(id: string, script: { onStart: Frame[]; onResponseCreate?: Frame[]; onResponseCreateSeq?: Frame[][] }, extra: Record<string, unknown> = {}) {
  return {
    sessionId: id, voiceSessionId: id, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
    model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['open', 'create', 'message', 'list', 'get'], budget: { holdUsd: 0.5, usdPerMinute: 0.05 },
    mockScript: {
      onStart: [{ atMs: 0, event: { type: 'session.started', session: { id: `live_${id}` } } }, ...script.onStart],
      onResponseCreate: script.onResponseCreate ?? answer('Done.'),
      ...(script.onResponseCreateSeq ? { onResponseCreateSeq: script.onResponseCreateSeq } : {}),
      onClose: [{ atMs: 50, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 30 } } }],
    },
    ...extra,
  };
}

/** A scripted session with spies on what the dock sends; `mints` answer POST /api/voice/sessions in order. */
async function session(mints: unknown[], runners: Record<string, VoiceToolRunner> = {}) {
  const clock = new FakeClock();
  const minted: Array<Record<string, unknown>> = [];
  const mintRoute: Route = (req) => {
    if (req.method !== 'POST' || req.url !== '/api/voice/sessions') return undefined;
    minted.push((req.body ?? {}) as Record<string, unknown>);
    return { status: 201, body: mints[minted.length - 1] ?? mints.at(-1) };
  };
  const { fetch, log } = fakeFetch([
    route('POST', '/api/voice/sessions/vs_', 201, {}),
    mintRoute,
    route('GET', '/api/graph/projects', 200, []),
  ]);
  const outputs: Array<{ callId: string; out: Record<string, unknown> }> = [];
  const notes: string[] = [];
  const commentary: string[] = [];
  let continuations = 0;
  const proto = VoiceClient.prototype;
  const orig = { out: proto.sendToolOutput, th: proto.appendThinking, co: proto.appendCommentary, r: proto.requestResponse };
  proto.sendToolOutput = function (id: string, o: string) { outputs.push({ callId: id, out: JSON.parse(o) as Record<string, unknown> }); return orig.out.call(this, id, o); };
  proto.appendThinking = function (t: string) { notes.push(t); return orig.th.call(this, t); };
  proto.appendCommentary = function (t: string) { commentary.push(t); return orig.co.call(this, t); };
  proto.requestResponse = function () { continuations++; return orig.r.call(this); };
  const ran: string[] = [];
  const stub = (name: string): VoiceToolRunner => async () => { ran.push(name); return { outcome: 'done', output: { kind: name === 'message' ? 'posted' : 'created' }, summary: 'Done' }; };
  const ctx = toolContext({ fetch, role: 'org-leader', page: () => PAGE, tabs: () => ({ path: PAGE.path, tabs: ['overview', 'work', 'docs'], tab: 'overview' }) });
  const c = new VoiceController({
    fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    runners: { ...VOICE_RUNNERS, create: stub('create'), message: stub('message'), ...runners }, planners: {},
  });
  const events = () => loggedEvents(log);
  const clientEvents = (name: string) => events().filter((e) => (e['data'] as Record<string, unknown> | undefined)?.['event'] === name);
  const delegations = () => events().filter((e) => e['kind'] === 'delegation').map((e) => (e['data'] as Record<string, unknown>)['delegationId']);
  return {
    c, clock, log, outputs, notes, commentary, ran, ctx, minted, events, clientEvents, delegations,
    continuations: () => continuations,
    restore: () => { Object.assign(proto, { sendToolOutput: orig.out, appendThinking: orig.th, appendCommentary: orig.co, requestResponse: orig.r }); },
  };
}

// ── G59: a stopped round is continued, so the next request is answered ──

test('G59 regression, vs_89fba6d6 as recorded: open a tab, create (confirmed by voice), the empty delegation after "confirm", message, open by position, and the next request is answered', async () => {
  const h = await session([mintBody(SESSION, { onStart: [
    said(300, 'Open the docs tab.'), ...delegate(600, 'd1', { id: 'c1', name: 'open', args: { scope: 'this-page', tab: 'docs' } }),
    said(3000, 'Create a whiteboard called Retro.'), ...delegate(3300, 'd2', { id: 'c2', name: 'create', args: { kind: 'whiteboard', fields: { title: 'Retro' } } }),
    said(5000, 'Confirm.'),
    // seq 34 / 63: the voice delegates again on the confirm word; the backend calls nothing and the voice says a line.
    ...delegate(5100, 'd3'), voice(7500, 'Created.'),
    said(9000, 'Tell the platform team I am out today.'),
    ...delegate(9300, 'd4', { id: 'c4', name: 'message', args: { target: { kind: 'team', name: 'platform' }, text: 'I am out today' } }),
    said(11000, 'Yep.'),
    said(14000, 'Open the first one.'), ...delegate(14300, 'd5', { id: 'c5', name: 'open', args: { scope: 'this-page', ref: '1' } }),
    // 13:56:31 onwards: the request after the open by position.
    said(17000, 'What should I work on?'), ...delegate(17300, 'd6', { id: 'c6', name: 'list', args: { kind: 'work-item', scope: 'this-page' } }),
  ] })]);
  try {
    await h.c.start();
    await h.clock.advance(24_000);
    assert.deepEqual(h.ran, ['create', 'message'], 'both cards confirmed by voice');
    assert.deepEqual(h.delegations(), ['d1', 'd2', 'd3', 'd4', 'd5', 'd6']);
    assert.deepEqual(h.outputs.map((o) => o.callId), ['c1', 'c2', 'c4', 'c5', 'c6']);
    assert.equal(h.outputs.at(-1)!.out['kind'], 'list', 'the request after the open is answered');
    assert.equal(h.continuations(), 5, 'every round is continued');
    assert.equal(h.c.getSnapshot().phase === 'executing', false);
    assert.equal(h.clientEvents('unanswered').length, 0);
    h.c.dispose();
  } finally { h.restore(); }
});

test('G59 regression, vs_5144e356 13:29:44: a request that opened a page and then asked for another (navigated, stop) is continued, and the next request is answered', async () => {
  const h = await session([mintBody(SESSION, {
    onStart: [
      said(300, 'Open designs, then runbooks.'), ...delegate(600, 'd1', { id: 'c1', name: 'open', args: { page: 'designs' } }),
      said(6000, 'List the initiatives.'), ...delegate(6300, 'd2', { id: 'c3', name: 'list', args: { kind: 'initiative' } }),
    ],
    onResponseCreateSeq: [callAgain({ id: 'c2', name: 'open', args: { page: 'runbooks' } })],
  })]);
  try {
    await h.c.start();
    await h.clock.advance(12_000);
    assert.equal(h.outputs[1]!.out['code'], 'navigated');
    assert.equal(h.ctx.navigations.length, 1, 'the second page never opens');
    assert.deepEqual(h.delegations(), ['d1', 'd2'], 'the next delegation reached the dock');
    assert.equal(h.outputs.at(-1)!.callId, 'c3');
    assert.equal(h.outputs.at(-1)!.out['kind'], 'list');
    assert.equal(h.commentary.length, 0, 'the continuation says the page line; the dock adds none');
    h.c.dispose();
  } finally { h.restore(); }
});

test('G59 regression, vs_d69bbb23 01:41:41: a fifth call (too-many-calls, stop) is continued, and the next request is answered', async () => {
  const list = (n: number): Call => ({ id: `c${n}`, name: 'list', args: { kind: 'initiative', filter: { q: `q${n}` } } });
  const h = await session([mintBody(SESSION, {
    onStart: [
      said(300, 'Find the design channel.'), ...delegate(600, 'd1', list(1)),
      said(8000, 'Just list the initiatives.'), ...delegate(8300, 'd2', list(6)),
    ],
    onResponseCreateSeq: [callAgain(list(2)), callAgain(list(3)), callAgain(list(4)), callAgain(list(5))],
  })]);
  try {
    await h.c.start();
    await h.clock.advance(14_000);
    const kinds = h.outputs.map((o) => (o.out['kind'] === 'refused' ? String(o.out['code']) : String(o.out['kind'])));
    assert.deepEqual(kinds, ['list', 'list', 'list', 'list', 'too-many-calls', 'list']);
    assert.deepEqual(h.delegations(), ['d1', 'd2']);
    assert.equal(h.outputs.at(-1)!.callId, 'c6', 'the next request ran');
    h.c.dispose();
  } finally { h.restore(); }
});

test('G59: the scripted session holds the voice while a call has no continuation (the rule the replays above stand on)', async () => {
  const h = await session([mintBody(SESSION, { onStart: [
    said(300, 'Create a whiteboard.'), ...delegate(600, 'd1', { id: 'c1', name: 'create', args: { kind: 'whiteboard', fields: { title: 'Retro' } } }),
    said(3000, 'And open designs.'), ...delegate(3300, 'd2', { id: 'c2', name: 'open', args: { page: 'designs' } }),
  ] })]);
  try {
    await h.c.start();
    // The create card is never answered: its call stays open, so the voice takes no new request.
    await h.clock.advance(8000);
    assert.deepEqual(h.delegations(), ['d1']);
    h.c.confirm('click');
    await h.clock.advance(3000);
    assert.deepEqual(h.delegations(), ['d1', 'd2'], 'held until the call was answered and continued');
    h.c.dispose();
  } finally { h.restore(); }
});

// ── G60: a delegation with nothing to say ──

test('G60: a delegation that calls nothing and leaves the voice silent gets the silent note after 6 s, and the log says delegation-empty', async () => {
  const h = await session([mintBody(SESSION, { onStart: [said(300, 'Confirm.'), ...delegate(600, 'd1')] })]);
  try {
    await h.c.start();
    await h.clock.advance(600 + DELEGATION_EMPTY_MS - 200);
    assert.equal(h.notes.filter((n) => n === DELEGATION_EMPTY_NOTE).length, 0, 'not before 6 s');
    await h.clock.advance(400);
    assert.equal(h.notes.filter((n) => n === DELEGATION_EMPTY_NOTE).length, 1);
    assert.equal(h.commentary.length, 0, 'the note is silent context, not commentary');
    const ev = h.clientEvents('delegation-empty');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0]!['data'], { event: 'delegation-empty', delegationId: 'd1', completed: true, continuation: false });
    await h.clock.advance(20_000);
    assert.equal(h.notes.filter((n) => n === DELEGATION_EMPTY_NOTE).length, 1, 'once');
    h.c.dispose();
  } finally { h.restore(); }
});

test('G60: no note when the voice answers after the delegation, or when the delegation calls; a response that never completes is empty too', async () => {
  const spoke = await session([mintBody(SESSION, { onStart: [said(300, 'What did you say?'), ...delegate(600, 'd1'), voice(1200, 'I said it is open.')] })]);
  try {
    await spoke.c.start();
    await spoke.clock.advance(12_000);
    assert.equal(spoke.clientEvents('delegation-empty').length, 0);
    assert.equal(spoke.notes.filter((n) => n === DELEGATION_EMPTY_NOTE).length, 0);
    spoke.c.dispose();
  } finally { spoke.restore(); }
  const called = await session([mintBody(SESSION, { onStart: [said(300, 'Open designs.'), ...delegate(600, 'd1', { id: 'c1', name: 'open', args: { page: 'designs' } })] })]);
  try {
    await called.c.start();
    await called.clock.advance(12_000);
    assert.equal(called.clientEvents('delegation-empty').length, 0, 'a call and its spoken continuation');
    called.c.dispose();
  } finally { called.restore(); }
  const hung = await session([mintBody(SESSION, { onStart: [said(300, 'Hello?'), ...delegate(600, 'd1', undefined, { complete: false })] })]);
  try {
    await hung.c.start();
    await hung.clock.advance(600 + DELEGATION_EMPTY_MS + 200);
    const ev = hung.clientEvents('delegation-empty');
    assert.equal(ev.length, 1);
    assert.equal((ev[0]!['data'] as Record<string, unknown>)['completed'], false);
    hung.c.dispose();
  } finally { hung.restore(); }
});

test('G60: a continuation that completes silently (a stopped round whose backend said nothing) gets the note too', async () => {
  const h = await session([mintBody(SESSION, {
    onStart: [said(300, 'Open designs, then runbooks.'), ...delegate(600, 'd1', { id: 'c1', name: 'open', args: { page: 'designs' } })],
    onResponseCreateSeq: [callAgain({ id: 'c2', name: 'open', args: { page: 'runbooks' } }), [{ atMs: 100, event: completed('$continued') }]],
  })]);
  try {
    await h.c.start();
    await h.clock.advance(12_000);
    const ev = h.clientEvents('delegation-empty');
    assert.equal(ev.length, 1, JSON.stringify(h.events().map((e) => e['data'])));
    assert.equal((ev[0]!['data'] as Record<string, unknown>)['continuation'], true);
    h.c.dispose();
  } finally { h.restore(); }
});

// ── G61: three utterances unanswered ──

test('G61: three utterances in a row with no word and no delegation raise "Not answering: restart voice"; Confirm restarts and resumes the session', async () => {
  const h = await session([
    mintBody(SESSION, { onStart: [said(1000, 'Open the docs tab.'), said(4000, 'Hello?'), said(7000, 'Can you hear me?')] }),
    mintBody(SESSION2, { onStart: [] }, { resumeOf: SESSION }),
  ]);
  try {
    await h.c.start();
    await h.clock.advance(7000 + UNANSWERED_WAIT_MS - 300);
    assert.equal(h.c.getSnapshot().pending, null, 'not before the last utterance had its chance');
    await h.clock.advance(600);
    const card = h.c.getSnapshot().pending;
    assert.equal(card?.callId, STALLED_CARD);
    assert.equal(card?.title, STALLED_TEXT.title);
    assert.equal(card?.title, 'Not answering: restart voice');
    assert.deepEqual(h.clientEvents('unanswered').map((e) => e['data']), [{ event: 'unanswered', utterances: 3 }]);
    h.c.confirm('click');
    await h.clock.advance(2000);
    assert.equal(h.minted.length, 2);
    assert.equal(h.minted[1]!['resumeOf'], SESSION, 'the restart resumes the session');
    assert.equal(h.c.getSnapshot().sessionId, SESSION2);
    assert.equal(h.c.getSnapshot().phase, 'listening');
    assert.equal(h.c.getSnapshot().pending, null);
    assert.ok(h.notes.includes(RESUME_NOTE), 'the voice is told it continues');
    assert.equal(h.log.filter((r) => r.url === `/api/voice/sessions/${SESSION}/close`).length, 1, 'the first session is closed');
    h.c.dispose();
  } finally { h.restore(); }
});

test('G61: an answer between utterances keeps the card away; a card already up clears when the voice answers; Cancel dismisses it', async () => {
  const answered = await session([mintBody(SESSION, { onStart: [said(1000, 'Hi.'), voice(2000, 'Hello.'), said(4000, 'Open docs.'), said(7000, 'Thanks.'), voice(8000, 'Sure.'), said(10_000, 'Bye.')] })]);
  try {
    await answered.c.start();
    await answered.clock.advance(20_000);
    assert.equal(answered.clientEvents('unanswered').length, 0);
    assert.equal(answered.c.getSnapshot().pending, null);
    answered.c.dispose();
  } finally { answered.restore(); }
  const late = await session([mintBody(SESSION, { onStart: [said(1000, 'One.'), said(4000, 'Two.'), said(7000, 'Three.'), voice(13_000, 'Sorry, I am here.')] })]);
  try {
    await late.c.start();
    await late.clock.advance(12_500);
    assert.equal(late.c.getSnapshot().pending?.callId, STALLED_CARD);
    await late.clock.advance(1000);
    assert.equal(late.c.getSnapshot().pending, null, 'the voice answered: the card goes');
    late.c.dispose();
  } finally { late.restore(); }
  const dismissed = await session([mintBody(SESSION, { onStart: [said(1000, 'One.'), said(4000, 'Two.'), said(7000, 'Three.')] })]);
  try {
    await dismissed.c.start();
    await dismissed.clock.advance(12_500);
    assert.equal(dismissed.c.getSnapshot().pending?.callId, STALLED_CARD);
    dismissed.c.cancel('click');
    await dismissed.clock.advance(100);
    assert.equal(dismissed.c.getSnapshot().pending, null);
    assert.equal(dismissed.minted.length, 1, 'no restart');
    assert.equal(dismissed.clientEvents('unanswered-dismissed').length, 1);
    dismissed.c.dispose();
  } finally { dismissed.restore(); }
});

test('G61: words for a confirm card are not requests to the voice', async () => {
  const h = await session([mintBody(SESSION, { onStart: [
    said(300, 'Create a whiteboard.'), ...delegate(600, 'd1', { id: 'c1', name: 'create', args: { kind: 'whiteboard', fields: { title: 'Retro' } } }),
    said(3000, 'Hmm, let me read it.'), said(6000, 'Looks fine, I think.'), said(9000, 'Is that the title?'),
  ] })]);
  try {
    await h.c.start();
    await h.clock.advance(16_000);
    assert.equal(h.clientEvents('unanswered').length, 0);
    assert.notEqual(h.c.getSnapshot().pending?.callId, STALLED_CARD);
    h.c.dispose();
  } finally { h.restore(); }
});

// ── G62: one candidate is not a choice ──

test('G62: an ambiguous result with one candidate shows no choice card', async () => {
  const one: VoiceToolRunner = async () => ({ outcome: 'refused', output: { kind: 'ambiguous', reason: 'One is near.', candidates: [{ ref: 'initiative:p1', title: 'Alpha', href: '/iq/projects/p1' }] }, summary: 'ambiguous' });
  const h = await session([mintBody(SESSION, { onStart: [said(300, 'Open Alfa.'), ...delegate(600, 'd1', { id: 'c1', name: 'get', args: { ref: 'initiative:alfa' } })] })], { get: one });
  try {
    await h.c.start();
    await h.clock.advance(3000);
    assert.equal(h.c.getSnapshot().choice, null);
    assert.equal(h.clientEvents('choice-shown').length, 0);
    h.c.dispose();
  } finally { h.restore(); }
});
