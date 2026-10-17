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
import { pendingDecks, socialDeckRouter } from '../social-deck.js';
import { errorHandler } from '../../lib/async-handler.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import { socialChat, setSocialChatBackend, createMemorySocialChatBackend } from '../../lib/social-chat.js';
import * as authz from '../../lib/authz.js';
import { config } from '../../config.js';
import { agentcore } from '../../providers/index.js';
import { getUser } from '../../providers/identity.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { socialDeckRevisionsFixture, socialDecksFixture } from '../../mock/social-decks.js';
import { deckTitleFrom, parseDeckArgs } from '../../lib/social-deck/args.js';
import { buildConversationDeckFacts, topicChunks } from '../../lib/social-deck/facts.js';
import { deckIdForRun } from '../../providers/social-decks.js';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';
import type { Session } from '../../lib/session.js';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';

const SECRET = 'deck-api-test-secret';
const previousSecret = process.env['REALTIME_JWT_SECRET'];
const app = express();
app.use(express.json());
app.use('/api/chat', chatPinsRouter);
app.use('/api/chat', socialDeckRouter);
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
const settle = async (): Promise<void> => { await Promise.all([...pendingDecks]); };
async function run(sub: string, channel = CHANNEL, text = ''): Promise<request.Response> {
  return request(app).post('/api/chat/commands/deck/run').set('Authorization', await bearer(sub)).send({ channel, text });
}
const auth = async (sub: string) => ({ Authorization: await bearer(sub) });
const listDecks = async (sub: string) => request(app).get('/api/chat/decks').set(await auth(sub));
const getDeck = async (sub: string, id: string) => request(app).get(`/api/chat/decks/${id}`).set(await auth(sub));
const getSpec = async (sub: string, id: string, rid: string) => request(app).get(`/api/chat/decks/${id}/revisions/${rid}/spec`).set(await auth(sub));
const getFile = async (sub: string, id: string, rid: string) => request(app).get(`/api/chat/decks/${id}/revisions/${rid}/file`).set(await auth(sub));
const postRevision = async (sub: string, id: string, body: object) => request(app).post(`/api/chat/decks/${id}/revisions`).set(await auth(sub)).send(body);
const postPreview = async (sub: string, id: string, body: object) => request(app).post(`/api/chat/decks/${id}/preview`).set(await auth(sub)).send(body);
const postToConversation = async (sub: string, id: string, body: object = {}) => request(app).post(`/api/chat/decks/${id}/post`).set(await auth(sub)).send(body);
const get = async (sub: string, id: string) => request(app).get(`/api/chat/commands/deck/runs/${id}`).set(await auth(sub));
const save = async (sub: string, id: string) => request(app).post(`/api/chat/commands/deck/runs/${id}/save`).set(await auth(sub));

async function seed(): Promise<void> {
  const store = socialChat().chatStore;
  const lines: Array<[string, string, string, string]> = [
    ['d1', 'Release is Thursday.', '2026-10-01T10:00:00.000Z', 'u-mira'],
    ['d2', 'I will update the runbook.', '2026-10-01T11:00:00.000Z', 'u-theo'],
    ['d3', 'Rollback plan needs an owner.', '2026-10-01T12:00:00.000Z', 'u-mira'],
    ['d4', 'Sana can own the rollback.', '2026-10-02T09:00:00.000Z', 'u-theo'],
    ['d5', 'Smoke tests passed on staging.', '2026-10-02T10:00:00.000Z', 'u-mira'],
  ];
  for (const [id, text, at, userId] of lines) await store.putMessage(msg(id, text, at, { userId, metadata: { displayName: userId } }));
}
const allSources = (spec: { slides: Array<{ sources: Array<{ documentId: string }> }> }): string[] =>
  spec.slides.flatMap(s => s.sources.map(x => x.documentId));

let restorePptx: () => void;
beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = SECRET; restorePptx = hidePptxNodeDetection(); });
afterAll(() => {
  restorePptx();
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
});
beforeEach(async () => {
  mockCaps.current = ['ViewSocial', 'PostMessage'];
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  await seed();
});
afterEach(() => {
  socialChannelMembersFixture.reset(); socialChannelMessagesFixture.reset(); flowRunsFixture.reset();
  socialDecksFixture.reset(); socialDeckRevisionsFixture.reset();
  jest.restoreAllMocks(); setSocialChatBackend(null);
});

