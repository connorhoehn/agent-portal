jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: false } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
import express from 'express';
import request from '../../test-support/http.js';
import { peopleRouter } from '../people.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import type { Session } from '../../lib/session.js';
import { createMemorySocialChatBackend, setSocialChatBackend, type SocialChatBackend } from '../../lib/social-chat.js';

const u = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: `${id} Dir`, email: null, personId: null, epoch: 1, grants });
const users = new Map([
  ['ana', u('ana', { orgiq: ['member'], social: ['participant'] })], ['bea', u('bea', { orgiq: ['member'], social: ['participant'] })],
  ['cy', u('cy', { orgiq: ['member'], social: ['participant'] })],
]);
let session: Session; let chat: SocialChatBackend;
const as = (sub: string, tenant: string): Session => {
  const role = users.get(sub)!.grants[tenant]![0]!;
  return { sub, name: sub, tenant, role, epoch: 1, iat: 1, grants: { [tenant]: [role] } } as Session;
};
const app = express();
app.use((req, _res, next) => { req.session = session; next(); });
app.use('/api/people', peopleRouter); app.use(errorHandler);
const put = (channel: string, id: string, userId: string, message: string, timestamp: string) =>
  chat.chatStore.putMessage({ id, channel, userId, message, timestamp } as never);
const list = async (sub: string, tenant: string) => {
  session = as(sub, tenant);
  const res = await request(app).get('/api/people/conversations');
  expect(res.status).toBe(200);
  return res.body.conversations as Array<{ channel: string; unreadCount: number; lastMessagePreview: string }>;
};

beforeEach(async () => {
  chat = createMemorySocialChatBackend({ fixtures: false });
  setSocialChatBackend(chat);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()]);
  process.env['NODE_ENV'] = 'production'; process.env['AUTH_DEMO_MODE'] = 'false';
  await put('orgiq:dm:ana:bea', 'm1', 'ana', 'hello orgiq', '2026-10-05T10:00:00Z');
  await put('social:dm:ana:bea', 's1', 'ana', 'hello social', '2026-10-05T09:00:00Z');
});
afterAll(() => { process.env['NODE_ENV'] = 'test'; delete process.env['AUTH_DEMO_MODE']; setSocialChatBackend(null); });

it('lists an orgiq DM for sender and peer, not a third user, not cross-tenant', async () => {
  expect((await list('ana', 'orgiq')).map(c => c.channel)).toEqual(['orgiq:dm:ana:bea']);
  expect((await list('bea', 'orgiq')).map(c => c.channel)).toEqual(['orgiq:dm:ana:bea']);
  expect(await list('cy', 'orgiq')).toEqual([]);
  expect((await list('ana', 'social')).map(c => c.channel)).toEqual(['social:dm:ana:bea']);
});

it('counts unread for the peer, not the sender, and clears on read like social', async () => {
  expect((await list('ana', 'orgiq'))[0]).toMatchObject({ unreadCount: 0, lastMessagePreview: 'hello orgiq' });
  expect((await list('bea', 'orgiq'))[0]!.unreadCount).toBe(1);
  expect((await list('bea', 'social'))[0]!.unreadCount).toBe(1);
  await chat.readReceiptStore.advance({ channel: 'orgiq:dm:ana:bea', userId: 'bea', readAt: '2026-10-05T10:30:00Z' } as never);
  expect((await list('bea', 'orgiq'))[0]!.unreadCount).toBe(0);
});
