// `/diagram` and `/doc` in Social channels and DMs (routes/conversation-artifact.ts,
// the Social mount): chatAccess authority, verbatim grounding, explicit post/save.
const mockCaps = { current: ['ViewSocial', 'PostMessage'] };
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' },
    cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => ['participant', 'moderator', 'community-admin']
    .map(id => ({ id, tenant: 'social', capabilities: mockCaps.current })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { chatPinsRouter } from '../chat-pins.js';
import { pendingArtifacts, socialArtifactRouter } from '../conversation-artifact.js';
import { errorHandler } from '../../lib/async-handler.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import { socialChat, setSocialChatBackend, createMemorySocialChatBackend } from '../../lib/social-chat.js';
import * as authz from '../../lib/authz.js';
import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { getUser } from '../../providers/identity.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { transcriptLines } from '../../lib/conversation-summarize.js';
import { acceptArtifactEnvelope, diagramDigest, pageDigest, parseArtifactArgs, parseDiagram } from '../../lib/conversation-artifact.js';
import { flowRunChannel } from '../../lib/flow-runs/index.js';
import type { Session } from '../../lib/session.js';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';

const SECRET = 'artifact-api-test-secret';
const previousSecret = process.env['REALTIME_JWT_SECRET'];
const app = express();
app.use(express.json());
app.use('/api/chat', chatPinsRouter);
app.use('/api/chat/commands', socialArtifactRouter);
app.use(errorHandler);

const CHANNEL = 'social:ch:general';
const msg = (id: string, text: string, timestamp: string, over: Partial<ChatMessage> = {}): ChatMessage => ({
  id, channel: CHANNEL, clientId: 'c', userId: 'u-mira', message: text, timestamp, metadata: { displayName: 'Mira Okafor' }, ...over,
});
async function bearer(sub = 'u-sana'): Promise<string> {
  const user = await getUser(sub);
  const session = { sub, name: user?.displayName, role: 'participant', tenant: 'social', grants: user?.grants ?? {}, iat: 0 } as Session;
  return `Bearer ${(await signRealtimeToken(realtimeClaims(session), SECRET)).token}`;
}
const settle = async (): Promise<void> => { await Promise.all([...pendingArtifacts]); };
type Cmd = 'diagram' | 'doc';
async function run(cmd: Cmd, sub: string, channel = CHANNEL, text = ''): Promise<request.Response> {
  return request(app).post(`/api/chat/commands/${cmd}/run`).set('Authorization', await bearer(sub)).send({ channel, text });
}
const get = async (cmd: Cmd, sub: string, id: string) => request(app).get(`/api/chat/commands/${cmd}/runs/${id}`).set('Authorization', await bearer(sub));
const post = async (sub: string, id: string) => request(app).post(`/api/chat/commands/diagram/runs/${id}/post`).set('Authorization', await bearer(sub));
const save = async (sub: string, id: string, body: unknown = {}) => request(app).post(`/api/chat/commands/doc/runs/${id}/save`).set('Authorization', await bearer(sub)).send(body as object);

beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = SECRET; });
afterAll(() => { if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret; });
beforeEach(async () => {
  mockCaps.current = ['ViewSocial', 'PostMessage'];
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  const rows = socialChannelMessagesFixture.rows();
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.channel === CHANNEL && rows[i]!.id.includes('seedh')) rows.splice(i, 1);
  const store = socialChat().chatStore;
  await store.putMessage(msg('s1', 'Release is Thursday.', '2026-10-01T10:00:00.000Z'));
  await store.putMessage(msg('s2', 'I will update the runbook.', '2026-10-01T11:00:00.000Z', { userId: 'u-theo', metadata: { displayName: 'Theo' } }));
});
afterEach(() => {
  socialChannelMembersFixture.reset(); socialChannelMessagesFixture.reset(); flowRunsFixture.reset();
  jest.restoreAllMocks(); setSocialChatBackend(null);
});

