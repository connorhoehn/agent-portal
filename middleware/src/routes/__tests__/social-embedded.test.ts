jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(), requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
import express from 'express';
import request from '../../test-support/http.js';
import { socialEmbedRouter } from '../social.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { createMemorySocialChatBackend, setSocialChatBackend, type SocialChatBackend } from '../../lib/social-chat.js';
import type { Session } from '../../lib/session.js';

const alice: Session = { sub: 'alice', name: 'Forged cookie label', tenant: 'orgiq', role: 'member', epoch: 2, iat: 100,
  grants: { orgiq: ['member'], social: ['participant'] } };
const bob: Session = { ...alice, sub: 'bob' };
const hr: Session = { ...alice, sub: 'hr', role: 'hr-admin', grants: { orgiq: ['hr-admin'] } };
let users: Map<string, UserInfo>; let sessions: Map<string, Session>; let chat: SocialChatBackend;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { req.session = sessions.get(String(req.headers['x-user'])); next(); });
app.use('/api/social', socialEmbedRouter); app.use(errorHandler);
const get = (user = 'alice') => request(app).get('/api/social/embedded').set('x-user', user);
beforeEach(async () => {
  sessions = new Map([alice, bob, hr].map(s => [s.sub, structuredClone(s)]));
  users = new Map([alice, bob, hr].map(s => [s.sub, { id: s.sub, displayName: `${s.sub} Directory`, email: null,
    personId: null, epoch: s.epoch!, grants: structuredClone(s.grants) }]));
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()]);
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'social' && p.role === 'participant'
    && ['ViewSocial', 'PostMessage', 'StartCall'].includes(action));
  chat = createMemorySocialChatBackend({ fixtures: false }); setSocialChatBackend(chat);
  const message = { id: 'dm-original', clientId: 'b', userId: 'bob', channel: 'social:dm:alice:bob',
    message: 'Only our DM', timestamp: '2026-10-03T12:00:00.000Z', metadata: {} };
  await chat.chatStore.putMessage(message); await chat.conversations.recordDmMessage(message.channel, ['alice', 'bob'], message);
});
afterEach(() => jest.restoreAllMocks());

it('returns bounded canonical Social workspace data without changing source tenant or role', async () => {
  const res = await request(app).get('/api/social/embedded').set('x-user', 'alice');
  expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toMatchObject({ me: { userId: 'alice', displayName: 'alice Directory' }, canSend: true,
    peopleTotal: 2, peopleHasMore: false, conversationsHasMore: false,
    source: { userId: 'alice', tenant: 'orgiq', role: 'member', epoch: 2, actor: null },
    people: [{ userId: 'alice', displayName: 'alice Directory', roles: ['participant'] }, { userId: 'bob', displayName: 'bob Directory', roles: ['participant'] }],
    conversations: [{ channel: 'social:dm:alice:bob', peers: [{ userId: 'bob', displayName: 'bob Directory' }],
      lastMessagePreview: 'Only our DM', lastMessageUserId: 'bob', unreadCount: 1 }] });
  expect(res.body.authorityKey).toMatch(/^[a-f0-9]{64}$/); expect((await get()).body.authorityKey).toBe(res.body.authorityKey);
  expect(sessions.get('alice')).toMatchObject({ tenant: 'orgiq', role: 'member' });
  expect(listUsers).toHaveBeenCalledWith({ authoritative: true });
});

it('offers read-only capability when PostMessage is denied and preserves the existing DM open contract when allowed', async () => {
  jest.mocked(isAllowed).mockImplementation(async (_p, action) => action === 'ViewSocial');
  expect((await get()).body.canSend).toBe(false);
  expect((await request(app).post('/api/social/dms').set('x-user', 'alice').send({ userId: 'bob' })).status).toBe(403);
  jest.mocked(isAllowed).mockResolvedValue(true);
  const opened = await request(app).post('/api/social/dms').set('x-user', 'alice').send({ userId: 'bob' });
  expect(opened.body).toEqual({ channel: 'social:dm:alice:bob', peers: [{ userId: 'bob', displayName: 'bob Directory' }] });
});

