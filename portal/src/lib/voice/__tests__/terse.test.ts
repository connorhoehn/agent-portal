// G33 (docs/voice-navigator-gaps.md, live session vs_95e5a6c7): terse by
// default. list, search and get hand the model the count, three rows, `more`
// and a ready `say` line; `detail: true` hands over every row; the device's
// verbosity goes to the session as context at start.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { ResultMemory } from '../tools.ts';
import { briefOutput, verbosityNote, voiceVerbosity, setVoiceVerbosity, VERBOSITY_KEY } from '../contextWindow.ts';
import type { PublishedPage } from '../pageContext.ts';
import { FakeClock, fakeFetch, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000af';
const TITLES = ['Rotate the signing keys', 'Move session store to Redis', 'Fix the login redirect loop', 'Retire the old token endpoint', 'Audit the admin roles',
  'Add rate limits to login', 'Document the key rotation', 'Remove the legacy cookie', 'Alert on failed logins', 'Load test the auth service', 'Clean up the test users'];
const PAGE: PublishedPage = {
  path: '/iq/projects/p-auth', record: { ref: 'initiative:p-auth', title: 'Auth migration' }, rowsLabel: 'work items',
  rows: TITLES.map((t, i) => ({ ref: `work-item:w-${i + 1}`, title: t, status: 'open', priority: i < 3 ? 'high' : 'medium' })),
};

type Call = { name: string; arguments: Record<string, unknown>; said: string };

async function run(call: Call, verbosity?: 'terse' | 'normal', extra: ReturnType<typeof route>[] = []) {
  const { mockLiveScript } = await middlewareVoice<{ mockLiveScript: (id: string, c: Call) => { onStart: unknown[]; onResponseCreate: unknown[]; onClose: unknown[] } }>('openai.ts');
  const clock = new FakeClock();
  const { fetch } = fakeFetch([
    route('POST', `/api/voice/sessions/${SESSION}/events`, 201, {}),
    route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
    ...extra,
    route('POST', '/api/voice/sessions', 201, {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: [call.name], budget: { holdUsd: 0.5, usdPerMinute: 0.05 }, mockScript: mockLiveScript(SESSION, call),
    }),
  ]);
  const ctx = toolContext({ fetch, role: 'member', allow: ['Search', 'VoiceNavigate'], results: new ResultMemory(), page: () => PAGE });
  const outputs: Array<Record<string, unknown>> = [];
  const thoughts: string[] = [];
  const proto = VoiceClient.prototype;
  const orig = { out: proto.sendToolOutput, think: proto.appendThinking };
  proto.sendToolOutput = function (id: string, o: string) { outputs.push(JSON.parse(o) as Record<string, unknown>); return orig.out.call(this, id, o); };
  proto.appendThinking = function (c: string) { thoughts.push(c); return orig.think.call(this, c); };
  try {
    const c = new VoiceController({ fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...(verbosity ? { verbosity: () => verbosity } : {}) });
    await c.start();
    await clock.advance(4000);
    c.dispose();
    return { outputs, thoughts, ctx };
  } finally { proto.sendToolOutput = orig.out; proto.appendThinking = orig.think; }
}

const LIST: Call = { name: 'list', arguments: { kind: 'work-item', filter: null, scope: 'this-page', limit: null, detail: null }, said: 'What is on this initiative?' };

test('G33 acceptance: an 11-row list hands the model the count, three rows and a spoken line under 25 words with the count and three names', async () => {
  const r = await run(LIST);
  const out = r.outputs[0]!;
  assert.equal(out['count'], 11);
  assert.equal((out['rows'] as unknown[]).length, 3);
  assert.equal(out['more'], 8);
  const say = String(out['say']);
  assert.ok(say.split(/\s+/).length < 25, say);
  assert.match(say, /^11 work items, 3 high priority: /);
  for (const t of TITLES.slice(0, 3)) assert.ok(say.includes(t.split(' ').slice(0, 5).join(' ')), `${t} in "${say}"`);
  // The dock still keeps every row the read returned: "open the fifth one" works.
  assert.equal(r.ctx.results!.find('5')!.ref, 'work-item:w-5');
  // The terse preference reached the session as context, at start.
  assert.ok(r.thoughts.some((t) => t === verbosityNote('terse')));
});

test('G33: detail true hands over all ten rows the list returns; normal verbosity is its own note', async () => {
  const r = await run({ ...LIST, arguments: { ...LIST.arguments, detail: true }, said: 'Read them all.' }, 'normal');
  const out = r.outputs[0]!;
  assert.equal((out['rows'] as unknown[]).length, 10);
  assert.equal(out['say'], undefined);
  assert.ok(r.thoughts.includes(verbosityNote('normal')));
});

test('briefOutput leaves other tools and short or empty lists alone, and reads detail from the raw arguments too', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ ref: `team:t${i}`, title: `Team ${i}` }));
  assert.deepEqual(briefOutput('summary', {}, { rows }), { rows });
  assert.equal((briefOutput('search', '{"query":"x","detail":true}', { rows, total: 5 })['rows'] as unknown[]).length, 5);
  const b = briefOutput('search', '{"query":"x","detail":null}', { rows, total: 40 });
  assert.deepEqual([(b['rows'] as unknown[]).length, b['more'], b['say']], [3, 37, '40 results, top: Team 0. Say "read them" for more.']);
  assert.equal(briefOutput('list', {}, { of: 'team', rows, count: 40 })['say'], '40 teams: Team 0, Team 1 and Team 2, and 37 more.');
  assert.deepEqual(briefOutput('list', {}, { of: 'team', rows: [], count: 0 }), { of: 'team', rows: [], count: 0 });
});