describe.each(['diagram', 'doc'] as const)('/%s run', (cmd) => {
  it('a member gets a private run whose quotes are verbatim messages, and nothing is posted', async () => {
    const before = (await socialChat().chatStore.listMessages(CHANNEL, 500)).length;
    const started = await run(cmd, 'u-sana', CHANNEL, 'release flow');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ pipelineId: `conversation-${cmd}`, card: { kind: 'agent-run', command: `/${cmd}` } });
    expect(flowRunChannel(started.body.runId)).toBe(`social:flowrun:${started.body.runId}`);
    await settle();
    const status = await get(cmd, 'u-sana', started.body.runId);
    expect(status.body).toMatchObject({ phase: 'completed', posted: false, saveTarget: 'attachment' });
    const texts = (await socialChat().chatStore.listMessages(CHANNEL, 500)).map(m => m.message);
    expect(status.body.result.sourceSpans.length).toBeGreaterThan(0);
    for (const span of status.body.result.sourceSpans) expect(texts.some(t => t.includes(span.text))).toBe(true);
    expect(status.body.result.title).toBe('release flow');
    expect((await socialChat().chatStore.listMessages(CHANNEL, 500)).length).toBe(before);
  });

  it.each(['social:ch:moderators', 'social:dm:u-lena:u-mira'])('a non-member is refused in %s and no run exists', async (channel) => {
    expect((await run(cmd, 'u-sana', channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('rejects anonymous callers, other-tenant channels and an over-long topic', async () => {
    expect((await request(app).post(`/api/chat/commands/${cmd}/run`).send({ channel: CHANNEL })).status).toBe(401);
    expect((await run(cmd, 'u-sana', 'orgiq:initiative:x')).status).toBe(400);
    expect((await run(cmd, 'u-sana', CHANNEL, 'x'.repeat(201))).status).toBe(400);
  });

  it('respects the history floor, deleted messages and run cards', async () => {
    const backend = socialChat();
    await backend.chatStore.putMessage(msg('s3', 'Secret deleted line.', '2026-10-01T12:00:00.000Z', { deletedAt: '2026-10-01T12:05:00.000Z' }));
    await backend.chatStore.putMessage(msg('s4', '/diagram card', '2026-10-01T12:10:00.000Z', { metadata: { kind: 'agent-run' } }));
    await backend.chatStore.putMessage(msg('s6', 'Earlier artifact post.', '2026-10-01T12:20:00.000Z', { metadata: { artifactOf: { command: 'diagram' } } }));
    const sana = await backend.membershipStore.getMember(CHANNEL, 'u-sana');
    await backend.membershipStore.putMember({ ...sana!, historyFrom: '2026-10-01T10:00:00.000Z' });
    const started = await run(cmd, 'u-sana'); await settle();
    const quoted = JSON.stringify((await get(cmd, 'u-sana', started.body.runId)).body.result);
    expect(quoted).toContain('runbook');
    for (const hidden of ['Release is Thursday', 'Secret deleted', '/diagram card', 'Earlier artifact post']) expect(quoted).not.toContain(hidden);
  });

  it('is private: another member, an unknown id and a removed member all fail closed', async () => {
    const started = await run(cmd, 'u-sana'); await settle();
    expect((await get(cmd, 'u-theo', started.body.runId)).status).toBe(404);
    expect((await get(cmd, 'u-sana', `${cmd === 'diagram' ? 'sdg' : 'sdc'}-nope`)).status).toBe(404);
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect((await get(cmd, 'u-sana', started.body.runId)).status).toBe(403);
  });
});

describe('/diagram post', () => {
  it('posting is a separate act, needs PostMessage, and returns the server-built message once', async () => {
    const started = await run('diagram', 'u-sana', CHANNEL, 'release'); await settle();
    const gate = jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await post('u-sana', started.body.runId)).status).toBe(403);
    expect((await get('diagram', 'u-sana', started.body.runId)).body.posted).toBe(false);
    gate.mockRestore();
    const posted = await post('u-sana', started.body.runId);
    expect(posted.status).toBe(200);
    expect(posted.body.text).toContain('Diagram: release');
    expect(posted.body.text).toContain('Sources');
    expect(posted.body.metadata.artifactOf).toMatchObject({ command: 'diagram', runId: started.body.runId });
    expect(posted.body.metadata.artifactOf.nodes.length).toBeGreaterThan(1);
    expect((await post('u-sana', started.body.runId)).status).toBe(409);
    expect((await get('diagram', 'u-sana', started.body.runId)).body.posted).toBe(true);
    // The diagram route has no save, the doc route has no post.
    expect((await request(app).post(`/api/chat/commands/doc/runs/${started.body.runId}/post`).set('Authorization', await bearer('u-sana'))).status).toBe(404);
  });

  it('the posted message fits one chat message (1000 characters) however long the thread and its messages are', async () => {
    const store = socialChat().chatStore;
    for (let i = 0; i < 30; i++) await store.putMessage(msg(`long${i}`, `Message ${i}: ${'a long sentence about the cutover plan '.repeat(8)}`, `2026-10-02T10:${String(i).padStart(2, '0')}:00.000Z`));
    const started = await run('diagram', 'u-sana', CHANNEL, 'x'.repeat(200)); await settle();
    const posted = await post('u-sana', started.body.runId);
    expect(posted.status).toBe(200);
    expect(posted.body.text.length).toBeLessThanOrEqual(1000);
    expect(posted.body.text).toContain('Flow: 1 → 2');
    const doc = await run('doc', 'u-sana', CHANNEL, 'y'.repeat(200)); await settle();
    const saved = await save('u-sana', doc.body.runId);
    expect(saved.body.text.length).toBeLessThanOrEqual(1000);
  });

  it('an empty thread completes with nothing to post', async () => {
    const store = socialChat().chatStore;
    for (const m of await store.listMessages(CHANNEL, 500)) await store.putMessage({ ...m, deletedAt: '2026-10-02T00:00:00.000Z' });
    const started = await run('diagram', 'u-sana'); await settle();
    expect((await get('diagram', 'u-sana', started.body.runId)).body.result.messageCount).toBe(0);
    expect((await post('u-sana', started.body.runId)).status).toBe(409);
  });
});

describe('/doc save', () => {
  it('Save is a separate, once-only act that needs PostMessage and carries no document id for Social', async () => {
    const started = await run('doc', 'u-sana', CHANNEL, 'Runbook'); await settle();
    expect((await save('u-sana', started.body.runId, { documentId: 'd-1' })).status).toBe(400);
    const gate = jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await save('u-sana', started.body.runId)).status).toBe(403);
    gate.mockRestore();
    expect((await get('doc', 'u-sana', started.body.runId)).body.posted).toBe(false);
    const saved = await save('u-sana', started.body.runId);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ saveTarget: 'attachment', title: 'Runbook', channel: CHANNEL });
    expect(saved.body.text).toContain('Page: Runbook');
    expect(saved.body.metadata.documents).toBeUndefined();
    expect(saved.body.metadata.artifactOf).toMatchObject({ command: 'doc' });
    expect((await save('u-sana', started.body.runId)).status).toBe(409);
    expect((await save('u-theo', started.body.runId)).status).toBe(404);
  });
});

