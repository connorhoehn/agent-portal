// One conversation per initiative (portal pages/projects/initiativeDiscussionTarget.ts):
// an initiative bound to a Social channel discusses IN that channel, from a
// Work (orgiq) session. The page reads and writes it through the gateway with
// the session's own realtime token, so the server must hold three rules on
// every socket frame that page sends (chat join and history, send, typing,
// read receipts, reactions, presence):
//   1. a Work user who holds a Social grant but is not a member of the bound
//      channel reads nothing, subscribes to nothing and posts nothing;
//   2. a Work user with no Social grant at all gets nothing from the channel;
//   3. posting follows the channel's own rule (Social's PostMessage plus
//      membership), not the initiative thread's Work rule: a member whose
//      Social role cannot post is refused, a member who can, posts.
// Fixtures: Auth Migration (p-auth-migration) is bound to #auth-migration
// (mock/social-bindings.ts); Theo and Mia are members, Nina is not, Helen has
// no Social grant (providers/identity.ts seed).

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
// The seed's shape, plus a Social role that reads but cannot post, and a Work
// role that may write the initiative thread (DispatchAgentRun) but holds no
// Social grant: neither may decide a channel post.
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [
  { id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'reader', tenant: 'social', capabilities: ['ViewSocial'] },
  { id: 'member', tenant: 'orgiq', capabilities: ['Search', 'ViewWorkItems'] },
  { id: 'program-owner', tenant: 'orgiq', capabilities: ['Search', 'ViewWorkItems', 'DispatchAgentRun'] },
  { id: 'hr-admin', tenant: 'orgiq', capabilities: ['Search', 'ViewWorkItems', 'DispatchAgentRun'] },
] }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { attachRealtimeGateway, channelGuard, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { identityGrantWritesFixture } from '../../mock/identity-grants.js';
import { getUser } from '../../providers/identity.js';
import { getBinding } from '../../providers/social-bindings.js';

const SECRET = 'test-realtime-secret-initiative';
const CHANNEL = 'social:ch:auth-migration';
type Frame = Record<string, unknown> & { type?: string; action?: string; code?: string };
type Open = { ws: WebSocket; frames: Frame[]; user: string };

let server: http.Server;
let port: number;
let dispose: () => Promise<void>;
const prevSecret = process.env['REALTIME_JWT_SECRET'];
const sockets: WebSocket[] = [];

beforeAll(async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
  // Mia keeps her Work roles and her membership of #auth-migration, but her
  // Social role reads only.
  identityGrantWritesFixture.rows().push({ userId: 'u-mia', grants: { orgiq: ['program-owner', 'member'], social: ['reader'] } });
  server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  dispose = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0 }).dispose;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of sockets) ws.terminate();
  await dispose();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  socialChannelMembersFixture.reset();
  socialChannelMessagesFixture.reset();
  identityGrantWritesFixture.reset();
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

/** The token the initiative page holds: a Work session (tenant orgiq), whatever else the user is granted. */
async function workSession(sub: string): Promise<Session> {
  const user = await getUser(sub, { authoritative: true });
  if (!user) throw new Error(`no fixture user ${sub}`);
  return { sub, name: user.displayName, role: user.grants['orgiq']?.[0], tenant: 'orgiq', grants: user.grants,
    epoch: user.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
}

async function connectAs(sub: string): Promise<Open> {
  const { token } = await signRealtimeToken(realtimeClaims(await workSession(sub)), SECRET);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`refused ${res.statusCode}`)));
    ws.on('error', reject);
    ws.on('open', () => {
      const start = Date.now();
      const tick = setInterval(() => {
        if (frames.some((f) => f.type === 'session')) { clearInterval(tick); resolve({ ws, frames, user: sub }); }
        else if (Date.now() - start > 2_000) { clearInterval(tick); reject(new Error('no session frame')); }
      }, 10);
    });
  });
}

const out = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for a frame');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const errors = (o: Open) => o.frames.filter((f) => f.type === 'error');
const errorCode = (f: Frame) => String(f.code ?? (f['error'] as Frame | undefined)?.code ?? '');
async function refusal(o: Open, frame: Record<string, unknown>): Promise<string> {
  const before = errors(o).length;
  out(o, frame);
  await until(() => errors(o).length > before);
  return errorCode(errors(o).at(-1)!);
}
const REFUSED = /^(AUTHZ_CHANNEL_DENIED|not-a-member)$/;
/** Anything the channel's own content could arrive in: history, a live message, a reaction, a receipt, presence. */
const channelContent = (o: Open) => o.frames.filter((f) => f.type !== 'error' && f.type !== 'session'
  && JSON.stringify(f).includes(CHANNEL));
const chatMessages = (o: Open) => o.frames
  .filter((f) => f.type === 'chat' && f.action === 'message' && (f['message'] as { channel?: string } | undefined)?.channel === CHANNEL)
  .map((f) => f['message'] as { message: string; userId?: string; id?: string });
