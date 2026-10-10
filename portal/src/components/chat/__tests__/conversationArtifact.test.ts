// Run with:  cd portal && node --test 'src/components/chat/__tests__/conversationArtifact.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_ARTIFACT_BASE, SOCIAL_ARTIFACT_BASE, agentRunStatusOf, artifactApi, artifactCommand, artifactFile, artifactKindOf,
  canPost, canSave, conversationArtifactApi, sourcesMarkdown, type ArtifactResult, type ArtifactRunStatus,
} from '../conversationArtifact.ts';
import { CONVERSATION_CHAT_COMMANDS, socialChatCommands } from '../chatCommandRegistry.ts';

const result = (over: Partial<ArtifactResult> = {}): ArtifactResult => ({
  command: 'diagram', title: 'Release flow', summary: 's', content: '<mxGraphModel/>', format: 'drawio',
  sourceSpans: [{ text: 'Release is Thursday.', messageId: 'm1', author: 'Mira' }], nodes: [], edges: [], messageCount: 2, fallback: false, ...over,
});
const done = (over: Partial<ArtifactRunStatus> = {}, r: Partial<ArtifactResult> = {}): ArtifactRunStatus => ({
  runId: 'sdg-1', channel: 'social:ch:general', phase: 'completed', posted: false, error: null, steps: [], result: result(r), ...over,
});

test('each command on each mount calls its own routes', async () => {
  const calls: Array<[string, string]> = [];
  const stub = (async (url: string, init?: RequestInit) => { calls.push([init?.method ?? 'GET', url]); return { ok: true, json: async () => ({ runId: 'x', pipelineId: 'p', card: {} }) }; }) as unknown as typeof fetch;
  const social = artifactApi(SOCIAL_ARTIFACT_BASE, 'diagram');
  await social.start('social:ch:x', 'topic', stub); await social.status('sdg-1', stub); await social.requestPost('sdg-1', stub);
  const tenant = artifactApi(CONVERSATION_ARTIFACT_BASE, 'doc');
  await tenant.start('assessment:doc:d1', 'Title', stub); await tenant.requestSave('adc-1', 'workspace_drafts/d-9', stub);
  assert.deepEqual(calls, [
    ['POST', '/api/chat/commands/diagram/run'], ['GET', '/api/chat/commands/diagram/runs/sdg-1'], ['POST', '/api/chat/commands/diagram/runs/sdg-1/post'],
    ['POST', '/api/conversations/doc/run'], ['POST', '/api/conversations/doc/runs/adc-1/save'],
  ]);
});

test('the topic travels as the argument text, and Save carries only the id of the page the tenant made', async () => {
  const bodies: unknown[] = [];
  const stub = (async (_url: string, init?: RequestInit) => { bodies.push(JSON.parse(String(init?.body))); return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
  await artifactApi(SOCIAL_ARTIFACT_BASE, 'doc').start('social:dm:a:b', 'Runbook notes', stub);
  await artifactApi(SOCIAL_ARTIFACT_BASE, 'doc').requestSave('sdc-1', undefined, stub);
  await artifactApi(CONVERSATION_ARTIFACT_BASE, 'doc').requestSave('adc-1', 'workspace_drafts/d-9', stub);
  assert.deepEqual(bodies, [{ channel: 'social:dm:a:b', text: 'Runbook notes' }, {}, { documentId: 'workspace_drafts/d-9' }]);
});

test('a refusal throws the server\'s own message', async () => {
  const stub = (async () => ({ ok: false, status: 409, json: async () => ({ error: 'This workspace has no document store to save a page into' }) })) as unknown as typeof fetch;
  await assert.rejects(artifactApi(CONVERSATION_ARTIFACT_BASE, 'doc').requestSave('odc-1', undefined, stub), /no document store/);
  const empty = (async () => ({ ok: false, status: 500, json: async () => { throw new Error('no body'); } })) as unknown as typeof fetch;
  await assert.rejects(artifactApi(SOCIAL_ARTIFACT_BASE, 'diagram').start('c', '', empty), /could not be started/);
});

test('the commands are private runs that start on their mount, echoing what was typed', async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: string) => { urls.push(u); return { ok: true, json: async () => ({ runId: 'odc-1', pipelineId: 'conversation-doc', card: { kind: 'agent-run' } }) }; }) as unknown as typeof fetch;
  try {
    const doc = artifactCommand(conversationArtifactApi('doc'));
    assert.equal(doc.trigger, '/doc');
    assert.deepEqual(await doc.run({ channel: 'orgiq:initiative:p-auth', text: '/doc Runbook', argumentText: 'Runbook' } as never),
      { kind: 'run', runId: 'odc-1', pipelineId: 'conversation-doc', card: { kind: 'agent-run' }, echo: '/doc Runbook', visibility: 'private' });
    assert.equal(((await artifactCommand(conversationArtifactApi('diagram')).run({ channel: 'c', text: '', argumentText: '' } as never)) as { echo: string }).echo, '/diagram');
    assert.deepEqual(urls, ['/api/conversations/doc/run', '/api/conversations/diagram/run']);
  } finally { globalThis.fetch = original; }
});

test('the registry gives Social four commands and tenant conversations the same plus the channel-routed /deck, so every /summarize surface gets both', () => {
  const stub = (trigger: string) => ({ trigger, label: trigger, scope: 'always', run: async () => null }) as never;
  assert.deepEqual(socialChatCommands(stub('/summarize'), stub('/deck')).map(c => c.trigger), ['/summarize', '/deck', '/diagram', '/doc', '/agent']);
  assert.deepEqual(CONVERSATION_CHAT_COMMANDS.map(c => c.trigger), ['/summarize', '/deck', '/diagram', '/doc', '/agent']);
});

test('Post is for a finished diagram, Save for a finished page that has somewhere to go; neither twice nor when empty', () => {
  assert.equal(canPost(done()), true);
  assert.equal(canSave(done()), false);
  assert.equal(canPost(done({ posted: true })), false);
  assert.equal(canPost(done({}, { messageCount: 0 })), false);
  assert.equal(canPost(done({ phase: 'running' })), false);
  assert.equal(canSave(done({ saveTarget: 'document' }, { command: 'doc', format: 'markdown' })), true);
  assert.equal(canSave(done({ saveTarget: null }, { command: 'doc', format: 'markdown' })), false);
  assert.equal(canSave(done({ saveTarget: 'attachment', savedAs: 'attachment' }, { command: 'doc', format: 'markdown' })), false);
});

test('the pipeline id names the card, and anything else is not an artifact', () => {
  assert.equal(artifactKindOf('conversation-diagram'), 'diagram');
  assert.equal(artifactKindOf('conversation-doc'), 'doc');
  assert.equal(artifactKindOf('conversation-summarize'), null);
  assert.equal(artifactKindOf(undefined), null);
});

test('a fallback says why, and names what was built', () => {
  assert.match(agentRunStatusOf(done({}, { fallback: true })).detail ?? '', /diagram is built directly from the thread/);
  assert.match(agentRunStatusOf(done({}, { fallback: true, unavailable: "only serves 'assessment'", command: 'doc' })).detail ?? '', /not available for this conversation.*assessment.*page draft/);
  assert.equal(agentRunStatusOf(done({}, { messageCount: 0 })).noop, true);
});

test('sources are verbatim quotes with their author, and the attachment is named from the title', () => {
  assert.equal(sourcesMarkdown(result()), '> "Release is Thursday." — Mira');
  assert.equal(artifactFile(result()).name, 'Release-flow.drawio');
  assert.equal(artifactFile(result({ title: '///', format: 'markdown' })).name, 'conversation.md');
});