it('admits actual source-scoped DM reads while refusing unrelated, malformed, reserved and removed conversations', async () => {
  expect((await request(app).post('/api/social/dms/read').set('x-user', 'alice').send({ channel: 'social:dm:alice:bob' })).status).toBe(200);
  for (const channel of ['social:dm:bob:alice', 'social:dm:alice:alice', 'orgiq:huddle:call']) {
    expect((await request(app).post('/api/social/dms/read').set('x-user', 'alice').send({ channel })).status).toBe(400);
  }
  expect((await request(app).post('/api/social/dms/read').set('x-user', 'alice').send({ channel: 'social:dm:bob:charlie' })).status).toBe(404);
  await chat.membershipStore.putMember({ channel: 'social:dm:alice:bob', userId: 'bob', role: 'owner', addedBy: 'bob',
    addedAt: '2026-10-03T00:00:00.000Z', historyFrom: null, removedAt: null });
  expect((await get()).body.conversations).toEqual([]);
  expect((await request(app).post('/api/social/dms/read').set('x-user', 'alice').send({ channel: 'social:dm:alice:bob' })).status).toBe(404);
});

it('rejects absent/currently revoked authority, retired epochs and invalid masquerade actors', async () => {
  expect((await request(app).get('/api/social/embedded')).status).toBe(401); expect((await get('hr')).status).toBe(403);
  users.get('alice')!.grants.social = []; expect((await get()).status).toBe(403);
  users.get('alice')!.grants.social = ['participant']; users.get('alice')!.epoch = 3; expect((await get()).status).toBe(401);
  users.get('alice')!.epoch = 2; users.get('alice')!.grants.orgiq = ['sme']; expect((await get()).status).toBe(401);
  users.get('alice')!.grants.orgiq = ['member'];
  sessions.get('alice')!.act = { sub: 'operator', epoch: 1, role: 'admin', tenant: 'orgiq', grants: { orgiq: ['admin'] } };
  users.set('operator', { id: 'operator', displayName: 'Operator', email: null, personId: null, epoch: 1, grants: { orgiq: ['admin'] } });
  const valid = await get(); expect(valid.status).toBe(200); expect(valid.body.source.actor).toEqual({ userId: 'operator', epoch: 1 });
  users.get('operator')!.grants = { orgiq: ['member'] }; expect((await get()).status).toBe(401);
});

it('never replaces failed authoritative directory reads with seed roster data', async () => {
  jest.mocked(listUsers).mockRejectedValueOnce(new Error('Aurora unavailable'));
  const failure = await get(); expect(failure.status).toBe(503); expect(failure.body.people).toBeUndefined();
  jest.mocked(getUser).mockRejectedValueOnce(new Error('Aurora unavailable')); expect((await get()).status).toBe(503);
});

it('rechecks the source after slow conversation reads before returning message previews or people', async () => {
  let start!: () => void; let release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }); const waiting = new Promise<void>(resolve => { release = resolve; });
  const original = chat.readReceiptStore.listReceipts.bind(chat.readReceiptStore);
  jest.spyOn(chat.readReceiptStore, 'listReceipts').mockImplementationOnce(async channel => { start(); await waiting; return original(channel); });
  const pending = get().then(value => value); await started;
  users.get('alice')!.grants.social = []; release();
  const result = await pending; expect(result.status).toBe(403); expect(result.body.people).toBeUndefined(); expect(result.body.conversations).toBeUndefined();
});

