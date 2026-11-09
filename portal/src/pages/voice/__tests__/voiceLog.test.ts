// The Voice log (G20), now System › Logging's Voice source (G37): a fixture
// session rendered through the real Logging view (bundled with esbuild,
// rendered with react-dom/server) at its route, and the model's pure
// formatting and copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dayGroups, eventData, logJson, parseRange, sessionFacts, sessionHref, sessionSubline, sessionsApi, sinceFor, voiceRecord, voiceRows, callDetail, tokensPerResponse, tokensFact, conversationRows, conversationHealth, contextFact, keptWordsFor, type VoiceSessionDetail, type VoiceSessionListItem } from '../voiceLogModel.ts';
import { renderLogging } from '../../logging/__tests__/renderLogging.ts';

const ID = 'vs_00000000-0000-0000-0000-0000000000dd';

const ITEM: VoiceSessionListItem = {
  id: ID, tenant: 'orgiq', mock: true, startedAt: '2026-11-08T22:10:00Z', endedAt: '2026-11-08T22:10:15Z', seconds: 15, maxSeconds: 1800,
  costUsd: 0.0125, costBasis: 'estimated', toolCallCount: 1, lastOutcome: 'refused', stopReason: 'closed',
};
const DETAIL: VoiceSessionDetail = {
  session: { ...ITEM, model: 'gpt-live-1', voice: null, usdPerMinute: 0.05, holdId: 'h1', provider: { seconds: null, inputTokens: null, outputTokens: null, cachedTokens: null } },
  toolCalls: [{ id: 'tc1', at: '2026-11-08T22:10:05Z', tool: 'queue_work', outcome: 'refused', argsSha256: 'a'.repeat(64), confirmedBy: null, durationMs: 42 }],
  events: [
    { seq: 1, at: '2026-11-08T22:10:00Z', kind: 'minted', data: { mock: true } },
    { seq: 2, at: '2026-11-08T22:10:01Z', kind: 'client', data: { event: 'phase', phase: 'listening', from: 'connecting' } },
    { seq: 3, at: '2026-11-08T22:10:05Z', kind: 'refused', data: { tool: 'queue_work', reason: 'budget' } },
    { seq: 4, at: '2026-11-08T22:10:15Z', kind: 'closed', data: { stopReason: 'closed', seconds: 15 } },
  ],
};

function renderView(p: { sessions: VoiceSessionListItem[]; selectedId: string | null; detail: VoiceSessionDetail | null; keep: boolean; transcript: unknown; range?: string }, at = `/iq/logging/voice/${ID}`): Promise<string> {
  const noop = () => {};
  return renderLogging({
    source: 'voice', rows: voiceRows(p.sessions), selectedKey: p.selectedId ? `session/${p.selectedId}` : null,
    record: p.detail ? voiceRecord(p.detail) : null, onDownload: noop, ...(p.range ? { range: p.range } : {}),
    voice: { keep: p.keep, onKeepChange: noop, transcript: p.transcript },
  }, at);
}

test('the view renders a fixture session: the rail row, the facts, the tool call, every event and the kept turns', async () => {
  const html = await renderView({
    sessions: [ITEM], selectedId: ID, detail: DETAIL, keep: true,
    transcript: { sessionId: ID, savedAt: '2026-11-08T22:10:16Z', turns: [{ role: 'you', text: 'Dispatch the top three', at: 1 }, { role: 'assistant', text: 'That is over the budget.', at: 2 }] },
  });
  assert.match(html, /data-testid="logging"/);
  // The house cascade: the flush list rail (ListRailLayout), the shell trail first, one title.
  assert.match(html, /data-shell-flush/, 'a flush page, not a box inside the content');
  assert.match(html, /data-testid="section-crumbs"/, 'the trail band leads the content column');
  assert.match(html, />System</, 'the trail names the System section');
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1, 'one title');
  assert.match(html, /<h1[^>]*>[^<]*Logging/, 'the title is the page, not the source');
  assert.match(html, />Logging</, 'the trail names Logging');
  assert.match(html, /aria-label="Source"/, 'the source control leads the filter row');
  assert.match(html, /aria-label="Started"/, 'the range control');
  assert.match(html, /orgiq · 15s · 1 tool call · closed · scripted/, 'the rail row');
  assert.match(html, new RegExp(ID), 'the session id in the facts');
  assert.match(html, /queue_work/);
  for (const kind of ['minted', 'client', 'refused', 'closed']) assert.match(html, new RegExp(`>${kind}<`), kind);
  assert.match(html, /&quot;reason&quot;:&quot;budget&quot;/, 'the refusal code in the event row');
  assert.match(html, /Dispatch the top three/, 'the kept turns from this device');
  assert.match(html, /Copy as JSON/);
  assert.match(html, /Download export/);
  assert.match(html, /Keep transcripts on this device/);
  assert.doesNotMatch(html, /role="dialog"/);
});

