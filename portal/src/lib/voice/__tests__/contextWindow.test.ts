// G31 (docs/voice-navigator-gaps.md, the 23:03 session: 17 k input tokens per
// delegation by its end): the model gets compact results, the page note is
// replaced rather than added to, and across a 20-turn scripted session the
// delegation's estimated input stays under 10 k tokens.

import test from 'node:test';
import assert from 'node:assert/strict';
import { VoiceController } from '../controller.ts';
import { VoiceClient } from '../client.ts';
import { ResultMemory } from '../tools.ts';
import { CONTEXT_FULL_TURNS, DelegationContext, OUTPUT_MAX_CHARS, PAGE_NOTE_REPLACES, estimateTokens, modelOutput, summaryLine } from '../contextWindow.ts';
import { pageContextNote, type PublishedPage } from '../pageContext.ts';
import { FakeClock, fakeFetch, middlewareVoice, route, toolContext } from './voiceHarness.ts';

const SESSION = 'vs_00000000-0000-0000-0000-0000000000ae';

test('modelOutput: no links, lists cut from the end to fit with `more`, small outputs untouched', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ref: `initiative:p${i}`, title: `Initiative number ${i} with a long enough name to matter`, subtitle: 'x'.repeat(100), href: `/iq/projects/p${i}` }));
  const out = modelOutput({ kind: 'list', count: 40, rows, open: 'open opens a row', hint: { item: 'role:x', href: '/access/requests/new?item=role:x' } });
  assert.ok(JSON.stringify(out).length <= OUTPUT_MAX_CHARS);
  assert.doesNotMatch(JSON.stringify(out), /href|\/iq\/projects/);
  const kept = (out['rows'] as unknown[]).length;
  assert.ok(kept < 10 && kept > 0);
  assert.equal(out['more'], 10 - kept);
  assert.deepEqual((out['hint'] as Record<string, unknown>), { item: 'role:x' });
  const small = { kind: 'opened', ref: 'initiative:p1', title: 'Alpha' };
  assert.deepEqual(modelOutput(small), small);
});

test('DelegationContext: results older than six turns count as one line; the page note is replaced; sentChars keeps everything', () => {
  const c = new DelegationContext();
  for (let i = 0; i < 10; i++) { c.newTurn(); c.result(1000, summaryLine('list', `Turn ${i}`)); c.pageNote(`page ${i}`); }
  const lines = 4 * (summaryLine('list', 'Turn 0').length + 1);
  assert.equal(c.windowChars(), CONTEXT_FULL_TURNS * 1000 + lines + 'page 9'.length);
  assert.equal(c.agedLines().length, 4);
  assert.equal(c.sentChars(), 10 * 1000 + 10 * 'page 0'.length);
});

/** Twenty user requests, one delegation each, rotating through five reads; each delegation's continuation completes it. */
function twentyTurns(calls: Array<{ name: string; args: Record<string, unknown>; said: string }>) {
  const frames: Array<{ atMs: number; event: Record<string, unknown> }> = [
    { atMs: 0, event: { type: 'session.started', session: { id: 'live_mock', model: 'gpt-live-1', status: 'active' } } },
  ];
  calls.forEach((c, i) => {
    const d = `item_d${i + 1}`;
    const env = (event: Record<string, unknown>) => ({ type: 'response.event', delegation_id: d, event });
    const at = 1000 + i * 3000;
    frames.push(
      { atMs: at, event: { type: 'session.input_transcript.delta', delta: c.said, start_ms: at, end_ms: at + 1500 } },
      { atMs: at + 200, event: { type: 'session.delegation.created', delegation: { id: d, type: 'delegation', response_id: `r${i}a`, target: 'responses' } } },
      { atMs: at + 300, event: env({ type: 'response.output_item.done', item: { id: `fc${i}`, type: 'function_call', status: 'completed', arguments: JSON.stringify(c.args), call_id: `call_${i}`, name: c.name } }) },
      { atMs: at + 350, event: env({ type: 'response.completed', response: { id: `r${i}a`, status: 'completed', output: [] } }) },
      { atMs: at + 1500, event: env({ type: 'response.completed', response: { id: `r${i}b`, status: 'completed', output: [] } }) },
      { atMs: at + 1600, event: { type: 'session.output_transcript.delta', delta: 'Here is what I found; the first one is on screen now.', start_ms: at + 1600, end_ms: at + 2600 } },
    );
  });
  return { onStart: frames, onResponseCreate: [], onClose: [{ atMs: 100, event: { type: 'session.closed', reason: 'close_requested', usage: { seconds: 70 } } }] };
}