describe('POST /commands/deck/run', () => {
  it('builds a deck from the thread, saves it, and every slide cites message ids', async () => {
    const before = (await socialChat().chatStore.listMessages(CHANNEL, 500)).length;
    const started = await run('u-sana', CHANNEL, 'Release review — Thursday risks');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ pipelineId: 'conversation-deck', card: { kind: 'agent-run', command: '/deck', cardKind: 'deck' } });
    await settle();
    const status = (await get('u-sana', started.body.runId)).body;
    expect(status).toMatchObject({ phase: 'completed', preview: false });
    expect(status.deckId).toBe(deckIdForRun(started.body.runId));
    expect(status.result.spec.title).toBe('Release review');
    for (const slide of status.result.spec.slides) {
      expect(slide.sources.length).toBeGreaterThan(0);
      expect(slide.sources.every((s: { documentId: string }) => s.documentId.startsWith('social-message:'))).toBe(true);
    }
    const messageIds = (await socialChat().chatStore.listMessages(CHANNEL, 500)).map(m => m.id);
    for (const id of status.result.sourceMessageIds) expect(messageIds).toContain(id);
    expect(status.result.slides.length).toBeGreaterThan(status.result.spec.slides.length - 1); // the renderer adds Sources
    expect(socialDecksFixture.rows()).toHaveLength(1);
    expect(socialDeckRevisionsFixture.rows()).toHaveLength(1);
    // Nothing reaches the conversation by itself.
    expect((await socialChat().chatStore.listMessages(CHANNEL, 500)).length).toBe(before);
  });

  it('--preview writes no deck; Save deck is the only write and is idempotent', async () => {
    const started = await run('u-sana', CHANNEL, 'Release review --preview');
    expect(started.body.card.cardKind).toBe('deck-preview');
    await settle();
    const status = (await get('u-sana', started.body.runId)).body;
    expect(status).toMatchObject({ phase: 'completed', preview: true, deckId: null });
    expect(status.result.slides.length).toBeGreaterThan(1);
    expect(socialDecksFixture.rows()).toHaveLength(0);
    expect(socialDeckRevisionsFixture.rows()).toHaveLength(0);
    const first = await save('u-sana', started.body.runId);
    expect(first.status).toBe(201);
    const second = await save('u-sana', started.body.runId);
    expect(second.status).toBe(200);
    expect(second.body.deckId).toBe(first.body.deckId);
    expect(socialDecksFixture.rows()).toHaveLength(1);
    expect(socialDeckRevisionsFixture.rows()).toHaveLength(1);
    expect((await get('u-sana', started.body.runId)).body.deckId).toBe(first.body.deckId);
  });

  it.each(['social:ch:moderators', 'social:dm:u-lena:u-mira'])('a non-member is refused in %s and no run exists', async (channel) => {
    expect((await run('u-sana', channel)).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
    expect(socialDecksFixture.rows()).toHaveLength(0);
  });

  it('rejects anonymous callers, other-tenant channels, recording sources and bad page tokens', async () => {
    expect((await request(app).post('/api/chat/commands/deck/run').send({ channel: CHANNEL })).status).toBe(401);
    expect((await run('u-sana', 'orgiq:initiative:x')).status).toBe(400);
    expect((await run('u-sana', CHANNEL, 'Sprint --from transcript')).status).toBe(400);
    expect((await run('u-sana', CHANNEL, '#nonsense')).status).toBe(400);
    expect((await run('u-sana', CHANNEL, '#initiative:a #initiative:b #initiative:c #initiative:d #initiative:e')).status).toBe(400);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('respects the history floor, deleted messages and run cards', async () => {
    const backend = socialChat();
    await backend.chatStore.putMessage(msg('x1', 'Secret deleted line.', '2026-10-02T12:00:00.000Z', { deletedAt: '2026-10-02T12:05:00.000Z' }));
    await backend.chatStore.putMessage(msg('x2', '/deck card text', '2026-10-02T12:10:00.000Z', { metadata: { kind: 'agent-run' } }));
    const sana = await backend.membershipStore.getMember(CHANNEL, 'u-sana');
    await backend.membershipStore.putMember({ ...sana!, historyFrom: '2026-10-01T11:00:00.000Z' });
    const started = await run('u-sana'); await settle();
    const result = (await get('u-sana', started.body.runId)).body.result;
    const text = JSON.stringify(result);
    expect(text).toContain('Rollback plan');
    expect(text).not.toContain('Release is Thursday');
    expect(text).not.toContain('Secret deleted');
    expect(text).not.toContain('/deck card text');
    expect(result.messageCount).toBeGreaterThanOrEqual(3);
  });

  it('refuses when nothing is readable', async () => {
    const backend = socialChat();
    const sana = await backend.membershipStore.getMember(CHANNEL, 'u-sana');
    await backend.membershipStore.putMember({ ...sana!, historyFrom: '2030-01-01T00:00:00.000Z' });
    expect((await run('u-sana')).status).toBe(422);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });
});

describe('referenced pages', () => {
  it('cite a page the caller can read, and refuse one they cannot', async () => {
    const orgGrants = (await getUser('u-theo'))?.grants.orgiq ?? [];
    const sanaOrg = (await getUser('u-sana'))?.grants.orgiq ?? [];
    expect(orgGrants.length).toBeGreaterThan(0);
    expect(sanaOrg.length).toBe(0);
    // No OrgIQ grant: refused before any run exists.
    expect((await run('u-sana', CHANNEL, 'Plan #initiative:p-soc2')).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
    // A page that does not exist is refused, not guessed at.
    expect((await run('u-theo', CHANNEL, 'Plan #initiative:p-does-not-exist')).status).toBe(400);
    const started = await run('u-theo', CHANNEL, 'Plan #initiative:p-soc2 --preview'); expect(started.status).toBe(202); await settle();
    const result = (await get('u-theo', started.body.runId)).body.result;
    expect(result.pages).toEqual([expect.objectContaining({ kind: 'initiative', id: 'p-soc2' })]);
    expect(result.spec.slides.map((s: { id: string }) => s.id)).toContain('pages');
    expect(allSources(result.spec)).toContain('social-page:initiative:p-soc2');
  });
});

describe('private runs and save authority', () => {
  it('another member cannot read or save someone else\'s run', async () => {
    const started = await run('u-sana', CHANNEL, 'x --preview'); await settle();
    expect((await get('u-theo', started.body.runId)).status).toBe(404);
    expect((await save('u-theo', started.body.runId)).status).toBe(404);
    expect((await get('u-sana', 'sdk-nope')).status).toBe(404);
    expect(socialDecksFixture.rows()).toHaveLength(0);
  });

  it('saving needs PostMessage and current membership', async () => {
    const started = await run('u-sana', CHANNEL, 'x --preview'); await settle();
    const gate = jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await save('u-sana', started.body.runId)).status).toBe(403);
    gate.mockRestore();
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect((await save('u-sana', started.body.runId)).status).toBe(403);
    expect((await get('u-sana', started.body.runId)).status).toBe(403);
    expect(socialDecksFixture.rows()).toHaveLength(0);
  });
});

