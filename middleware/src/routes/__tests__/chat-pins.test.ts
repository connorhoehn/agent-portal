jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' },
    cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => [
    { id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] },
    { id: 'moderator', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] },
    { id: 'community-admin', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage'] },
  ],
}));

import express from 'express';
import request from '../../test-support/http.js';
import { chatPinsRouter } from '../chat-pins.js';
import { errorHandler } from '../../lib/async-handler.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import { socialChat, setSocialChatBackend, createMemorySocialChatBackend } from '../../lib/social-chat.js';
import { getUser } from '../../providers/identity.js';
import * as identity from '../../providers/identity.js';
import { socialPinsFixture, socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { freezeClock, unfreezeClock } from '../../mock/core/index.js';
import type { Session } from '../../lib/session.js';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';

const SECRET = 'pin-api-test-secret';
const previousSecret = process.env['REALTIME_JWT_SECRET'];
const body = { channel: 'social:ch:general', messageId: 'm1', text: 'Remember the deployment checklist',
  author: 'Mira Okafor', sentAt: '2026-10-01T12:00:00.000Z' };
const original = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: body.messageId, channel: body.channel, clientId: 'message-connection', userId: 'u-mira',
  message: body.text, timestamp: body.sentAt, metadata: { displayName: body.author }, ...over,
});
const app = express();
app.use(express.json()); app.use('/api/chat', chatPinsRouter); app.use(errorHandler);

async function token(sub = 'u-sana', now?: number): Promise<string> {
  const user = await getUser(sub);
  const session = { sub, name: user?.displayName, role: 'participant', tenant: 'social',
    grants: user?.grants ?? {}, iat: 0 } as Session;
  return (await signRealtimeToken(realtimeClaims(session), SECRET, now)).token;
}
beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = SECRET; });
afterAll(() => {
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = previousSecret;
});
beforeEach(async () => {
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  await socialChat().chatStore.putMessage(original());
});
afterEach(() => {
  socialPinsFixture.reset(); socialChannelMembersFixture.reset(); socialChannelMessagesFixture.reset();
  jest.restoreAllMocks(); setSocialChatBackend(null);
});

it('a pin belongs to the authenticated member and another member can read and remove it', async () => {
  const sana = await token(), lena = await token('u-lena');
  const pinned = await request(app).post('/api/chat/pins').set('Authorization', `Bearer ${sana}`)
    .send({ ...body, pinnedBy: 'u-mira', pinnedAt: '2030-01-01' });
  expect(pinned.status).toBe(200);
  expect(pinned.body.pin).toMatchObject({ channelId: body.channel, messageId: 'm1', pinnedBy: 'u-sana', sentAt: body.sentAt });
  expect(pinned.body.pin.pinnedAt).not.toBe('2030-01-01');
  expect((await request(app).get('/api/chat/pins').query({ channel: body.channel })
    .set('Authorization', `Bearer ${lena}`)).body.pins).toHaveLength(1);
  expect((await request(app).delete('/api/chat/pins').set('Authorization', `Bearer ${lena}`).send(body)).status).toBe(200);
  expect(await socialChat().pinsStore.list(body.channel)).toEqual([]);
});

it('rejects anonymous, forged, expired and revoked identities', async () => {
  const query = { channel: body.channel };
  expect((await request(app).get('/api/chat/pins').query(query)).status).toBe(401);
  expect((await request(app).get('/api/chat/message').query({ ...query, messageId: body.messageId })).status).toBe(401);
  expect((await request(app).get('/api/chat/pins').query(query).set('Authorization', 'Bearer forged')).status).toBe(401);
  expect((await request(app).get('/api/chat/pins').query(query).set('Authorization', `Bearer ${await token('u-sana', 1)}`)).status).toBe(401);
  const valid = await token();
  const user = await getUser('u-sana');
  jest.spyOn(identity, 'getUser').mockResolvedValue({ ...user!, grants: {} });
  expect((await request(app).get('/api/chat/pins').query(query).set('Authorization', `Bearer ${valid}`)).status).toBe(403);
});

