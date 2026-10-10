// Run with:  cd portal && node --test 'src/components/chat/__tests__/conversationSummarize.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_SUMMARIZE_BASE, SOCIAL_SUMMARIZE_BASE, agentRunStatusOf, conversationSummarizeCommand, summarizeApi,
  type SummarizeRunStatus,
} from '../conversationSummarize.ts';

const done = (over: Partial<SummarizeRunStatus['result'] & object> = {}): SummarizeRunStatus => ({
  runId: 'osm-1', channel: 'orgiq:initiative:p-auth', phase: 'completed', posted: false, error: null, steps: [],
  result: { title: 't', summary: 's', content: 'c', sourceSpans: [], messageCount: 2, fallback: false, ...over },
});

test('each mount sends to its own base; tenant conversations and huddles share one', async () => {
  const urls: string[] = [];
  const stub = (async (url: string) => { urls.push(url); return { ok: true, json: async () => ({ runId: 'osm-1', pipelineId: 'p', card: {} }) }; }) as unknown as typeof fetch;
  await summarizeApi(CONVERSATION_SUMMARIZE_BASE).start('orgiq:huddle:call-1', '', stub);
  await summarizeApi(CONVERSATION_SUMMARIZE_BASE).status('osm-1', stub);
  await summarizeApi(CONVERSATION_SUMMARIZE_BASE).requestPost('osm-1', stub);
  await summarizeApi(SOCIAL_SUMMARIZE_BASE).start('social:ch:x', '', stub);
  assert.deepEqual(urls, ['/api/conversations/summarize/run', '/api/conversations/summarize/runs/osm-1',
    '/api/conversations/summarize/runs/osm-1/post', '/api/chat/commands/summarize/run']);
});

test('the shared command is private and starts on the tenant mount', async () => {
  const original = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (u: string) => { url = u; return { ok: true, json: async () => ({ runId: 'psm-1', pipelineId: 'conversation-summarize', card: {} }) }; }) as unknown as typeof fetch;
  try {
    const outcome = await conversationSummarizeCommand.run({ channel: 'pipelines:run:r-1', text: '/summarize', argumentText: '' } as never);
    assert.deepEqual(outcome, { kind: 'run', runId: 'psm-1', pipelineId: 'conversation-summarize', card: {}, echo: '/summarize', visibility: 'private' });
    assert.equal(url, '/api/conversations/summarize/run');
  } finally { globalThis.fetch = original; }
});

test('a digest stands in, and says why when Nova was unavailable for the tenant', () => {
  assert.match(agentRunStatusOf(done({ fallback: true })).detail ?? '', /could not be verified/);
  assert.match(agentRunStatusOf(done({ fallback: true, unavailable: "only serves 'assessment'" })).detail ?? '', /not available for this conversation.*assessment/);
  assert.equal(agentRunStatusOf(done()).detail, undefined);
});
