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
import { pendingSummaries, socialSummarizeRouter } from '../social-summarize.js';
import { errorHandler } from '../../lib/async-handler.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import { socialChat, setSocialChatBackend, createMemorySocialChatBackend } from '../../lib/social-chat.js';
import * as authz from '../../lib/authz.js';
import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { getUser } from '../../providers/identity.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { parseSummarizeRange } from '../../lib/social-summarize-range.js';
import { acceptEnvelope, digestEnvelope, transcriptLines } from '../../lib/social-summarize.js';
import type { Session } from '../../lib/session.js';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';

const SECRET = 'summarize-api-test-secret';
const previousSecret = process.env['REALTIME_JWT_SECRET'];
const app = express();
app.use(express.json());
app.use('/api/chat', chatPinsRouter);
app.use('/api/chat/commands', socialSummarizeRouter);
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
const settle = async (): Promise<void> => { await Promise.all([...pendingSummaries]); };
async function run(sub: string, channel = CHANNEL, text = ''): Promise<request.Response> {
  return request(app).post('/api/chat/commands/summarize/run').set('Authorization', await bearer(sub)).send({ channel, text });
}
const get = async (sub: string, id: string) => request(app).get(`/api/chat/commands/summarize/runs/${id}`).set('Authorization', await bearer(sub));
const post = async (sub: string, id: string) => request(app).post(`/api/chat/commands/summarize/runs/${id}/post`).set('Authorization', await bearer(sub));

beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = SECRET; });
afterAll(() => {
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
});
beforeEach(async () => {
  mockCaps.current = ['ViewSocial', 'PostMessage'];
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  // The demo history (mock/social-history.ts) is not this test's subject: keep #general to its own lines.
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

describe('POST /summarize/run', () => {
  it('a member gets a private run whose quotes are verbatim messages, and nothing is posted', async () => {
    const before = (await socialChat().chatStore.listMessages(CHANNEL, 500)).length;
    const started = await run('u-sana');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ pipelineId: 'conversation-summarize', card: { kind: 'agent-run', command: '/summarize' } });
    await settle();
    const status = await get('u-sana', started.body.runId);
    expect(status.body).toMatchObject({ phase: 'completed', posted: false });
    const texts = (await socialChat().chatStore.listMessages(CHANNEL, 500)).map(m => m.message);
    expect(status.body.result.sourceSpans.length).toBeGreaterThan(0);
    for (const span of status.body.result.sourceSpans) expect(texts.some(t => t.includes(span.text))).toBe(true);
    expect((await socialChat().chatStore.listMessages(CHANNEL, 500)).length).toBe(before);
  });

  it.each(['social:ch:moderators', 'social:dm:u-lena:u-mira'])('a non-member is refused in %s and no run exists', async (channel) => {
    expect((await run('u-sana', channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('rejects anonymous callers, other-tenant channels and a bad range', async () => {
    expect((await request(app).post('/api/chat/commands/summarize/run').send({ channel: CHANNEL })).status).toBe(401);
    expect((await run('u-sana', 'orgiq:initiative:x')).status).toBe(400);
    expect((await run('u-sana', CHANNEL, 'last banana')).status).toBe(400);
  });

  it('respects the history floor, deleted messages and run cards', async () => {
    const backend = socialChat();
    await backend.chatStore.putMessage(msg('s3', 'Secret deleted line.', '2026-10-01T12:00:00.000Z', { deletedAt: '2026-10-01T12:05:00.000Z' }));
    await backend.chatStore.putMessage(msg('s4', '/summarize card', '2026-10-01T12:10:00.000Z', { metadata: { kind: 'agent-run' } }));
    const sana = await backend.membershipStore.getMember(CHANNEL, 'u-sana');
    await backend.membershipStore.putMember({ ...sana!, historyFrom: '2026-10-01T10:00:00.000Z' });
    const started = await run('u-sana'); await settle();
    const result = (await get('u-sana', started.body.runId)).body.result;
    const quoted = JSON.stringify(result);
    expect(quoted).toContain('runbook');
    expect(quoted).not.toContain('Release is Thursday');
    expect(quoted).not.toContain('Secret deleted');
    expect(quoted).not.toContain('/summarize card');
  });

  it('a time range keeps only newer messages', async () => {
    await socialChat().chatStore.putMessage(msg('s5', 'Fresh note.', new Date().toISOString()));
    const started = await run('u-sana', CHANNEL, 'last 1h'); await settle();
    const result = (await get('u-sana', started.body.runId)).body.result;
    expect(result.messageCount).toBe(1);
    expect(result.sourceSpans[0].text).toBe('Fresh note.');
  });
});

describe('private runs and the explicit post', () => {
  it('another member, even of the same channel, cannot read or post someone else\'s run', async () => {
    const started = await run('u-sana'); await settle();
    expect((await get('u-theo', started.body.runId)).status).toBe(404);
    expect((await post('u-theo', started.body.runId)).status).toBe(404);
    expect((await get('u-sana', 'sum-nope')).status).toBe(404);
  });

  it('posting is a separate act: it returns the server-built message once, and needs PostMessage', async () => {
    const started = await run('u-sana'); await settle();
    const gate = jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await post('u-sana', started.body.runId)).status).toBe(403);
    expect((await get('u-sana', started.body.runId)).body.posted).toBe(false);
    gate.mockRestore();
    const posted = await post('u-sana', started.body.runId);
    expect(posted.status).toBe(200);
    expect(posted.body.text).toContain('Sources');
    expect(posted.body.metadata.summaryOf).toMatchObject({ runId: started.body.runId });
    expect((await post('u-sana', started.body.runId)).status).toBe(409);
    expect((await get('u-sana', started.body.runId)).body.posted).toBe(true);
  });

  it('a member removed after the run started cannot read or post the result', async () => {
    const started = await run('u-sana'); await settle();
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect((await get('u-sana', started.body.runId)).status).toBe(403);
    expect((await post('u-sana', started.body.runId)).status).toBe(403);
  });

  it('an empty range completes with nothing to post', async () => {
    const started = await run('u-sana', CHANNEL, '1m'); await settle();
    expect((await get('u-sana', started.body.runId)).body.result.messageCount).toBe(0);
    expect((await post('u-sana', started.body.runId)).status).toBe(409);
  });
});

describe('the real agent path', () => {
  const invoke = agentcore.invokeAgent as jest.Mock;
  beforeEach(() => { (config.mock as { agentcore: boolean }).agentcore = false; invoke.mockReset(); });
  afterEach(() => { (config.mock as { agentcore: boolean }).agentcore = true; });

  it('uses the drafter command and keeps a verbatim answer', async () => {
    invoke.mockResolvedValue({ text: JSON.stringify({ summary: 'Thursday release.', content: '## Summary\nRelease Thursday.', format: 'markdown',
      source_spans: ['Release is Thursday.'], draft: true, published: false }), toolCalls: [] });
    const started = await run('u-sana'); await settle();
    const result = (await get('u-sana', started.body.runId)).body.result;
    expect(result).toMatchObject({ fallback: false, summary: 'Thursday release.' });
    expect(invoke).toHaveBeenCalledWith('orgiq-assessment-drafter', expect.objectContaining({
      structuredInput: expect.objectContaining({ mode: 'summarize-conversation', document: { text: expect.stringContaining('Mira Okafor: Release is Thursday.') } }) }));
  });

  it('falls back to the deterministic digest when a quote is invented or the agent fails', async () => {
    invoke.mockResolvedValueOnce({ text: JSON.stringify({ summary: 'x', content: 'y', format: 'markdown', source_spans: ['Never said this'] }), toolCalls: [] });
    invoke.mockRejectedValueOnce(new Error('runtime down'));
    for (let i = 0; i < 2; i++) {
      const started = await run('u-sana'); await settle();
      const result = (await get('u-sana', started.body.runId)).body.result;
      expect(result.fallback).toBe(true);
      expect(JSON.stringify(result)).not.toContain('Never said this');
    }
  });
});

describe('pure pieces', () => {
  it('parses ranges', () => {
    const now = new Date('2026-10-05T12:00:00.000Z');
    expect(parseSummarizeRange('', now)).toEqual({ ok: true, sinceMs: null });
    expect(parseSummarizeRange('last 2 days', now)).toEqual({ ok: true, sinceMs: now.getTime() - 2 * 86_400_000 });
    expect(parseSummarizeRange('24h', now)).toEqual({ ok: true, sinceMs: now.getTime() - 86_400_000 });
    expect(parseSummarizeRange('today', now)).toEqual({ ok: true, sinceMs: Date.parse('2026-10-05T00:00:00.000Z') });
    expect(parseSummarizeRange('99w', now).ok).toBe(false);
    expect(parseSummarizeRange('soon', now).ok).toBe(false);
  });

  it('accepts only verbatim single-message quotes', () => {
    const lines = transcriptLines([{ message: msg('a', 'Line one\nline two', '2026-10-01T10:00:00.000Z'), author: 'Mira' }], null);
    const ok = { summary: 's', content: 'c', format: 'markdown', source_spans: ['Line one line two'] };
    expect(acceptEnvelope(ok, lines)?.sourceSpans[0]?.messageId).toBe('a');
    expect(acceptEnvelope({ ...ok, source_spans: ['Line one\nline two'] }, lines)).toBeNull();
    expect(acceptEnvelope({ ...ok, source_spans: [] }, lines)).toBeNull();
    expect(acceptEnvelope(digestEnvelope(lines), lines)).not.toBeNull();
  });
});