it.each(['social:ch:moderators', 'social:ch:design-reviews', 'social:dm:u-lena:u-mira', 'social:team:nonexistent:general'])
  ('a non-member cannot read, pin or unpin in %s', async (channel) => {
    const bearer = `Bearer ${await token()}`;
    expect((await request(app).get('/api/chat/pins').query({ channel }).set('Authorization', bearer)).status).toBe(403);
    expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send({ ...body, channel })).status).toBe(403);
    expect((await request(app).delete('/api/chat/pins').set('Authorization', bearer).send({ ...body, channel })).status).toBe(403);
  });

it('a DM participant can pin, while a malformed or other-tenant channel is refused', async () => {
  const bearer = `Bearer ${await token()}`;
  await socialChat().chatStore.putMessage(original({ channel: 'social:dm:u-lena:u-sana' }));
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer)
    .send({ ...body, channel: 'social:dm:u-lena:u-sana' })).status).toBe(200);
  for (const channel of ['orgiq:deck:x', 'social:dm:u-sana:u-lena', 'social:dm:u-sana:u-sana']) {
    expect((await request(app).get('/api/chat/pins').query({ channel }).set('Authorization', bearer)).status).toBe(400);
  }
  // A tenant discussion is a pinnable name now (tenant-chat-pins.test.ts), but
  // a Social session's token is refused there: its tenant is not orgiq.
  expect((await request(app).get('/api/chat/pins').query({ channel: 'orgiq:initiative:x' }).set('Authorization', bearer)).status).toBe(403);
});

it('a removed channel member loses pin access immediately', async () => {
  const bearer = `Bearer ${await token()}`;
  socialChannelMembersFixture.rows().find((m) => m.channel === body.channel && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
  expect((await request(app).get('/api/chat/pins').query({ channel: body.channel }).set('Authorization', bearer)).status).toBe(403);
});

it('a DM name cannot override an explicit removed conversation member or history floor', async () => {
  const channel = 'social:dm:u-lena:u-sana';
  const backend = socialChat();
  await backend.chatStore.putMessage(original({ channel }));
  await backend.membershipStore.putMember({ channel, userId: 'u-sana', role: 'member', addedBy: 'u-lena',
    addedAt: body.sentAt, historyFrom: body.sentAt, removedAt: null });
  const bearer = `Bearer ${await token()}`;
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send({ ...body, channel })).status).toBe(404);
  const member = await backend.membershipStore.getMember(channel, 'u-sana');
  await backend.membershipStore.putMember({ ...member!, removedAt: '2026-10-01T13:00:00.000Z' });
  expect((await request(app).get('/api/chat/pins').query({ channel }).set('Authorization', bearer)).status).toBe(403);
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send({ ...body, channel })).status).toBe(403);
  expect((await request(app).delete('/api/chat/pins').set('Authorization', bearer).send({ ...body, channel })).status).toBe(403);
});

it('pins are resettable fixture rows; failed writes are not reported as success or broadcast', async () => {
  const publish = jest.fn();
  const backend = socialChat(); setSocialChatBackend(backend, null, publish);
  const bearer = `Bearer ${await token()}`;
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send(body)).status).toBe(200);
  expect(publish).toHaveBeenCalledWith(body.channel);
  socialPinsFixture.reset(); expect(await backend.pinsStore.list(body.channel)).toEqual([]);
  publish.mockClear();
  jest.spyOn(backend.pinsStore, 'pin').mockRejectedValue(new Error('database unavailable'));
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send(body)).status).toBe(500);
  expect(publish).not.toHaveBeenCalled();
});