test('the device preference: terse unless set to normal', () => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  try {
    assert.equal(voiceVerbosity(), 'terse');
    setVoiceVerbosity('normal');
    assert.equal(store.get(VERBOSITY_KEY), 'normal');
    assert.equal(voiceVerbosity(), 'normal');
  } finally { delete (globalThis as { localStorage?: unknown }).localStorage; }
});

// G65 (real session, 10 November 2026): after a search the voice spoke 29 words for 9 seconds. A search's `say` is the
// count and the top hit, with "read them" for the rest; the model still gets three rows, so "open the second" works.
const HITS = Array.from({ length: 12 }, (_, i) => ({
  type: 'work-item', id: `w-${i + 1}`, title: TITLES[i % TITLES.length], subtitle: 'Auth migration · open', description: 'Rotate every signing key before the cutover and document the steps for on-call.',
  matchReason: 'title', href: `/iq/projects/p-auth?tab=work&item=w-${i + 1}`,
}));
const SEARCH: Call = { name: 'search', arguments: { query: 'key rotation', type: 'work', scope: null, sort: null, limit: null, answer: null, detail: null }, said: 'Find the key rotation work.' };

test('G65: a search with rows says the count and the top hit in one short line, and "read them" for more', async () => {
  const r = await run(SEARCH, undefined, [route('GET', '/api/search', 200, { results: HITS, total: 12 })]);
  const out = r.outputs[0]!;
  assert.equal(out['count'], 12, JSON.stringify(out));
  assert.equal((out['rows'] as unknown[]).length, 3);
  const say = String(out['say']);
  assert.equal(say, '12 work items, top: Rotate the signing keys. Say "read them" for more.');
  assert.ok(say.split(/\s+/).length <= 15, say);
  assert.doesNotMatch(say, /Move session store/, 'one name, not three');
  assert.equal(r.ctx.results!.find('2')!.ref, 'work-item:w-2', 'open the second still works');
});

test('G65: one hit is the hit; a one-fact answer is its own line; "read them" (detail true) hands every row and no line', () => {
  const one = briefOutput('search', { query: 'x' }, { type: 'decision', query: 'x', total: 1, rows: [{ ref: 'decision:d-1', title: 'Adopt OpenTelemetry' }] });
  assert.equal(one['say'], '1 decision: Adopt OpenTelemetry.');
  const fact = briefOutput('search', { query: 'who decided' }, { type: 'all', total: 4, answer: 'Decided by: Nora DaSilva', rows: HITS.slice(0, 4).map((h) => ({ ref: `work-item:${h.id}`, title: h.title })) });
  assert.equal(fact['say'], 'Decided by: Nora DaSilva');
  const all = briefOutput('search', { query: 'x', detail: true }, { type: 'all', total: 12, rows: HITS.map((h) => ({ ref: `work-item:${h.id}`, title: h.title })) });
  assert.equal(all['say'], undefined);
  assert.equal((all['rows'] as unknown[]).length, 12);
});
