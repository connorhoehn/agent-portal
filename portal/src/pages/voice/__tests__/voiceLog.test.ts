// The Voice log view (G20): a fixture session rendered through the real page
// component (bundled with esbuild, rendered with react-dom/server), and the
// model's pure formatting and copy.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eventData, logJson, sessionFacts, sessionHref, sessionSubline, type VoiceSessionDetail, type VoiceSessionListItem } from '../voiceLogModel.ts';

const PORTAL = fileURLToPath(new URL('../../../../', import.meta.url));
const OUT = `${PORTAL}node_modules/.cache/voice-log-test`;
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

async function renderView(props: Record<string, unknown>): Promise<string> {
  const { build } = await import('esbuild');
  mkdirSync(OUT, { recursive: true });
  await build({
    stdin: {
      contents: `import { renderToStaticMarkup } from 'react-dom/server'; import { createElement } from 'react'; import { MemoryRouter } from 'react-router';
        import { VoiceLogView } from './src/pages/voice/VoiceLogPage.tsx';
        export const render = (p) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(VoiceLogView, p)));`,
      resolveDir: PORTAL, loader: 'tsx',
    },
    bundle: true, platform: 'node', format: 'esm', packages: 'external', jsx: 'automatic', logLevel: 'error', outfile: `${OUT}/view.mjs`,
    plugins: [{
      name: 'voice-log-stubs',
      setup(b) {
        b.onResolve({ filter: /hooks\/useFetch$/ }, () => ({ path: 'fetch', namespace: 'stub' }));
        b.onResolve({ filter: /\.css$/ }, () => ({ path: 'css', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({ loader: 'js', contents: a.path === 'fetch' ? 'export const useFetch = () => ({ data: null, error: null });' : '' }));
      },
    }],
  });
  const m = await import(`${OUT}/view.mjs?${Date.now()}`) as { render(p: unknown): string };
  const noop = () => {};
  return m.render({ onKeepChange: noop, onSelect: noop, onCopy: noop, onDownload: noop, ...props });
}

test('the view renders a fixture session: the rail row, the facts, the tool call, every event and the kept turns', async () => {
  const html = await renderView({
    sessions: [ITEM], selectedId: ID, detail: DETAIL, keep: true,
    transcript: { sessionId: ID, savedAt: '2026-11-08T22:10:16Z', turns: [{ role: 'you', text: 'Dispatch the top three', at: 1 }, { role: 'assistant', text: 'That is over the budget.', at: 2 }] },
  });
  assert.match(html, /data-testid="voice-log"/);
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
  const none = await renderView({ sessions: [ITEM], selectedId: null, detail: null, keep: false, transcript: null });
  assert.match(none, /Pick a session/);
  assert.doesNotMatch(none, /Copy as JSON/);
  const empty = await renderView({ sessions: [], selectedId: null, detail: null, keep: false, transcript: null });
  assert.match(empty, /No voice sessions yet/);
});

test('the model: subline, facts, event data and the copy with the kept transcript', () => {
  assert.equal(sessionSubline(ITEM), 'orgiq · 15s · 1 tool call · closed · scripted');
  assert.equal(sessionHref(ID), `/voice/log?session=${ID}`);
  assert.deepEqual(sessionFacts(DETAIL).find((f) => f.label === 'Length'), { label: 'Length', value: '15s of 30m 0s' });
  assert.equal(eventData({}), '');
  assert.equal(eventData({ tool: 'queue_work', reason: 'budget' }), '{"tool":"queue_work","reason":"budget"}');
  const copied = JSON.parse(logJson(DETAIL, { sessionId: ID, savedAt: 'x', turns: [{ role: 'you', text: 'hi', at: 1 }] }));
  assert.equal(copied.session.id, ID);
  assert.equal(copied.events.length, 4);
  assert.deepEqual(copied.transcript.turns, [{ role: 'you', text: 'hi', at: 1 }]);
  assert.equal(JSON.parse(logJson(DETAIL, null)).transcript, undefined);
});