describe('the real agent path', () => {
  const invoke = agentcore.invokeAgent as jest.Mock;
  beforeEach(() => { (config.mock as { agentcore: boolean }).agentcore = false; invoke.mockReset(); });
  afterEach(() => { (config.mock as { agentcore: boolean }).agentcore = true; });
  const XML = '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
    + '<mxCell id="a" value="Release Thursday" vertex="1" parent="1"><mxGeometry x="0" y="0" width="100" height="40" as="geometry"/></mxCell>'
    + '<mxCell id="b" value="Runbook" vertex="1" parent="1"><mxGeometry x="0" y="80" width="100" height="40" as="geometry"/></mxCell>'
    + '<mxCell id="e" edge="1" source="a" target="b" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>';

  it('/diagram asks draw-diagram and keeps a verbatim, plain answer', async () => {
    invoke.mockResolvedValue({ text: JSON.stringify({ summary: 'Two boxes.', content: XML, format: 'drawio', source_spans: ['Release is Thursday.'] }), toolCalls: [] });
    const started = await run('diagram', 'u-sana', CHANNEL, 'release'); await settle();
    const result = (await get('diagram', 'u-sana', started.body.runId)).body.result;
    expect(result).toMatchObject({ fallback: false, format: 'drawio', nodes: [{ id: 'a', label: 'Release Thursday' }, { id: 'b', label: 'Runbook' }], edges: [{ from: 'a', to: 'b' }] });
    expect(invoke).toHaveBeenCalledWith('orgiq-assessment-drafter', expect.objectContaining({
      structuredInput: expect.objectContaining({ mode: 'draw-diagram', document: { text: expect.stringContaining('Mira Okafor: Release is Thursday.') } }) }));
  });

  it('/doc asks draft-confluence-page', async () => {
    invoke.mockResolvedValue({ text: JSON.stringify({ summary: 'A page.', content: '# Page\n\nShip Thursday.', format: 'markdown', source_spans: ['I will update the runbook.'] }), toolCalls: [] });
    const started = await run('doc', 'u-sana', CHANNEL, 'Runbook'); await settle();
    expect((await get('doc', 'u-sana', started.body.runId)).body.result).toMatchObject({ fallback: false, content: '# Page\n\nShip Thursday.' });
    expect(invoke).toHaveBeenCalledWith('orgiq-assessment-drafter', expect.objectContaining({ structuredInput: expect.objectContaining({ mode: 'draft-confluence-page' }) }));
  });

  it('falls back to the deterministic result for an invented quote, unsafe XML or a failing agent', async () => {
    invoke.mockResolvedValueOnce({ text: JSON.stringify({ summary: 'x', content: XML, format: 'drawio', source_spans: ['Never said this'] }), toolCalls: [] });
    invoke.mockResolvedValueOnce({ text: JSON.stringify({ summary: 'x', content: XML.replace('Runbook', 'see http://evil.test'), format: 'drawio', source_spans: ['Release is Thursday.'] }), toolCalls: [] });
    invoke.mockRejectedValueOnce(new Error('runtime down'));
    for (let i = 0; i < 3; i++) {
      const started = await run('diagram', 'u-sana'); await settle();
      const result = (await get('diagram', 'u-sana', started.body.runId)).body.result;
      expect(result.fallback).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(/Never said this|evil\.test/);
    }
  });
});