test('without a kept transcript the view says so, and with nothing picked it asks for a pick', async () => {
  const off = await renderView({ sessions: [ITEM], selectedId: ID, detail: DETAIL, keep: false, transcript: null });
  assert.match(off, /Not kept\. Turn on/);
  const none = await renderView({ sessions: [ITEM], selectedId: null, detail: null, keep: false, transcript: null }, '/iq/logging/voice');
  assert.match(none, /Pick a record/);
  assert.doesNotMatch(none, /Copy as JSON/);
  const empty = await renderView({ sessions: [], selectedId: null, detail: null, keep: false, transcript: null }, '/iq/logging/voice');
  assert.match(empty, /No voice sessions yet/);
  const narrowed = await renderView({ sessions: [], selectedId: null, detail: null, keep: false, transcript: null, range: 'today' }, '/iq/logging/voice');
  assert.match(narrowed, /Nothing in this range/);
});

test('the model: subline, facts, event data and the copy with the kept transcript', () => {
  assert.equal(sessionSubline(ITEM), 'orgiq · 15s · 1 tool call · closed · scripted');
  assert.equal(sessionHref(ID), `/iq/logging/voice/${ID}`);
  assert.equal(parseRange('today'), 'today');
  assert.equal(parseRange('bogus'), 'all');
  const now = new Date(2026, 10, 8, 17, 49);
  assert.equal(sinceFor('all', now), null);
  assert.equal(sinceFor('today', now), new Date(2026, 10, 8).toISOString());
  assert.equal(sinceFor('week', now), new Date(2026, 10, 2).toISOString());
  assert.equal(sessionsApi('all', now), '/api/voice/sessions?limit=50');
  assert.match(sessionsApi('today', now), /&since=2026-11-0/);
  const older = { ...ITEM, id: 'b', startedAt: new Date(2026, 10, 7, 9).toISOString() };
  const g = dayGroups([{ ...ITEM, startedAt: new Date(2026, 10, 8, 9).toISOString() }, older], now);
  assert.deepEqual(g.groups.map((x) => [x.title, x.count]), [['Today', 1], ['Yesterday', 1]]);
  assert.deepEqual(sessionFacts(DETAIL).find((f) => f.label === 'Length'), { label: 'Length', value: '15s of 30m 0s' });
  assert.equal(eventData({}), '');
  assert.equal(eventData({ tool: 'queue_work', reason: 'budget' }), '{"tool":"queue_work","reason":"budget"}');
  const copied = JSON.parse(logJson(DETAIL, { sessionId: ID, savedAt: 'x', turns: [{ role: 'you', text: 'hi', at: 1 }] }));
  assert.equal(copied.session.id, ID);
  assert.equal(copied.events.length, 4);
  assert.deepEqual(copied.transcript.turns, [{ role: 'you', text: 'hi', at: 1 }]);
  assert.equal(JSON.parse(logJson(DETAIL, null)).transcript, undefined);
});