it.each(['workspace', 'read receipt'])('fences DM removal during the final %s identity lookup', async mode => {
  const channel = 'social:dm:alice:bob';
  const member = { channel, userId: 'alice', role: 'member' as const, addedBy: 'alice',
    addedAt: '2026-10-03T00:00:00.000Z', historyFrom: null, removedAt: null };
  await chat.membershipStore.putMember(member);
  let start!: () => void; let release!: () => void; let count = 0;
  const started = new Promise<void>(resolve => { start = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  // The one Social gate (lib/social-authority.ts) reads the directory twice (the session, then the recheck after
  // the policy call) and the handler's final currentSocialActionSession reads it twice more: the third read is
  // the first of the final lookup, in both modes.
  jest.mocked(getUser).mockImplementation(async id => {
    if (++count === 3) { start(); await waiting; }
    return users.get(id) ?? null;
  });
  const advance = jest.spyOn(chat.readReceiptStore, 'advance');
  const pending = (mode === 'workspace' ? get() : request(app).post('/api/social/dms/read')
    .set('x-user', 'alice').send({ channel })).then(value => value);
  await started;
  await chat.membershipStore.putMember({ ...member, removedAt: '2026-10-03T01:00:00.000Z' }); release();
  const result = await pending;
  if (mode === 'workspace') { expect(result.status).toBe(200); expect(result.body.conversations).toEqual([]); }
  else { expect(result.status).toBe(404); expect(advance).not.toHaveBeenCalled(); }
});

it('caps shell people and recent DM expansion while keeping normal Social route helpers reusable', async () => {
  for (let n = 0; n < 550; n++) users.set(`peer-${n}`, { id: `peer-${n}`, displayName: `Peer ${n}`, email: null,
    personId: null, epoch: 0, grants: { social: ['participant'] } });
  const rows = Array.from({ length: 55 }, (_, n) => ({ channel: `social:dm:alice:peer-${n}`, peers: ['alice', `peer-${n}`],
    lastMessageAt: new Date(Date.UTC(2026, 9, 3, 12, n)).toISOString(), lastMessagePreview: `Message ${n}`, lastMessageUserId: `peer-${n}` }));
  users.get('peer-54')!.displayName = 'Zulu outside alphabetical cap';
  jest.spyOn(chat.conversations, 'listForUser').mockResolvedValue(rows);
  const result = await get(); expect(result.status).toBe(200); expect(result.body.people).toHaveLength(500);
  expect(result.body.conversations).toHaveLength(50); expect(result.body.conversations[0].lastMessagePreview).toBe('Message 54');
  expect(result.body.people).toContainEqual({ userId: 'peer-54', displayName: 'Zulu outside alphabetical cap', roles: ['participant'], avatarUrl: null });
  expect(result.body).toMatchObject({ peopleTotal: 552, peopleHasMore: true, conversationsHasMore: true });
});

describe('GET /api/social/share-destinations', () => {
  const dest = (user = 'alice') => request(app).get('/api/social/share-destinations').set('x-user', user);
  const member = (channel: string, userId: string, removedAt: string | null = null) => ({ channel, userId, role: 'member' as const,
    addedBy: userId, addedAt: '2026-10-03T00:00:00.000Z', historyFrom: null, removedAt });
  beforeEach(async () => {
    const { createChannel } = await import('../../providers/social-channels.js');
    for (const [slug, privacy] of [['mine', 'private'], ['open-unjoined', 'public'], ['removed', 'public']] as const) {
      await createChannel({ slug, name: slug, description: null, privacy, createdBy: 'bob' }).catch(() => undefined);
    }
    await chat.membershipStore.putMember(member('social:ch:mine', 'alice'));
    await chat.membershipStore.putMember(member('social:ch:removed', 'alice', '2026-10-03T01:00:00.000Z'));
  });

  it('lists only channels the caller is an active member of, plus DMs, from a non-social tenant session', async () => {
    const res = await dest();
    expect(res.status).toBe(200);
    expect(res.body.channels.map((c: { slug: string }) => c.slug)).toEqual(['mine']);
    expect(res.body.conversations).toEqual([{ channel: 'social:dm:alice:bob', peers: [{ userId: 'bob', displayName: 'bob Directory' }] }]);
  });

  it('refuses a caller with no social grant and one denied PostMessage', async () => {
    expect((await dest('hr')).status).toBe(403);
    jest.mocked(isAllowed).mockImplementation(async (_p, action) => action === 'ViewSocial');
    expect((await dest()).status).toBe(403);
  });
});

it('lists a newly created DM in /embedded before its first message, for both people', async () => {
  users.set('carol', { id: 'carol', displayName: 'carol Directory', email: null, personId: null, epoch: 2, grants: { orgiq: ['member'], social: ['participant'] } });
  sessions.set('carol', { ...alice, sub: 'carol' });
  const opened = await request(app).post('/api/social/dms').set('x-user', 'alice').send({ userId: 'carol' });
  expect(opened.body.channel).toBe('social:dm:alice:carol');
  for (const who of ['alice', 'carol']) {
    const channels = (await get(who)).body.conversations.map((c: { channel: string }) => c.channel);
    expect(channels).toContain('social:dm:alice:carol');
  }
});