describe('a saved deck: who may read, edit and post', () => {
  async function savedDeck(): Promise<{ deckId: string; revisionId: string }> {
    const started = await run('u-sana', CHANNEL, 'Release review'); await settle();
    const status = (await get('u-sana', started.body.runId)).body;
    return { deckId: status.deckId, revisionId: (await getDeck('u-sana', status.deckId)).body.activeRevisionId };
  }

  it('the owner and a current member read and edit it (one deck write rule); a reader without PostMessage cannot', async () => {
    const { deckId, revisionId } = await savedDeck();
    const owner = await getDeck('u-sana', deckId);
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ canEdit: true, channel: CHANNEL, ownerId: 'u-sana' });
    const member = await getDeck('u-theo', deckId);
    expect(member.status).toBe(200);
    expect(member.body.canEdit).toBe(true);
    const spec = (await getSpec('u-theo', deckId, revisionId)).body;
    const readOnly = jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await getDeck('u-theo', deckId)).body.canEdit).toBe(false);
    expect((await postRevision('u-theo', deckId, { spec, baseRevisionId: revisionId })).status).toBe(403);
    readOnly.mockRestore();
    expect((await postRevision('u-theo', deckId, { spec: { ...spec, title: 'Edited' }, baseRevisionId: revisionId })).status).toBe(201);
    expect((await postRevision('u-sana', deckId, { spec, baseRevisionId: revisionId })).status).toBe(409);
    const file = await request(app).get(`/api/chat/decks/${deckId}/revisions/${revisionId}/file`).set('Authorization', await bearer('u-theo'));
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('presentationml');
  });

  it('a non-member, a removed member and a person without ViewSocial get a 404 / 403, never the deck', async () => {
    const { deckId, revisionId } = await savedDeck();
    // A deck built in the private #moderators channel: u-sana is not a member.
    const mods = await run('u-lena', 'social:ch:moderators', 'Mods'); await settle();
    const modDeck = (await get('u-lena', mods.body.runId)).body.deckId;
    const modRev = (await getDeck('u-lena', modDeck)).body.activeRevisionId;
    expect((await getDeck('u-mira', modDeck)).status).toBe(200);
    expect((await getDeck('u-sana', modDeck)).status).toBe(404);
    expect((await getSpec('u-sana', modDeck, modRev)).status).toBe(404);
    expect((await postPreview('u-sana', modDeck, { spec: { title: 't', slides: [] } })).status).toBe(404);
    expect((await postToConversation('u-sana', modDeck)).status).toBe(404);
    expect((await getFile('u-sana', modDeck, modRev)).status).toBe(404);
    expect(revisionId).toBeTruthy();
    // A member who leaves loses it at once.
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-theo')!.removedAt = new Date().toISOString();
    expect((await getDeck('u-theo', deckId)).status).toBe(404);
    // The owner keeps reading while they hold ViewSocial, and loses it without.
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect((await getDeck('u-sana', deckId)).status).toBe(200);
    jest.spyOn(authz, 'isAllowed').mockResolvedValue(false);
    expect((await getDeck('u-sana', deckId)).status).toBe(403);
    expect((await request(app).get(`/api/chat/decks/${deckId}`)).status).toBe(401);
    expect((await getDeck('u-sana', 'not-a-deck')).status).toBe(404);
  });

  it('Post to conversation returns the server-built message, needs PostMessage and membership, and posts nothing itself', async () => {
    const { deckId, revisionId } = await savedDeck();
    const before = (await socialChat().chatStore.listMessages(CHANNEL, 500)).length;
    const posted = await postToConversation('u-theo', deckId, { text: 'ignored', channel: 'social:ch:moderators' });
    expect(posted.status).toBe(200);
    expect(posted.body).toMatchObject({ channel: CHANNEL, deckId, revisionId, metadata: { sourceDeck: { id: deckId, revisionId } } });
    expect(posted.body.text).toContain('Release review');
    expect(posted.body.fileUrl).toBe(`/api/chat/decks/${deckId}/revisions/${revisionId}/file`);
    expect((await socialChat().chatStore.listMessages(CHANNEL, 500)).length).toBe(before);
    const gate = jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await postToConversation('u-theo', deckId)).status).toBe(403);
    gate.mockRestore();
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect((await postToConversation('u-sana', deckId)).status).toBe(403); // owner who left may read, not post
  });

  it('previews a posted spec without storing, and lists only the caller\'s own decks', async () => {
    const { deckId, revisionId } = await savedDeck();
    const spec = (await getSpec('u-sana', deckId, revisionId)).body;
    const revisionsBefore = socialDeckRevisionsFixture.rows().length;
    const preview = await postPreview('u-theo', deckId, { spec });
    expect(preview.status).toBe(200);
    expect(preview.body.slides[0].svg).toContain('<svg');
    expect((await postPreview('u-theo', deckId, { spec: { title: '', slides: [] } })).status).toBe(400);
    expect(socialDeckRevisionsFixture.rows()).toHaveLength(revisionsBefore);
    expect((await listDecks('u-sana')).body).toHaveLength(1);
    expect((await listDecks('u-theo')).body).toHaveLength(0);
  });
});

