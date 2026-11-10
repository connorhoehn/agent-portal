// One conversation per initiative, over HTTP: every route the initiative page
// (portal ProjectDetailPage + InitiativeComposer) reaches for its bound
// channel, called from a Work (orgiq) session. The socket half is
// lib/__tests__/initiative-bound-channel-gateway.test.ts.
//   - the binding read: a non-member sees the binding and `joined: false`,
//     never a message; a user with no Social grant is refused;
//   - the plane's capabilities: a user with no Social grant, or a Social role
//     that only reads, may not post;
//   - pins and a pinned original, and every conversation command the composer
//     offers (/summarize, /diagram, /doc, /agent, /deck): a non-member and a
//     user with no Social grant are refused and no run is created; a member
//     is served (the positive control).
// Fixtures: #auth-migration is bound to p-auth-migration; Theo is a member,
// Nina (Social participant) is not, Helen has no Social grant, Mia is a member
// whose Social role reads only.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { policyStoreId: undefined, sessionSigningSecretArn: '' },
    cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/role-registry.js', () => ({ roleRegistry: () => [
  { id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'reader', tenant: 'social', capabilities: ['ViewSocial'] },
  { id: 'member', tenant: 'orgiq', capabilities: ['Search', 'ViewWorkItems'] },
  { id: 'program-owner', tenant: 'orgiq', capabilities: ['Search', 'ViewWorkItems', 'DispatchAgentRun'] },
  { id: 'hr-admin', tenant: 'orgiq', capabilities: ['Search', 'ViewWorkItems', 'DispatchAgentRun'] },
] }));

import express from 'express';
import request from '../../test-support/http.js';
import { errorHandler } from '../../lib/async-handler.js';
import { socialEmbedRouter } from '../social.js';
import { socialPlaneRouter } from '../social-plane.js';
import { chatPinsRouter } from '../chat-pins.js';
import { socialSummarizeRouter, pendingSummaries } from '../social-summarize.js';
import { conversationSummarizeRouter } from '../conversation-summarize.js';
import { conversationArtifactRouter, socialArtifactRouter } from '../conversation-artifact.js';
import { conversationAgentRouter, socialAgentRouter } from '../agent-loop.js';
import { socialDeckRouter } from '../social-deck.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import { socialChat, setSocialChatBackend, createMemorySocialChatBackend } from '../../lib/social-chat.js';
import { getUser } from '../../providers/identity.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import type { Session } from '../../lib/session.js';

const SECRET = 'initiative-bound-channel-routes';
const CHANNEL = 'social:ch:auth-migration';
const CONTEXT = 'initiative:p-auth-migration';
const previousSecret = process.env['REALTIME_JWT_SECRET'];

async function workSession(sub: string): Promise<Session> {
  const user = await getUser(sub, { authoritative: true });
  if (!user) throw new Error(`no fixture user ${sub}`);
  return { sub, name: user.displayName, role: user.grants['orgiq']?.[0], tenant: 'orgiq', grants: user.grants,
    epoch: user.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
}

const app = express();
app.use(express.json());
// The page's cookie session, as the session middleware would set it.
app.use((req, _res, next) => {
  const who = req.get('x-user');
  if (!who) { next(); return; }
  workSession(who).then((s) => { (req as unknown as { session: Session }).session = s; next(); }, next);
});
// index.ts order and paths.
app.use('/api/social', socialEmbedRouter);
app.use('/api/social/plane', socialPlaneRouter);
app.use('/api/chat', chatPinsRouter);
app.use('/api/chat/commands', socialSummarizeRouter);
app.use('/api/chat/commands', socialArtifactRouter);
app.use('/api/chat/commands', socialAgentRouter);
app.use('/api/conversations/summarize', conversationSummarizeRouter);
app.use('/api/conversations', conversationArtifactRouter);
app.use('/api/conversations', conversationAgentRouter);
app.use('/api/chat', socialDeckRouter);
app.use(errorHandler);

async function bearer(sub: string): Promise<string> {
  return `Bearer ${(await signRealtimeToken(realtimeClaims(await workSession(sub)), SECRET)).token}`;
}
/** A call as the page makes it: the cookie session and the realtime bearer both name the user. */
async function call(method: 'get' | 'post' | 'delete', path: string, sub: string, body?: object) {
  const r = request(app)[method](path).set('x-user', sub).set('Authorization', await bearer(sub));
  return body === undefined ? r : r.send(body);
}

let seedMessageId = '';
let seedText = '';

beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = SECRET; });
afterAll(() => {
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
});
beforeEach(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  identityGrantWritesFixture.rows().push({ userId: 'u-mia', grants: { orgiq: ['program-owner', 'member'], social: ['reader'] } });
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  await socialChat().ready;
  const recent = await socialChat().chatStore.listMessages(CHANNEL, 5);
  seedMessageId = recent.at(-1)?.id ?? '';
  seedText = recent.at(-1)?.message ?? '';
  // Pin one, so a refused reader has something to be refused from.
  await socialChat().pinsStore.pin({ channelId: CHANNEL, messageId: seedMessageId, pinnedBy: 'u-theo', text: seedText, author: 'Theo Chang', sentAt: new Date().toISOString() });
});
afterEach(async () => {
  await Promise.all([...pendingSummaries]);
  socialChannelMembersFixture.reset(); socialChannelMessagesFixture.reset(); flowRunsFixture.reset(); identityGrantWritesFixture.reset();
  jest.restoreAllMocks(); setSocialChatBackend(null);
});

const OUTSIDERS = [['u-nina', 'a Social user who is not a member'], ['u-hr', 'a Work user with no Social grant']] as const;