test('G47: the record\'s call Detail shows a failed call\'s code and gate from its tool-result summary', () => {
  const events = [
    { seq: 1, at: '2026-11-09T01:40:00Z', kind: 'tool-result', data: { toolCallId: 'c1', summary: { outcome: 'refused', reason: 'budget', code: 'http-409', gate: 'run-budget' } } },
    { seq: 2, at: '2026-11-09T01:40:01Z', kind: 'tool-result', data: { toolCallId: 'c2', summary: { outcome: 'failed', code: 'receipt-timeout' } } },
    { seq: 3, at: '2026-11-09T01:40:02Z', kind: 'tool-result', data: { toolCallId: 'c3', summary: { outcome: 'refused', reason: 'not-found' } } },
  ];
  assert.equal(callDetail({ id: 'c1', outcome: 'refused', confirmedBy: 'voice' }, events), 'confirmed by voice · code: http-409 · gate:run-budget');
  assert.equal(callDetail({ id: 'c2', outcome: 'failed', confirmedBy: 'click' }, events), 'confirmed by click · code: receipt-timeout');
  assert.equal(callDetail({ id: 'c3', outcome: 'refused', confirmedBy: null }, events), 'refused: not-found');
  assert.equal(callDetail({ id: 'c9', outcome: 'done', confirmedBy: null }, events), '');
});

/** The sideband usage rows of the 01:36 session (vs_d69bbb23), cumulative, as logged. */
const USAGE_0136 = [
  [0, 0, null], [49344, 5, '01:36:54'], [130969, 12, '01:37:28'], [183463, 16, '01:37:59'], [990144, 59, '01:42:09'], [990144, 59, '01:42:39'],
].map(([input, responses], i) => ({ seq: 100 + i, at: '2026-11-09T01:40:00Z', kind: 'usage', data: { source: 'sideband', inputTokens: i === 0 ? null : input, responses } }));

test('G53: input tokens per response from the cumulative sideband rows: a fact on the record and a column on its events table', async () => {
  const per = tokensPerResponse(USAGE_0136);
  assert.deepEqual([...per.entries()], [
    [101, { perResponse: 9869, responses: 5 }], [102, { perResponse: 11661, responses: 7 }], [103, { perResponse: 13124, responses: 4 }], [104, { perResponse: 18760, responses: 43 }],
  ], 'a row with no new responses (the last) adds nothing');
  assert.equal(tokensFact(USAGE_0136), '9,869 → 18,760 per response (59 responses)');
  assert.equal(tokensFact(DETAIL.events), null);
  const detail = { ...DETAIL, events: [...DETAIL.events, ...USAGE_0136] };
  const record = voiceRecord(detail);
  assert.deepEqual(record.facts.at(-1), { label: 'Input per response', value: '9,869 → 18,760 per response (59 responses)' });
  assert.equal(record.events.find((e) => e.seq === 102)!.tokens, '11,661 (7)');
  const html = await renderView({ sessions: [ITEM], selectedId: ID, detail, keep: false, transcript: null });
  assert.match(html, /Input \/ response/);
  assert.match(html, /11,661 \(7\)/);
  // A record without usage rows has no such column.
  assert.doesNotMatch(await renderView({ sessions: [ITEM], selectedId: ID, detail: DETAIL, keep: false, transcript: null }), /Input \/ response/);
});

// ── G63: the Conversation table and its health line, from heard and spoke rows (no words on the server) ──

const T0 = Date.parse('2026-11-08T22:10:00Z');
const heardRow = (seq: number, sec: number, outcome: string, extra: Record<string, unknown> = {}) =>
  ({ seq, at: new Date(T0 + (sec + 8) * 1000).toISOString(), kind: 'client', data: { event: 'heard', n: seq, wordCount: 5, ms: 1800, outcome, afterMs: outcome === 'ignored' || outcome === 'answered' ? null : 300, delegations: outcome === 'delegated' ? 1 : 0, atMs: T0 + sec * 1000, ...extra } });
const spokeRow = (seq: number, sec: number, after: string) =>
  ({ seq, at: new Date(T0 + (sec + 2) * 1000).toISOString(), kind: 'client', data: { event: 'spoke', n: seq, wordCount: 9, ms: 3000, after, atMs: T0 + sec * 1000 } });