describe('agent revise', () => {
  const revise = async (sub: string, id: string, body: object) => request(app).post(`/api/chat/decks/${id}/revise`).set(await auth(sub)).send(body);
  async function savedDeck(): Promise<{ deckId: string; revisionId: string }> {
    const started = await run('u-sana', CHANNEL, 'Release review'); await settle();
    const status = (await get('u-sana', started.body.runId)).body;
    return { deckId: status.deckId, revisionId: (await getDeck('u-sana', status.deckId)).body.activeRevisionId };
  }

  it('the owner revises: one new active revision, the member who reads it sees it', async () => {
    const { deckId, revisionId } = await savedDeck();
    const res = await revise('u-sana', deckId, { instruction: 'Add speaker notes', baseRevisionId: revisionId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ engine: 'offline', replayed: false });
    expect(res.body.revisionId).toMatch(/^srev-/);
    const seen = (await getDeck('u-theo', deckId)).body;
    expect(seen.activeRevisionId).toBe(res.body.revisionId);
    expect(seen.revisions[0].producedBy).toBe('agent:social');
  });

  it('a reader without PostMessage, an outsider and an anonymous caller are refused', async () => {
    const { deckId, revisionId } = await savedDeck();
    const body = { instruction: 'Make it shorter', baseRevisionId: revisionId };
    const gate = jest.spyOn(authz, 'isAllowed').mockImplementation(async (_p, action) => action !== 'PostMessage');
    expect((await revise('u-theo', deckId, body)).status).toBe(403);
    gate.mockRestore();
    expect([403, 404]).toContain((await revise('u-hr', deckId, body)).status);
    expect((await request(app).post(`/api/chat/decks/${deckId}/revise`).send(body)).status).toBe(401);
    expect(socialDeckRevisionsFixture.rows()).toHaveLength(1);
  });

  it('a stale base is 409; the same requestId replays instead of writing twice', async () => {
    const { deckId, revisionId } = await savedDeck();
    const body = { instruction: 'Add speaker notes', baseRevisionId: revisionId, requestId: 'req-social-0001' };
    const first = await revise('u-sana', deckId, body);
    expect(first.status).toBe(201);
    const again = await revise('u-sana', deckId, body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ revisionId: first.body.revisionId, replayed: true });
    expect(socialDeckRevisionsFixture.rows()).toHaveLength(2);
    const stale = await revise('u-sana', deckId, { instruction: 'Make it shorter', baseRevisionId: revisionId });
    expect(stale.status).toBe(409);
    expect(stale.body.activeRevisionId).toBe(first.body.revisionId);
    expect((await revise('u-sana', deckId, { instruction: '', baseRevisionId: first.body.revisionId })).status).toBe(400);
  });

  it('a deck with a cited initiative page revises its cited slide; a reviser who lost access gets it marked unavailable', async () => {
    const started = await run('u-theo', CHANNEL, 'Plan #initiative:p-soc2'); await settle();
    const status = (await get('u-theo', started.body.runId)).body;
    const deckId = status.deckId as string;
    const head = (await getDeck('u-theo', deckId)).body.activeRevisionId as string;
    const first = await revise('u-theo', deckId, { instruction: 'Add speaker notes', baseRevisionId: head });
    expect(first.status).toBe(201);
    const spec1 = (await getSpec('u-theo', deckId, first.body.revisionId)).body;
    const pages1 = spec1.slides.find((s: { id: string }) => s.id === 'pages');
    expect(pages1.bullets.join(' ')).toContain('Initiative:');
    expect(allSources(spec1)).toContain('social-page:initiative:p-soc2');
    // The reviser loses OrgIQ access: the slide says so and the old title is gone.
    const original = getUser;
    const identity = jest.requireActual('../../providers/identity.js');
    (jest.spyOn(identity, 'getUser') as jest.SpyInstance).mockImplementation(async (...a: Parameters<typeof getUser>) => {
      const u = await original(...a);
      return u ? { ...u, grants: { ...u.grants, orgiq: [] } } : u;
    });
    const second = await revise('u-theo', deckId, { instruction: 'Add speaker notes', baseRevisionId: first.body.revisionId });
    expect(second.status).toBe(201);
    expect(second.body.changedSlideIds).toContain('pages');
    const spec2 = (await getSpec('u-theo', deckId, second.body.revisionId)).body;
    const pages2 = spec2.slides.find((s: { id: string }) => s.id === 'pages');
    expect(pages2.bullets.join(' ')).toContain('no longer available to you');
    expect(pages2.bullets.join(' ')).not.toBe(pages1.bullets.join(' '));
    expect(JSON.stringify(spec2)).not.toContain(pages1.sources[0].title);
    // Stale base stays 409.
    expect((await revise('u-theo', deckId, { instruction: 'Make it shorter', baseRevisionId: head })).status).toBe(409);
  });

  it('a conversation the owner can no longer read cannot be revised', async () => {
    const { deckId, revisionId } = await savedDeck();
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    const res = await revise('u-sana', deckId, { instruction: 'Make it shorter', baseRevisionId: revisionId });
    expect([403, 404]).toContain(res.status);
    expect(socialDeckRevisionsFixture.rows()).toHaveLength(1);
  });
});