describe('pure pieces', () => {
  const lines = transcriptLines([
    { message: msg('a', 'Line one\nline two', '2026-10-01T10:00:00.000Z'), author: 'Mira' },
    { message: msg('b', 'See https://x.test//path <b>bold</b> & more', '2026-10-01T11:00:00.000Z'), author: 'Theo' },
  ], null);

  it('parses topics', () => {
    expect(parseArtifactArgs('', 'diagram')).toEqual({ ok: true, topic: '', title: 'Conversation diagram' });
    expect(parseArtifactArgs('  auth   flow\n', 'doc')).toEqual({ ok: true, topic: 'auth flow', title: 'auth flow' });
    expect(parseArtifactArgs('', 'doc')).toMatchObject({ title: 'Conversation page' });
    expect(parseArtifactArgs('x'.repeat(201), 'doc').ok).toBe(false);
  });

  it('the deterministic diagram passes its own validator even when a message carries URLs and markup', () => {
    const digest = diagramDigest(lines, 'Topic <x>');
    const graph = parseDiagram(digest.content);
    expect(graph?.nodes.length).toBe(3);
    expect(graph?.edges.length).toBe(2);
    expect(acceptArtifactEnvelope('diagram', digest, lines, 'Topic')?.sourceSpans.length).toBeGreaterThan(0);
    expect(acceptArtifactEnvelope('doc', pageDigest(lines, 'T'), lines, 'T')).not.toBeNull();
  });

  it.each([
    ['a DOCTYPE', '<!DOCTYPE x><mxGraphModel><root/></mxGraphModel>'],
    ['an entity', '<mxGraphModel><root><mxCell id="a" value="&xx;" vertex="1"/></root></mxGraphModel>'],
    ['an unknown element', '<mxGraphModel><root><script/></root></mxGraphModel>'],
    ['a link attribute', '<mxGraphModel><root><mxCell id="a" value="A" link="x" vertex="1"/></root></mxGraphModel>'],
    ['an HTML label', '<mxGraphModel><root><mxCell id="a" value="A" style="html=1" vertex="1"/></root></mxGraphModel>'],
    ['text between tags', '<mxGraphModel><root>hi<mxCell id="a" value="A" vertex="1"/></root></mxGraphModel>'],
    ['an edge to nowhere', '<mxGraphModel><root><mxCell id="a" value="A" vertex="1"/><mxCell id="e" edge="1" source="a" target="zz"/></root></mxGraphModel>'],
    ['no boxes', '<mxGraphModel><root><mxCell id="0"/></root></mxGraphModel>'],
  ])('refuses %s', (_name, xml) => { expect(parseDiagram(xml)).toBeNull(); });

  it('accepts only single-message quotes and the matching format', () => {
    const ok = { summary: 's', content: '# C', format: 'markdown', source_spans: ['Line one line two'] };
    expect(acceptArtifactEnvelope('doc', ok, lines, 'T')?.sourceSpans[0]?.messageId).toBe('a');
    expect(acceptArtifactEnvelope('doc', { ...ok, format: 'drawio' }, lines, 'T')).toBeNull();
    expect(acceptArtifactEnvelope('doc', { ...ok, source_spans: ['Line one\nline two'] }, lines, 'T')).toBeNull();
    expect(acceptArtifactEnvelope('doc', { ...ok, source_spans: [] }, lines, 'T')).toBeNull();
  });
});
