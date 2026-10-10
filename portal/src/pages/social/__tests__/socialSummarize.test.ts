// Run with:  cd portal && node --test 'src/pages/social/__tests__/socialSummarize.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  agentRunStatusOf, canPost, reviewMarkdown, fetchSummarizeStatus, isTerminal, pollDelayMs, requestSummaryPost, socialSummarizeCommand,
  startSummarize, type SummarizeRunStatus,
} from '../socialSummarize.ts';

const status = (over: Partial<SummarizeRunStatus> = {}): SummarizeRunStatus => ({
  runId: 'sum-1', channel: 'social:ch:general', phase: 'completed', posted: false, error: null,
  steps: [{ id: 'read-history', label: 'Read the conversation', status: 'completed' }],
  result: { title: 't', summary: 's', content: '## Summary', sourceSpans: [], messageCount: 3, fallback: false }, ...over,
});

const reply = (body: unknown, ok = true) => (async () => ({ ok, json: async () => body })) as unknown as typeof fetch;

test('start sends the channel and range text; the server error text survives', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const stub = (async (url: string, init: RequestInit) => { seen = { url, init }; return { ok: true, json: async () => ({ runId: 'sum-1', pipelineId: 'p', card: {} }) }; }) as unknown as typeof fetch;
  await startSummarize('social:ch:general', 'last 2h', stub);
  assert.equal(seen!.url, '/api/chat/commands/summarize/run');
  assert.deepEqual(JSON.parse(String(seen!.init.body)), { channel: 'social:ch:general', text: 'last 2h' });
  await assert.rejects(startSummarize('c', 'x', reply({ error: 'Give a range' }, false)), /Give a range/);
  await assert.rejects(fetchSummarizeStatus('sum-1', reply(null, false)), /could not be read/);
});

test('the post step is a distinct request that returns the message to send', async () => {
  let method = '';
  const stub = (async (_u: string, init: RequestInit) => { method = String(init.method); return { ok: true, json: async () => ({ channel: 'c', text: 'T', metadata: {} }) }; }) as unknown as typeof fetch;
  assert.equal((await requestSummaryPost('sum-1', stub)).text, 'T');
  assert.equal(method, 'POST');
});

test('the command is private by default and scoped by the library', async () => {
  assert.equal(socialSummarizeCommand.trigger, '/summarize');
  const outcome = await (async () => {
    const original = globalThis.fetch;
    globalThis.fetch = reply({ runId: 'sum-9', pipelineId: 'conversation-summarize', card: { kind: 'agent-run' } });
    try {
      return await socialSummarizeCommand.run({ channel: 'social:ch:x', text: '/summarize 24h', argumentText: '24h' } as never);
    } finally { globalThis.fetch = original; }
  })();
  assert.deepEqual(outcome, { kind: 'run', runId: 'sum-9', pipelineId: 'conversation-summarize', card: { kind: 'agent-run' }, echo: '/summarize 24h', visibility: 'private' });
});

test('status maps to the run card and gates posting', () => {
  assert.equal(isTerminal(status()), true);
  assert.equal(isTerminal(status({ phase: 'running' })), false);
  assert.equal(canPost(status()), true);
  assert.equal(canPost(status({ posted: true })), false);
  assert.equal(canPost(status({ phase: 'running', result: null })), false);
  assert.equal(canPost(status({ result: { title: '', summary: '', content: '', sourceSpans: [], messageCount: 0, fallback: false } })), false);
  const running = agentRunStatusOf(status({ phase: 'running', steps: [{ id: 'a', label: 'Write', status: 'running' }] }));
  assert.equal(running.stepLabel, 'Write');
  assert.match(agentRunStatusOf(status({ phase: 'failed', error: 'boom' })).detail ?? '', /boom/);
  assert.match(agentRunStatusOf(status({ result: { ...status().result!, fallback: true } })).detail ?? '', /digest/);
});

test('polling backs off and is capped', () => {
  assert.ok(pollDelayMs(0) < pollDelayMs(3));
  assert.equal(pollDelayMs(1000), 2500);
});

test('the review shows the summary with every quote attributed', () => {
  const md = reviewMarkdown({ ...status().result!, sourceSpans: [{ text: 'Release is Thursday.', messageId: 'a', author: 'Mira' }] });
  assert.match(md, /^## Summary/);
  assert.match(md, /> "Release is Thursday\." — Mira/);
  assert.equal(reviewMarkdown(status().result!), '## Summary');
});
