// lib/clone-dms.ts: an identity clone reads its persona's DMs under its own id
// (channel names carry the clone, so the portal's snapshot check passes), and
// no clone reads another clone's or a different persona's.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn(), listUsers: jest.fn() }));
jest.mock('../../lib/authz.js', () => ({ isAllowed: jest.fn(), requireAction: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
import express from 'express';
import request from '../../test-support/http.js';
import { socialEmbedRouter } from '../social.js';
import { errorHandler } from '../../lib/async-handler.js';
import { getUser, listUsers, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../../lib/authz.js';
import { createMemorySocialChatBackend, setSocialChatBackend, dmMembers, type SocialChatBackend } from '../../lib/social-chat.js';
import { identityClonesFixture } from '../../mock/identity-clones.js';
import { channelGuard } from '../../lib/gateway/authority.js';
import type { Session } from '../../lib/session.js';

const grants = { orgiq: ['member'], social: ['participant'] };
const base: Session = { sub: 'alice', name: 'Alice', tenant: 'orgiq', role: 'member', epoch: 2, iat: 100, grants };
const ids = ['alice', 'bob', 'carol', 'alice-clone-1', 'alice-clone-2', 'bob-clone-1', 'alice-clone-gone'];
let users: Map<string, UserInfo>; let chat: SocialChatBackend;
const app = express(); app.use(express.json());
app.use((req, _res, next) => { const sub = String(req.headers['x-user']); req.session = { ...structuredClone(base), sub, name: sub }; next(); });
app.use('/api/social', socialEmbedRouter); app.use(errorHandler);
const get = (user: string) => request(app).get('/api/social/embedded').set('x-user', user);
const cloneRow = (id: string, from: string) => identityClonesFixture.rows().push({
  id, from, label: null, displayName: id, email: null, personId: null, grants, epoch: 0,
  createdAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});
async function dm(a: string, b: string, text: string, by: string, id: string) {
  const channel = `social:dm:${[a, b].sort().join(':')}`;
  const message = { id, clientId: by, userId: by, channel, message: text, timestamp: `2026-10-03T12:00:0${id.slice(1)}.000Z`, metadata: {} };
  await chat.chatStore.putMessage(message); await chat.conversations.recordDmMessage(channel, [a, b], message);
}
beforeEach(async () => {
  users = new Map(ids.map(id => [id, { id, displayName: id, email: null, personId: null, epoch: 2, grants: structuredClone(grants) }]));
  jest.mocked(getUser).mockImplementation(async id => users.get(id) ?? null);
  jest.mocked(listUsers).mockImplementation(async () => [...users.values()]);
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.tenant === 'social' && p.role === 'participant'
    && ['ViewSocial', 'PostMessage', 'StartCall'].includes(action));
  chat = createMemorySocialChatBackend({ fixtures: false }); setSocialChatBackend(chat);
  identityClonesFixture.reset();
  await dm('alice', 'bob', 'Alice and Bob only', 'bob', 'm1');
  await dm('alice', 'bob', 'Reply from Alice', 'alice', 'm2');
  await dm('bob', 'carol', 'Bob and Carol only', 'carol', 'm3');
});
afterEach(() => { identityClonesFixture.reset(); jest.restoreAllMocks(); });

// Session carries the social tenant for these (source.tenant is whatever the cookie says).
it('a clone reads its persona\'s DMs under channels that name the clone', async () => {
  cloneRow('alice-clone-1', 'alice');
  const res = await get('alice-clone-1');
  expect(res.status).toBe(200);
  expect(res.body.source.userId).toBe('alice-clone-1');
  expect(res.body.me.userId).toBe('alice-clone-1');
  expect(res.body.conversations).toHaveLength(1);
  const [c] = res.body.conversations;
  // What the portal's snapshot check requires: a canonical two-person name carrying the session's own id.
  expect(c.channel).toBe('social:dm:alice-clone-1:bob');
  expect(dmMembers(c.channel)).toEqual(['alice-clone-1', 'bob']);
  expect(c.peers).toEqual([expect.objectContaining({ userId: 'bob' })]);
  expect(c.lastMessagePreview).toBe('Reply from Alice');
  expect(c.lastMessageUserId).toBe('alice-clone-1');
  // Idempotent: asking again copies nothing twice.
  expect((await chat.chatStore.listMessages('social:dm:alice-clone-1:bob', 50)).map(m => m.message).sort()).toEqual(['Alice and Bob only', 'Reply from Alice']);
  expect((await get('alice-clone-1')).body.conversations).toHaveLength(1);
  expect((await chat.chatStore.listMessages('social:dm:alice-clone-1:bob', 50))).toHaveLength(2);
  // The clone may use its own channel, and still its persona's.
  expect(channelGuard({ userId: 'alice-clone-1', org: 'social', tenants: ['social'], role: 'participant' }, 'social:dm:alice-clone-1:bob')).toBe(true);
});

it('keeps the persona and every other clone apart', async () => {
  cloneRow('alice-clone-1', 'alice'); cloneRow('alice-clone-2', 'alice'); cloneRow('bob-clone-1', 'bob');
  await get('alice-clone-1');
  // The persona's own list is untouched by the clone's copies.
  const persona = await get('alice');
  expect(persona.body.conversations.map((c: { channel: string }) => c.channel)).toEqual(['social:dm:alice:bob']);
  // A second clone of the same persona gets its own copies, not the first clone's.
  const second = await get('alice-clone-2');
  expect(second.body.conversations.map((c: { channel: string }) => c.channel)).toEqual(['social:dm:alice-clone-2:bob']);
  // A clone of Bob sees Bob's DMs (with Alice and with Carol) and none of Alice's clones'.
  const bobClone = await get('bob-clone-1');
  expect(bobClone.body.conversations.map((c: { channel: string }) => c.channel).sort())
    .toEqual(['social:dm:alice:bob-clone-1', 'social:dm:bob-clone-1:carol']);
  // Neither the clones nor the persona's channel set mention another clone's id.
  expect(JSON.stringify(second.body.conversations)).not.toMatch(/alice-clone-1|bob-clone-1/);
  expect(JSON.stringify(persona.body.conversations)).not.toMatch(/clone/);
  // The peer never lists a clone's copy.
  expect((await get('bob')).body.conversations.map((c: { channel: string }) => c.channel).sort()).toEqual(['social:dm:alice:bob', 'social:dm:bob:carol']);
  // Nobody else's DM is readable: a clone of Alice never gets Bob and Carol's.
  expect(second.body.conversations.some((c: { channel: string }) => c.channel.includes('carol'))).toBe(false);
  // The gateway's shape guard: another clone's DM channel is closed to a clone, and a clone of Bob to Alice's.
  const auth = { userId: 'alice-clone-2', org: 'social', tenants: ['social'], role: 'participant' };
  expect(channelGuard(auth, 'social:dm:alice-clone-1:bob')).toBe(false);
  expect(channelGuard(auth, 'social:dm:bob-clone-1:carol')).toBe(false);
});

it('a clone-shaped id with no live row gets nothing copied', async () => {
  const res = await get('alice-clone-gone');
  expect(res.status).toBe(200);
  expect(res.body.conversations).toEqual([]);
  expect(await chat.chatStore.listMessages('social:dm:alice-clone-gone:bob', 5)).toEqual([]);
});