it('rejects incomplete pin addresses', async () => {
  const bearer = `Bearer ${await token()}`;
  for (const patch of [{ messageId: '' }, { channel: '' }, { messageId: 1 }]) {
    expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send({ ...body, ...patch })).status).toBe(400);
  }
});

it('resolves the real message instead of trusting a forged excerpt, author or send time', async () => {
  const bearer = `Bearer ${await token()}`;
  await socialChat().chatStore.updateMessage(body.channel, body.messageId, { metadata: { displayName: 'Forged message label' } });
  const response = await request(app).post('/api/chat/pins').set('Authorization', bearer).send({
    ...body, text: 'An invented announcement', author: 'Someone else', sentAt: 'not even a timestamp',
  });
  expect(response.status).toBe(200);
  expect(response.body.pin).toMatchObject({ preview: body.text, author: body.author, sentAt: body.sentAt, pinnedBy: 'u-sana' });
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer)
    .send({ ...body, messageId: 'invented' })).status).toBe(404);
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer)
    .send({ channel: body.channel, messageId: body.messageId })).status).toBe(200);
});

it('does not disclose or accept pins at or before the caller’s history floor', async () => {
  const backend = socialChat();
  const member = await backend.membershipStore.getMember(body.channel, 'u-sana');
  await backend.membershipStore.putMember({ ...member!, historyFrom: body.sentAt });
  await backend.chatStore.putMessage(original({ id: 'before', timestamp: '2026-10-01T11:59:59.000Z' }));
  await backend.chatStore.putMessage(original({ id: 'after', timestamp: '2026-10-01T12:00:00.001Z', message: 'Visible message' }));
  for (const messageId of ['before', body.messageId, 'after']) {
    await backend.pinsStore.pin({ channelId: body.channel, messageId, pinnedBy: 'u-mira',
      text: 'Untrusted snapshot', author: 'Untrusted author', sentAt: '2030-01-01T00:00:00.000Z' });
  }
  const bearer = `Bearer ${await token()}`;
  const response = await request(app).get('/api/chat/pins').query({ channel: body.channel }).set('Authorization', bearer);
  expect(response.status).toBe(200);
  expect(response.body.pins).toHaveLength(1);
  expect(response.body.pins[0]).toMatchObject({ messageId: 'after', preview: 'Visible message', author: body.author,
    sentAt: '2026-10-01T12:00:00.001Z' });
  for (const messageId of ['before', body.messageId]) {
    expect((await request(app).post('/api/chat/pins').set('Authorization', bearer)
      .send({ ...body, messageId, sentAt: '2030-01-01T00:00:00.000Z' })).status).toBe(404);
  }
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send({ ...body, messageId: 'after' })).status).toBe(200);
});

it('updates visible excerpts after edits and hides deleted originals while preserving unpin access', async () => {
  const bearer = `Bearer ${await token()}`;
  await request(app).post('/api/chat/pins').set('Authorization', bearer).send(body);
  await socialChat().chatStore.updateMessage(body.channel, body.messageId, { message: 'Corrected checklist' });
  expect((await request(app).get('/api/chat/pins').query({ channel: body.channel }).set('Authorization', bearer)).body.pins[0].preview)
    .toBe('Corrected checklist');
  await socialChat().chatStore.updateMessage(body.channel, body.messageId,
    { message: '', metadata: { deleted: true }, deletedAt: '2026-10-01T13:00:00.000Z' });
  expect((await request(app).get('/api/chat/pins').query({ channel: body.channel }).set('Authorization', bearer)).body.pins).toEqual([]);
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send(body)).status).toBe(404);
  expect((await request(app).delete('/api/chat/pins').set('Authorization', bearer).send(body)).status).toBe(200);
});