const CONVERSATION: VoiceSessionDetail = {
  ...DETAIL,
  events: [
    ...DETAIL.events.slice(0, 2),
    heardRow(10, 2, 'delegated'), spokeRow(11, 3, 'result'),
    heardRow(12, 20, 'answered'), spokeRow(13, 21, 'user'),
    heardRow(14, 40, 'card', { delegations: 1 }),
    heardRow(15, 60, 'ignored'), heardRow(16, 70, 'ignored'),
    spokeRow(17, 90, 'unprompted'),
    { seq: 18, at: '2026-11-08T22:11:40Z', kind: 'client', data: { event: 'context', ratio: 0.0153, seconds: 100 } },
    { seq: 19, at: '2026-11-08T22:11:50Z', kind: 'usage', data: { source: 'sideband', seconds: 110, contextRatio: 0.0171, responses: 2, inputTokens: 20_000 } },
    { seq: 20, at: '2026-11-08T22:11:55Z', kind: 'client', data: { event: 'heard', wordCount: 1, outcome: 'free words here' } },
  ],
};

test('G63 the model: conversation rows in the order they began, the health line, the context fact; a malformed row is skipped', () => {
  const rows = conversationRows(CONVERSATION.events);
  assert.deepEqual(rows.map((r) => [r.who, r.outcome]), [
    ['you', 'delegated'], ['voice', 'result'], ['you', 'answered'], ['voice', 'user'], ['you', 'card'], ['you', 'ignored'], ['you', 'ignored'], ['voice', 'unprompted'],
  ]);
  assert.equal(rows[0]!.detail, '300 ms after');
  assert.equal(rows[4]!.detail, '300 ms after · 1 delegations');
  assert.equal(conversationHealth(rows), '5 heard: 1 delegated, 1 answered, 1 card, 2 ignored · the voice spoke 3 times (1 unprompted)');
  assert.equal(conversationHealth([]), null);
  assert.equal(contextFact(CONVERSATION.events), '1.7% of its window at most');
  const record = voiceRecord(CONVERSATION);
  assert.equal(record.conversation?.rows.length, 8);
  assert.deepEqual(record.facts.filter((f) => f.label === 'Conversation' || f.label === 'Voice context').map((f) => f.value), [
    '5 heard: 1 delegated, 1 answered, 1 card, 2 ignored · the voice spoke 3 times (1 unprompted)', '1.7% of its window at most',
  ]);
  assert.equal(voiceRecord(DETAIL).conversation, undefined, 'a session logged before G63 has no conversation');
});

test('G63 the kept words go beside their rows on this device only: matched by side and start time, never from the server', () => {
  const rows = conversationRows(CONVERSATION.events);
  const kept = { sessionId: ID, savedAt: '2026-11-08T22:12:00Z', turns: [
    { role: 'you' as const, text: 'Open the docs tab', at: T0 + 2100 },
    { role: 'assistant' as const, text: 'Done.', at: T0 + 3050 },
    { role: 'you' as const, text: 'Are you there?', at: T0 + 70_200 },
    { role: 'you' as const, text: 'Nobody near this', at: T0 + 500_000 },
  ] };
  const words = keptWordsFor(rows, kept);
  assert.equal(words.get(rows[0]!.id), 'Open the docs tab');
  assert.equal(words.get(rows[1]!.id), 'Done.');
  assert.equal(words.get(rows[6]!.id), 'Are you there?');
  assert.equal(words.size, 3);
  assert.equal(keptWordsFor(rows, null).size, 0);
});

test('G63 the view: a Conversation table with the health line; the Said column only with words kept on this device', async () => {
  const off = await renderView({ sessions: [ITEM], selectedId: ID, detail: CONVERSATION, keep: false, transcript: null });
  assert.match(off, /data-testid="logging-conversation"/);
  assert.match(off, /5 heard: 1 delegated, 1 answered, 1 card, 2 ignored/);
  assert.match(off, /unprompted/);
  assert.doesNotMatch(off, /Said \(this device\)/);
  const on = await renderView({ sessions: [ITEM], selectedId: ID, detail: CONVERSATION, keep: true,
    transcript: { sessionId: ID, savedAt: '2026-11-08T22:12:00Z', turns: [{ role: 'you', text: 'Open the docs tab', at: T0 + 2100 }] } });
  assert.match(on, /Said \(this device\)/);
  assert.match(on, /Open the docs tab/);
  assert.doesNotMatch(await renderView({ sessions: [ITEM], selectedId: ID, detail: DETAIL, keep: false, transcript: null }), /logging-conversation/);
});