const stored = (text: string) => socialChannelMessagesFixture.rows().some((m) => m.channel === CHANNEL && m.message === text);

/** Every frame the initiative page's conversation sends on the channel. */
const PAGE_FRAMES: Array<Record<string, unknown>> = [
  { service: 'chat', action: 'join', channel: CHANNEL },
  { service: 'chat', action: 'history', channel: CHANNEL, limit: 50 },
  { service: 'chat', action: 'send', channel: CHANNEL, message: 'outsider post' },
  { service: 'chat', action: 'typing', channel: CHANNEL, typing: true },
  { service: 'chat', action: 'read', channel: CHANNEL, messageId: 'seed-auth-1', timestamp: new Date().toISOString() },
  { service: 'reaction', action: 'subscribe', channel: CHANNEL },
  { service: 'reaction', action: 'send', channel: CHANNEL, emoji: '🎉' },
  { service: 'presence', action: 'subscribe', channel: CHANNEL },
];

describe('the channel an initiative is bound to, from a Work session', () => {
  it('the fixture is the shape this suite assumes', async () => {
    expect((await getBinding({ tenant: 'orgiq', kind: 'initiative', id: 'p-auth-migration' }))?.channel).toBe(CHANNEL);
    const members = socialChannelMembersFixture.rows().filter((m) => m.channel === CHANNEL && !m.removedAt).map((m) => m.userId);
    expect(members).toEqual(expect.arrayContaining(['u-theo', 'u-mia']));
    expect(members).not.toContain('u-nina');
    expect(members).not.toContain('u-hr');
    expect((await getUser('u-nina', { authoritative: true }))?.grants['social']).toEqual(['participant']);
    expect((await getUser('u-hr', { authoritative: true }))?.grants['social']).toBeUndefined();
  });

  it('a Work user who is not a member gets no history, no subscription and no post, on every frame the page sends', async () => {
    const theo = await connectAs('u-theo');
    const nina = await connectAs('u-nina');
    out(theo, { service: 'chat', action: 'join', channel: CHANNEL });
    await until(() => theo.frames.some((f) => f.type === 'chat' && f.action === 'joined'));
    for (const frame of PAGE_FRAMES) expect([frame, await refusal(nina, frame)]).toEqual([frame, expect.stringMatching(REFUSED)]);
    // A member's live message does not reach her, and nothing she sent was stored or fanned out.
    out(theo, { service: 'chat', action: 'send', channel: CHANNEL, message: 'members only line' });
    await until(() => stored('members only line'));
    await new Promise((r) => setTimeout(r, 200));
    expect(channelContent(nina)).toEqual([]);
    expect(stored('outsider post')).toBe(false);
    expect(chatMessages(theo).some((m) => m.message === 'outsider post')).toBe(false);
    expect(channelGuard({ userId: 'u-nina', org: 'orgiq', tenants: ['orgiq', 'social'] } as never, CHANNEL)).toBe(false);
    theo.ws.close(); nina.ws.close();
  });

  it('a Work user with no Social grant gets nothing from the channel', async () => {
    const helen = await connectAs('u-hr');
    for (const frame of PAGE_FRAMES) expect([frame, await refusal(helen, frame)]).toEqual([frame, expect.stringMatching(REFUSED)]);
    expect(channelContent(helen)).toEqual([]);
    expect(stored('outsider post')).toBe(false);
    // Even a token claiming Social (the claim is not the grant): the live grant decides.
    expect(channelGuard({ userId: 'u-hr', org: 'orgiq', tenants: ['orgiq'] } as never, CHANNEL)).toBe(false);
    helen.ws.close();
  });

  it('posting follows the channel\'s own rule: a member who can only read is refused, a member who can post does', async () => {
    const theo = await connectAs('u-theo');
    const mia = await connectAs('u-mia');
    for (const o of [theo, mia]) out(o, { service: 'chat', action: 'join', channel: CHANNEL });
    // Mia reads the channel (her Social role views) ...
    await until(() => mia.frames.some((f) => f.type === 'chat' && f.action === 'joined' && f['channel'] === CHANNEL));
    out(mia, { service: 'chat', action: 'history', channel: CHANNEL, limit: 20 });
    await until(() => mia.frames.some((f) => f.type === 'chat' && f.action === 'history'));
    // ... but cannot post, although her Work role may write the initiative thread.
    expect(await refusal(mia, { service: 'chat', action: 'send', channel: CHANNEL, message: 'reader post' })).toBe('AUTHZ_CHANNEL_DENIED');
    expect(stored('reader post')).toBe(false);
    // Theo's Work role holds no initiative-thread write, but Social lets him post here.
    out(theo, { service: 'chat', action: 'send', channel: CHANNEL, message: 'member post' });
    await until(() => chatMessages(mia).some((m) => m.message === 'member post'));
    expect(stored('member post')).toBe(true);
    expect(errors(theo)).toEqual([]);
    theo.ws.close(); mia.ws.close();
  });
});