const PROJECTS = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Initiative ${i}: payments platform migration phase ${i}`, status: i % 3 ? 'active' : 'at-risk', description: 'd'.repeat(200), ownerName: 'Nora Diaz' }));
const WORK = Array.from({ length: 15 }, (_, i) => ({ id: `w${i}`, title: `Work item ${i}: move the ledger writes behind the new service boundary`, status: i % 2 ? 'open' : 'in-progress', priority: i % 4 ? 'medium' : 'high', projectId: 'p1' }));
const PEOPLE = Array.from({ length: 5 }, (_, i) => ({ title: `Person ${i} Lastname`, subtitle: 'Staff platform engineer, Kubernetes and Terraform, payments', href: `/iq/people/u${i}`, type: 'person', id: `u${i}` }));
const PAGE: PublishedPage = {
  path: '/iq/projects/p1', record: { ref: 'initiative:p1', title: PROJECTS[1]!.name }, rowsLabel: 'work items',
  rows: WORK.slice(0, 20).map((w) => ({ ref: `work-item:${w.id}`, title: w.title, status: w.status, priority: w.priority, href: `/iq/projects/p1?item=${w.id}` })),
};

test('G31 acceptance: across a 20-turn scripted session the estimated input per delegation stays under 10 k tokens', async (t) => {
  // The fixed part of every delegation's input: its instructions and the orgiq tools exactly as the mint sends them.
  const cat = await middlewareVoice<{ toolsForTenant: (t: string, o: object) => unknown[]; responsesFunctionTools: (t: unknown[]) => unknown[]; delegationInstructions: (t: string) => string }>('catalogue.ts');
  const ai = await middlewareVoice<{ liveFunctionTool: (t: unknown) => unknown }>('openai.ts');
  const base = cat.delegationInstructions('orgiq').length + JSON.stringify(cat.responsesFunctionTools(cat.toolsForTenant('orgiq', { role: 'sme' })).map(ai.liveFunctionTool)).length;

  const rotation = [
    { name: 'search', args: { query: 'Kubernetes experts', type: 'person', scope: null, sort: null, limit: null, answer: null }, said: 'Who knows Kubernetes?' },
    { name: 'list', args: { kind: 'initiative', filter: null, scope: null, limit: 10 }, said: 'List the initiatives.' },
    { name: 'get', args: { ref: 'initiative:p1', part: null }, said: 'Tell me about the payments one.' },
    { name: 'open', args: { ref: 'initiative:p1', page: null, kind: null, name: null, scope: null, params: null }, said: 'Open it.' },
    { name: 'list', args: { kind: 'work-item', scope: 'this-page', filter: null, limit: 10 }, said: 'What should I work on here?' },
  ];
  const calls = Array.from({ length: 20 }, (_, i) => rotation[i % rotation.length]!);
  const thoughts: string[] = [];
  const sent: string[] = [];
  const proto = VoiceClient.prototype;
  const orig = { think: proto.appendThinking, out: proto.sendToolOutput };
  proto.appendThinking = function (c: string) { thoughts.push(c); return orig.think.call(this, c); };
  proto.sendToolOutput = function (id: string, o: string) { sent.push(o); return orig.out.call(this, id, o); };
  try {
    const clock = new FakeClock();
    const mintBody = {
      sessionId: SESSION, voiceSessionId: SESSION, holdId: 'h1', maxSeconds: 1800, expiresAt: '2026-11-08T13:00:00Z', sdp: 'v=0', mock: true,
      model: 'gpt-live-1', voice: null, toolsEnabled: true, tools: ['search', 'list', 'get', 'open'], budget: { holdUsd: 5, usdPerMinute: 0.05 },
      mockScript: twentyTurns(calls),
    };
    const { fetch } = fakeFetch([
      route('POST', `/api/voice/sessions/${SESSION}/events`, 201, { id: 'row' }),
      route('POST', `/api/voice/sessions/${SESSION}/close`, 200, {}),
      route('POST', '/api/voice/sessions', 201, mintBody),
      route('GET', '/api/search', 200, { results: PEOPLE, total: 5 }),
      route('GET', '/api/graph/projects/p1', 200, { project: PROJECTS[1], work: WORK.length }),
      route('GET', '/api/graph/projects', 200, PROJECTS),
    ]);
    let path = '/iq/projects';
    let pageChanges = 0;
    const ctx = toolContext({ fetch, results: new ResultMemory(), navigate: (p: string) => { const next = p.split('?')[0]!; if (next !== path) pageChanges += 1; path = next; }, page: () => (path === PAGE.path ? PAGE : null) });
    const c = new VoiceController({
      fetch, media: null, toolContext: () => ctx, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      pageContext: () => pageContextNote({ tenant: 'orgiq', pathname: path, pageId: path.startsWith('/iq/projects') ? 'initiatives' : 'search', page: path === PAGE.path ? PAGE : null }),
    });
    await c.start();
    const perDelegation: number[] = [];
    for (let i = 0; i < 20; i++) {
      // Just before turn i's delegation: what it reads is the base plus the window so far.
      await clock.advance(i === 0 ? 1100 : 3000);
      perDelegation.push(estimateTokens(base + c.contextEstimate().windowChars));
    }
    await clock.advance(3000);
    const est = c.contextEstimate();
    t.diagnostic(`base ${base} chars; per delegation (tokens): ${perDelegation.join(', ')}; window ${est.windowChars} chars; sent ${est.sentChars} chars over ${est.turns} turns`);

    assert.equal(est.turns, 20);
    assert.equal(sent.length, 20, 'every call answered');
    const turnsWithTools = c.getSnapshot().turns.flatMap((x) => x.toolCalls ?? []);
    assert.ok(turnsWithTools.every((x) => x.status === 'done'), JSON.stringify(turnsWithTools.filter((x) => x.status !== 'done')));
    assert.ok(Math.max(...perDelegation) < 10_000, `max ${Math.max(...perDelegation)} tokens`);
    assert.ok(estimateTokens(base + est.windowChars) < 10_000);
    // Every output is compact and carries no link.
    for (const o of sent) { assert.ok(o.length <= OUTPUT_MAX_CHARS, `${o.length}`); assert.doesNotMatch(o, /"href"/); }
    // The page note: sent only when the page changed (it says it replaces the earlier ones), never once per result.
    const pageNotes = thoughts.filter((n) => n.startsWith('Page context'));
    assert.ok(pageNotes.length <= pageChanges + 1 && pageNotes.length < 20, `${pageNotes.length} page notes for ${pageChanges} page changes`);
    for (const n of pageNotes) assert.ok(n.endsWith(PAGE_NOTE_REPLACES));
    // The window is what keeps it flat: past the sixth turn a turn adds a line, not a result. Five turns apart the
    // rotation is at the same step (same page, same result), so the difference is five lines and five utterances.
    assert.ok(perDelegation[19]! - perDelegation[14]! < 300 && perDelegation[14]! - perDelegation[9]! < 300, `growth ${perDelegation.join(', ')}`);
    c.dispose();
  } finally {
    proto.appendThinking = orig.think; proto.sendToolOutput = orig.out;
  }
});
