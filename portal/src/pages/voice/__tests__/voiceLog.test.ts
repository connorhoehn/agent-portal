// The Voice log (G20), now System › Logging's Voice source (G37): a fixture
// session rendered through the real Logging view (bundled with esbuild,
// rendered with react-dom/server) at its route, and the model's pure
// formatting and copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dayGroups, eventData, logJson, parseRange, sessionFacts, sessionHref, sessionSubline, sessionsApi, sinceFor, voiceRecord, voiceRows, type VoiceSessionDetail, type VoiceSessionListItem } from '../voiceLogModel.ts';
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