describe('the real agent path', () => {
  const invoke = agentcore.invokeAgent as jest.Mock;
  beforeEach(() => { (config.mock as { agentcore: boolean }).agentcore = false; invoke.mockReset(); });
  afterEach(() => { (config.mock as { agentcore: boolean }).agentcore = true; });

  it('uses the drafter command with the messages as evidence; a verbatim quote is kept, an invented one is not', async () => {
    invoke.mockImplementation(async (_id: string, input: { structuredInput: { slides: Array<{ slideId: string; evidence: Array<{ id: string; excerpt: string }> }> } }) => ({
      text: JSON.stringify({
        summary: 'Nova draft.',
        narratives: input.structuredInput.slides.map((s, i) => ({
          slideId: s.slideId, bullets: [i === 0 ? 'Thursday is the release.' : 'Nobody objected.'],
          source_spans: [{ evidenceId: s.evidence[0]!.id, text: i === 0 ? s.evidence[0]!.excerpt : 'Never said this' }],
        })),
        draft: true, published: false,
      }), toolCalls: [],
    }));
    const started = await run('u-sana', CHANNEL, 'Review'); await settle();
    const result = (await get('u-sana', started.body.runId)).body.result;
    expect(invoke).toHaveBeenCalledWith('orgiq-assessment-drafter', expect.objectContaining({
      structuredInput: expect.objectContaining({ tenant: 'social', mode: 'social-deck', slides: expect.any(Array) }) }));
    expect(result.narrative.status).toBe('partial');
    expect(JSON.stringify(result.spec)).toContain('Thursday is the release.');
    expect(JSON.stringify(result.spec)).not.toContain('Nobody objected');
  });

  it('an unreachable agent still yields a template deck, flagged unavailable', async () => {
    invoke.mockRejectedValue(new Error('runtime down'));
    const started = await run('u-sana', CHANNEL, 'Review'); await settle();
    const status = (await get('u-sana', started.body.runId)).body;
    expect(status.phase).toBe('completed');
    expect(status.result.narrative).toMatchObject({ status: 'unavailable', reason: 'runtime down' });
    expect(status.deckId).toBeTruthy();
  });

  it('an agent refusal keeps the template deck', async () => {
    invoke.mockResolvedValue({ text: '', raw: { error: 'forbidden', detail: "mode 'social-deck' is not allowed" }, toolCalls: [] });
    const started = await run('u-sana', CHANNEL, 'Review'); await settle();
    const status = (await get('u-sana', started.body.runId)).body;
    expect(status.phase).toBe('completed');
    expect(status.result.narrative).toMatchObject({ status: 'unavailable', reason: 'forbidden' });
  });
});