/** What the composer's commands send for the bound channel (Social's command routes). */
const COMMANDS: Array<[string, Record<string, unknown>]> = [
  ['/api/chat/commands/summarize/run', { channel: CHANNEL, text: '' }],
  ['/api/chat/commands/diagram/run', { channel: CHANNEL, text: 'the cutover' }],
  ['/api/chat/commands/doc/run', { channel: CHANNEL, text: 'the cutover' }],
  ['/api/chat/commands/agent/run', { channel: CHANNEL, text: 'summarize then draft a page' }],
  ['/api/chat/commands/deck/run', { channel: CHANNEL, text: 'the cutover' }],
];
/** The tenant conversations' command routes take no Social channel at all, for anyone. */
const TENANT_COMMANDS = ['/api/conversations/summarize/run', '/api/conversations/diagram/run', '/api/conversations/doc/run', '/api/conversations/agent/run'];

describe('the bound channel over HTTP, from a Work session', () => {
  it('the fixture is the shape this suite assumes', () => {
    expect(seedMessageId).toBeTruthy();
    expect(socialChat().membershipStore.isActiveMember(CHANNEL, 'u-theo')).toBe(true);
    expect(socialChat().membershipStore.isActiveMember(CHANNEL, 'u-mia')).toBe(true);
    expect(socialChat().membershipStore.isActiveMember(CHANNEL, 'u-nina')).toBe(false);
  });

  it('the binding read names the channel to a non-member with joined false and no message, and refuses a user with no Social grant', async () => {
    const theo = await call('get', `/api/social/bindings?context=${CONTEXT}`, 'u-theo');
    expect(theo.status).toBe(200);
    expect(theo.body).toMatchObject({ binding: { channel: CHANNEL }, joined: true });
    const nina = await call('get', `/api/social/bindings?context=${CONTEXT}`, 'u-nina');
    expect(nina.status).toBe(200);
    expect(nina.body).toMatchObject({ binding: { channel: CHANNEL }, joined: false });
    expect(JSON.stringify(nina.body)).not.toContain(seedText.slice(0, 30));
    const helen = await call('get', `/api/social/bindings?context=${CONTEXT}`, 'u-hr');
    expect(helen.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(helen.body)).not.toContain(CHANNEL);
  });

  it('posting is the channel\'s rule: no Social grant, or a Social role that only reads, may not post, whatever the Work role', async () => {
    const caps = async (sub: string) => (await call('get', '/api/social/plane/capabilities', sub)).body as { actions: Record<string, boolean> };
    expect((await caps('u-theo')).actions['PostMessage']).toBe(true);   // Work member without the thread's write
    expect((await caps('u-mia')).actions['PostMessage']).toBe(false);   // Work DispatchAgentRun, Social reader
    expect((await caps('u-mia')).actions['ViewSocial']).toBe(true);
    expect((await caps('u-hr')).actions['PostMessage']).toBe(false);    // Work DispatchAgentRun, no Social grant
    expect((await caps('u-hr')).actions['ViewSocial']).toBe(false);
  });

  it.each(OUTSIDERS)('%s (%s) cannot read the pins or a pinned original, nor pin', async (sub) => {
    const pinsBefore = (await socialChat().pinsStore.list(CHANNEL)).map((p) => p.messageId).sort();
    expect(pinsBefore).toContain(seedMessageId);
    for (const r of [
      await call('get', `/api/chat/pins?channel=${encodeURIComponent(CHANNEL)}`, sub),
      await call('get', `/api/chat/message?channel=${encodeURIComponent(CHANNEL)}&messageId=${encodeURIComponent(seedMessageId)}`, sub),
      await call('post', '/api/chat/pins', sub, { channel: CHANNEL, messageId: seedMessageId }),
      await call('delete', '/api/chat/pins', sub, { channel: CHANNEL, messageId: seedMessageId }),
    ]) {
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.body)).not.toContain(seedText.slice(0, 30));
    }
    // Nothing pinned or unpinned on their behalf.
    expect((await socialChat().pinsStore.list(CHANNEL)).map((p) => p.messageId).sort()).toEqual(pinsBefore);
  });

  it('a member reads the pins (the positive control)', async () => {
    const r = await call('get', `/api/chat/pins?channel=${encodeURIComponent(CHANNEL)}`, 'u-theo');
    expect(r.status).toBe(200);
    expect((r.body.pins as Array<{ messageId: string }>).map((p) => p.messageId)).toContain(seedMessageId);
  });

  it.each(OUTSIDERS)('%s (%s) is refused every conversation command on the channel, and no run exists', async (sub) => {
    for (const [path, body] of COMMANDS) {
      const r = await call('post', path, sub, body);
      expect([path, r.status]).toEqual([path, sub === 'u-hr' ? 401 : 403]);
      expect(JSON.stringify(r.body)).not.toContain(seedText.slice(0, 30));
    }
    await Promise.all([...pendingSummaries]);
    expect(flowRunsFixture.rows()).toEqual([]);
  });

  it('a member starts every command on the channel (the positive control)', async () => {
    for (const [path, body] of COMMANDS) expect([path, (await call('post', path, 'u-theo', body)).status]).toEqual([path, 202]);
  });

  it('the tenant conversation commands refuse a Social channel for everyone, member or not', async () => {
    for (const path of TENANT_COMMANDS) {
      for (const sub of ['u-theo', 'u-nina', 'u-hr']) {
        const r = await call('post', path, sub, { channel: CHANNEL, text: '' });
        expect([path, sub, r.status]).toEqual([path, sub, 400]);
      }
    }
    expect(flowRunsFixture.rows()).toEqual([]);
  });

});
