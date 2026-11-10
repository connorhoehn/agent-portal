// Run with:  cd portal && node --test 'src/components/chat/__tests__/channelPlane.test.ts'
//
// A Social channel never reaches a tenant-conversation route (second regression walk, 10 November:
// the bound initiative's pane polled GET /api/conversations/agent/waiting?channel=social:ch:… and got 400).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { channelPlane, SOCIAL_ON_TENANT_ROUTE } from '../channelPlane.ts';
import { conversationPlaneApis } from '../conversationPlane.ts';
import { conversationAgentApi } from '../conversationAgent.ts';
import { conversationSummarizeApi } from '../conversationSummarize.ts';
import { conversationArtifactApi } from '../conversationArtifact.ts';

const recorder = () => {
  const urls: string[] = [];
  const stub = (async (url: string) => { urls.push(url); return { ok: true, json: async () => ({ runs: [], runId: 'r', pipelineId: 'p', card: {} }) }; }) as unknown as typeof fetch;
  return { urls, stub };
};

/** Every call of one plane's set that names a channel. */
async function callAll(channel: string, doFetch: typeof fetch): Promise<void> {
  const apis = conversationPlaneApis(channel);
  await apis.agentApi.waiting(channel, doFetch);
  await apis.agentApi.start(channel, 'wrap up', doFetch);
  await apis.summarizeApi.start(channel, '', doFetch);
  await apis.artifactApi('diagram').start(channel, '', doFetch);
  await apis.artifactApi('doc').start(channel, '', doFetch);
}

test('the plane follows the channel prefix', () => {
  assert.equal(channelPlane('social:ch:auth-migration'), 'social');
  assert.equal(channelPlane('social:dm:u-a:u-b'), 'social');
  assert.equal(channelPlane('orgiq:initiative:p-auth-migration'), 'tenant');
  assert.equal(channelPlane('pipelines:run:r-1'), 'tenant');
});

test('a Social channel: every command call and the waiting poll go to Social routes, none to /api/conversations', async () => {
  const { urls, stub } = recorder();
  for (const channel of ['social:ch:auth-migration', 'social:ch:observability']) await callAll(channel, stub);
  assert.equal(urls.length, 10);
  assert.deepEqual(urls.filter(u => u.startsWith('/api/conversations')), []);
  assert.ok(urls.every(u => u.startsWith('/api/chat/commands/')), urls.join(', '));
  assert.ok(urls.includes('/api/chat/commands/agent/waiting?channel=social%3Ach%3Aauth-migration'));
  // The Social command list carries /agent (so the waiting card loads) and Social's own /summarize and /deck.
  const triggers = conversationPlaneApis('social:ch:auth-migration').commands.map(c => c.trigger);
  assert.deepEqual(triggers, ['/summarize', '/deck', '/diagram', '/doc', '/agent']);
});

test('a tenant conversation keeps the tenant routes', async () => {
  const { urls, stub } = recorder();
  await callAll('orgiq:initiative:p-auth-migration', stub);
  assert.ok(urls.every(u => u.startsWith('/api/conversations/')), urls.join(', '));
});

test('the tenant request builders refuse a Social channel before any request', async () => {
  const { urls, stub } = recorder();
  const channel = 'social:ch:auth-migration';
  await assert.rejects(conversationAgentApi.waiting(channel, stub), { message: SOCIAL_ON_TENANT_ROUTE });
  await assert.rejects(conversationAgentApi.start(channel, 'goal', stub), { message: SOCIAL_ON_TENANT_ROUTE });
  await assert.rejects(conversationSummarizeApi.start(channel, '', stub), { message: SOCIAL_ON_TENANT_ROUTE });
  await assert.rejects(conversationArtifactApi('diagram').start(channel, '', stub), { message: SOCIAL_ON_TENANT_ROUTE });
  await assert.rejects(conversationArtifactApi('doc').start(channel, '', stub), { message: SOCIAL_ON_TENANT_ROUTE });
  assert.deepEqual(urls, []);
});