describe('pure pieces', () => {
  it('parses the command text', () => {
    expect(parseDeckArgs('Sprint review — risks --preview #initiative:p-soc2 #work-item:wi-1')).toEqual({
      ok: true, value: { topic: 'Sprint review — risks', preview: true, pages: [{ kind: 'initiative', id: 'p-soc2' }, { kind: 'work-item', id: 'wi-1' }], recordingId: null } });
    expect(parseDeckArgs('').ok).toBe(true);
    expect(parseDeckArgs('--FROM=recording:abc')).toMatchObject({ ok: true, value: { recordingId: 'abc' } });
    expect(parseDeckArgs('--FROM=documents').ok).toBe(false);
    expect(parseDeckArgs('#initiative:bad id').ok).toBe(true); // the space ends the token; "id" joins the topic
    expect(parseDeckArgs('#decision:1').ok).toBe(false);
    expect(deckTitleFrom('Sprint review — the release risks', 'x')).toBe('Sprint review');
    expect(deckTitleFrom('standup at 08:30 AM today', 'x')).toBe('standup at 08:30 AM today');
    expect(deckTitleFrom('', '#general deck')).toBe('#general deck');
  });

  it('counts facts from the lines and cites a message on every slide', () => {
    const lines = Array.from({ length: 13 }, (_, i) => ({ messageId: `m${i}`, author: i % 2 ? 'Ana' : 'Bo', text: `Line ${i}`, at: `2026-10-0${1 + (i % 3)}T10:0${i % 10}:00.000Z` }));
    const facts = buildConversationDeckFacts({ runId: 'sdk-x', title: 'T', conversationName: '#general', lines, pages: [] });
    expect(facts.slides.map(s => s.slideId)).toEqual(['title', 'overview', 'topic-1', 'topic-2', 'topic-3', 'people']);
    expect(facts.slides[1]!.facts).toMatchObject({ messages: 13, people: 2 });
    for (const slide of facts.spec.slides) expect(slide.sources.every(s => s.documentId.startsWith('social-message:'))).toBe(true);
    expect(topicChunks([1, 2, 3])).toEqual([]);
    expect(topicChunks(Array.from({ length: 100 }, (_, i) => i))).toHaveLength(4);
  });
});