it('hides retained rows whose originals are missing and still allows their removal', async () => {
  const bearer = `Bearer ${await token()}`;
  await socialChat().pinsStore.pin({ channelId: body.channel, messageId: 'expired', pinnedBy: 'u-mira',
    text: 'An expired excerpt', author: body.author, sentAt: body.sentAt });
  expect((await request(app).get('/api/chat/pins').query({ channel: body.channel }).set('Authorization', bearer)).body.pins).toEqual([]);
  expect((await request(app).delete('/api/chat/pins').set('Authorization', bearer).send({ ...body, messageId: 'expired' })).status).toBe(200);
  expect(await socialChat().pinsStore.list(body.channel)).toEqual([]);
});

it('can pin an original beyond the recent history window and fails closed without direct lookup', async () => {
  const backend = socialChat();
  for (let i = 0; i < 1_010; i++) {
    await backend.chatStore.putMessage(original({ id: `newer-${i}`, timestamp: '2026-10-01T13:00:00.000Z' }));
  }
  expect((await backend.chatStore.listMessages(body.channel, 1_000)).some(m => m.id === body.messageId)).toBe(false);
  const bearer = `Bearer ${await token()}`;
  const loaded = await request(app).get('/api/chat/message').query({ channel: body.channel, messageId: body.messageId }).set('Authorization', bearer);
  expect(loaded.status).toBe(200);
  expect(loaded.body.message).toEqual(original());
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send(body)).status).toBe(200);
  backend.chatStore.getMessage = undefined;
  expect((await request(app).post('/api/chat/pins').set('Authorization', bearer).send(body)).status).toBe(503);
  expect((await request(app).get('/api/chat/pins').query({ channel: body.channel }).set('Authorization', bearer)).status).toBe(503);
  expect((await request(app).get('/api/chat/message').query({ channel: body.channel, messageId: body.messageId }).set('Authorization', bearer)).status).toBe(503);
});

it.each(['social:ch:moderators', 'social:dm:u-lena:u-mira', 'social:team:nonexistent:general'])
  ('a non-member cannot retrieve an original from %s', async channel => {
    const response = await request(app).get('/api/chat/message').query({ channel, messageId: body.messageId })
      .set('Authorization', `Bearer ${await token()}`);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('message');
  });

it('does not retrieve missing/deleted originals or messages outside the caller’s history permission', async () => {
  const backend = socialChat();
  const bearer = `Bearer ${await token()}`;
  const retrieve = (messageId: string) => request(app).get('/api/chat/message').query({ channel: body.channel, messageId }).set('Authorization', bearer);
  expect((await retrieve('missing')).status).toBe(404);
  const member = await backend.membershipStore.getMember(body.channel, 'u-sana');
  await backend.membershipStore.putMember({ ...member!, historyFrom: body.sentAt });
  expect((await retrieve(body.messageId)).status).toBe(404);
  await backend.chatStore.putMessage(original({ id: 'before-floor', timestamp: '2026-10-01T11:59:59.000Z' }));
  expect((await retrieve('before-floor')).status).toBe(404);
  await backend.chatStore.putMessage(original({ id: 'visible', timestamp: '2026-10-01T12:00:00.001Z' }));
  expect((await retrieve('visible')).status).toBe(200);
  await backend.chatStore.updateMessage(body.channel, 'visible', { message: '', deletedAt: '2026-10-01T13:00:00.000Z' });
  expect((await retrieve('visible')).status).toBe(404);
  for (const messageId of ['', 'x'.repeat(257)]) expect((await retrieve(messageId)).status).toBe(400);
});

it('pins and lists at exactly UTC midnight with the mock clock frozen', async () => {
  freezeClock('2026-10-06T00:00:00.000Z');
  try {
    const sana = await token();
    const pinned = await request(app).post('/api/chat/pins').set('Authorization', `Bearer ${sana}`).send(body);
    expect(pinned.status).toBe(200);
    expect(pinned.body.pin.pinnedAt).toBeDefined();
    expect((await request(app).get('/api/chat/pins').query({ channel: body.channel }).set('Authorization', `Bearer ${sana}`)).status).toBe(200);
  } finally { unfreezeClock(); }
});
