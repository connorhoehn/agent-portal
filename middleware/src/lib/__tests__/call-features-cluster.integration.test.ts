// Opt-in application call-feature contracts over two native WS servers,
// shared Redis state and DynamoDB Local. Identity/resource authority is an
// explicit fixture; this does not accept a provisioned directory or full BFF.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' },
  cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createClient, type RedisClientType } from 'redis';
import { DynamoDBClient, DescribeTableCommand, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { attachRealtime, chat as chatFeature, RedisRealtimeRouter, type RealtimeHandle } from '@connorhoehn/realtime-modules/server';
import { MemoryChatMembershipStore } from '@connorhoehn/realtime-modules/chat';
import { RedisCallStateStore } from '@connorhoehn/realtime-modules/call';
import { DynamoChatStore } from '@connorhoehn/realtime-modules/server/stores/dynamo';
import { openRedisStore, type GatewayRedisStore } from '../redis-store.js';
import { CallPageRuntime, RedisCallPageStore, observeCallPageLifecycle, type CanonicalCallPage } from '../call-pages.js';
import { CallChatRuntime, callChatChannel, huddleMembershipStore } from '../call-chat.js';
import { withHuddleChat } from '../call-chat-send.js';
import { huddleCallId } from '../live-principal.js';
import { RedisCallChatStateStore } from '../call-chat-state.js';
import { callContextSession, resolveConnectedCallSession } from '../call-access.js';
import { AppError } from '../async-handler.js';
import type { Session } from '../session.js';

const { FetchHttpHandler } = require('@smithy/fetch-http-handler');
const redisUrl = process.env['CALL_FEATURE_CLUSTER_REDIS_URL'];
const endpoint = process.env['CALL_FEATURE_CLUSTER_DYNAMODB_ENDPOINT'];
if (!!redisUrl !== !!endpoint) throw new Error('Cluster call features require BOTH dedicated local store endpoints');
const suite = redisUrl && endpoint ? describe : describe.skip;
const table = 'orgiq-chat-chat-messages';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function eventually(predicate: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Cluster call feature condition timed out');
}
type Client = { ws: WebSocket; id: string; frames: any[] };
type Node = { router: RedisRealtimeRouter; handle: RealtimeHandle; server: http.Server; url: string;
  command: RedisClientType; subscriber: RedisClientType; redis: GatewayRedisStore; db: DynamoDBClient;
  calls: RedisCallStateStore; observed: ReturnType<typeof observeCallPageLifecycle>;
  pages: CallPageRuntime; chat: CallChatRuntime; state: RedisCallChatStateStore; directory: { available: boolean } };

suite('call pages and huddle chat across native gateway nodes', () => {
  let namespace: string, callId: string, lobby: string;
  let sessions: Record<'alice' | 'bob', Session>;
  let identities: Map<string, Session>;
  let nodes: Node[], clients: Client[], storageChannels: Set<string>;
  let held: { recipient: string; entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null;
  const authority = async (session: Session) => {
    const current = identities.get(session.sub);
    if (!current || current.epoch !== session.epoch || current.role !== session.role || session.tenant !== 'orgiq') {
      throw new AppError(401, 'Session revoked');
    }
    return { displayName: `${session.sub} Directory`, grants: current.grants };
  };
  const canonical = async (descriptor: { kind: 'initiative' | 'work-item'; id: string }): Promise<CanonicalCallPage> => ({
    kind: descriptor.kind, id: descriptor.id, title: 'Canonical initiative', href: '/projects/p-one',
    project: { id: 'p-one', title: 'Canonical initiative', href: '/projects/p-one' }, breadcrumbs: [],
  });
  async function boot(nodeId: string): Promise<Node> {
    const command = createClient({ url: redisUrl!, disableOfflineQueue: true, socket: { reconnectStrategy: false } });
    command.on('error', () => undefined);
    const subscriber = command.duplicate(); subscriber.on('error', () => undefined);
    let chat!: CallChatRuntime;
    await Promise.all([command.connect(), subscriber.connect()]);
    const redis = await openRedisStore(redisUrl!, { timeoutMs: 5000 });
    const calls = new RedisCallStateStore(redis);
    const db = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
      requestHandler: new FetchHttpHandler({ requestTimeout: 5000 }), maxAttempts: 2 });
    const messages = new DynamoChatStore({ client: db, tablePrefix: 'orgiq-chat-' });
    const state = new RedisCallChatStateStore(redis);
    const directory = { available: true };
    const router = new RedisRealtimeRouter({ namespace, nodeId, leaseMs: 10000, requestTimeoutMs: 3000,
      redis: { command: async (...args) => {
        if (!directory.available && args[0] === 'GET') throw new Error('Fixture directory transport unavailable');
        return command.sendCommand(args);
      }, publish: (topic, payload) => command.publish(topic, payload),
        subscribe: async (topic, receive) => { await subscriber.subscribe(topic, receive); return () => subscriber.unsubscribe(topic); } },
      // Huddle chat asks the seat authority the gateway asks (live-principal's
      // authorizeHuddleChannel); other names keep this fixture's partition rule.
      authorize: async ({ ctx, channel, clientId, kind }) => {
        if (!ctx || ctx.org !== 'orgiq' || !channel.startsWith('orgiq:')) return false;
        const id = huddleCallId(channel);
        if (!channel.startsWith('orgiq:huddle')) return true;
        try { await chat.assertSeat(id!, clientId, kind === 'publish'); return !!id; } catch { return false; }
      },
      filterClientMessage: async ({ ctx, message }) => {
        const captured = held;
        if (captured && captured.recipient === ctx?.userId && (message as any)?.action === 'message') {
          captured.entered.resolve(); await captured.release.promise;
        }
        const session = callContextSession(ctx ?? undefined); if (!session) return null;
        try { await authority(session); return message; } catch { return null; }
      },
    });
    await router.start();
    const common = { calls, router, authority, lobbyAllowed: (auth: Record<string, unknown>, name: string) =>
      name === lobby && name.split(':').includes(String(auth.userId)), maintenanceIntervalMs: 0 };
    const pages = new CallPageRuntime({ ...common, pages: new RedisCallPageStore(redis), canonical });
    chat = new CallChatRuntime({ ...common, messages, state, canonical,
      grant: async (_session, current) => current.grants.social?.includes('participant') === true });
    const observed = observeCallPageLifecycle(calls, () => pages, () => chat);
    const server = http.createServer((_req, res) => res.end('existing route'));
    const runtime = chat;
    const handle = attachRealtime(server, { router, path: '/ws', pingIntervalMs: 0,
      features: [withHuddleChat(chatFeature({ chatStore: messages, maxChannelNameLength: 256,
        membershipStore: huddleMembershipStore(new MemoryChatMembershipStore(), () => runtime) }), () => runtime)],
      auth: req => {
        const current = identities.get(String(req.headers['x-test-credential'] ?? ''));
        if (!current) throw new Error('Unauthenticated');
        return { userId: current.sub, org: current.tenant, role: current.role, epoch: current.epoch, sessionIat: current.iat };
      },
      onDisconnect: async id => {
        if ((await calls.getCall(callId))?.participantClientIds.includes(id)) await observed.removeParticipant(callId, id);
      },
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Expected native TCP server');
    const node = { router, handle, server, url: `ws://127.0.0.1:${address.port}/ws`, command, subscriber, redis, db, calls, observed, pages, chat, state, directory };
    nodes.push(node); return node;
  }
  async function connect(node: Node, person: keyof typeof sessions) {
    const frames: any[] = [];
    const ws = new WebSocket(node.url, { headers: { 'x-test-credential': sessions[person].sub } });
    ws.on('error', () => undefined);
    ws.on('message', raw => frames.push(JSON.parse(String(raw))));
    await eventually(() => frames.some(frame => frame.type === 'session'));
    const client = { ws, frames, id: frames.find(frame => frame.type === 'session').clientId as string };
    clients.push(client); return client;
  }
  async function rememberStorage() { storageChannels.add(callChatChannel(callId)); }
  /** Join the call's chat on this socket and send one message with a delivery id. */
  function send(client: Client, text: string, clientDeliveryId: string) {
    client.ws.send(JSON.stringify({ service: 'chat', action: 'send', channel: callChatChannel(callId), message: text, metadata: { clientDeliveryId } }));
  }
  async function join(client: Client) {
    client.ws.send(JSON.stringify({ service: 'chat', action: 'join', channel: callChatChannel(callId) }));
    await eventually(() => client.frames.some(frame => frame.type === 'chat' && frame.action === 'joined' && frame.channel === callChatChannel(callId)));
  }
  const acked = (client: Client) => client.frames.filter(frame => frame.type === 'chat' && frame.action === 'sent').map(frame => frame.messageId as string);
  beforeAll(() => {
    const loopback = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
    if (new URL(redisUrl!).protocol !== 'redis:' || !loopback.has(new URL(redisUrl!).hostname)
      || new URL(endpoint!).protocol !== 'http:' || !loopback.has(new URL(endpoint!).hostname)) throw new Error('Explicit loopback stores required');
  });
  beforeEach(async () => {
    namespace = `root-call-features-${randomUUID()}`; callId = randomUUID();
    const person = (name: string): Session => ({ sub: `${namespace}-${name}`, tenant: 'orgiq', role: 'member', epoch: 0,
      grants: { orgiq: ['member'], social: ['participant'] }, iat: 100 });
    sessions = { alice: person('alice'), bob: person('bob') };
    identities = new Map(Object.values(sessions).map(session => [session.sub, structuredClone(session)]));
    lobby = `orgiq:dm:${sessions.alice.sub}:${sessions.bob.sub}`;
    nodes = []; clients = []; storageChannels = new Set(); held = null;
    const a = await boot('a'), b = await boot('b');
    expect((await a.db.send(new DescribeTableCommand({ TableName: table }))).Table?.TableStatus).toBe('ACTIVE');
    const alice = await connect(a, 'alice'), bob = await connect(b, 'bob');
    await a.observed.registerParticipant(callId, alice.id, sessions.alice.sub, lobby, [sessions.bob.sub]);
    await b.observed.registerParticipant(callId, bob.id, sessions.alice.sub, lobby, [sessions.alice.sub]);
    await a.calls.markAccepted(callId, 14400);
    await rememberStorage();
  }, 15000);
  afterEach(async () => {
    held?.release.resolve();
    for (const node of nodes ?? []) node.directory.available = true;
    for (const client of clients ?? []) client.ws.terminate();
    for (const node of nodes ?? []) {
      await node.handle.dispose(); node.pages.dispose(); node.chat.dispose();
      await new Promise<void>(resolve => node.server.close(() => resolve()));
    }
    const owner = nodes?.[0];
    try {
      if (owner) {
        for (const channel of storageChannels) {
          const rows = await owner.db.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'channelId = :ch',
            ExpressionAttributeValues: { ':ch': { S: channel } }, ConsistentRead: true }));
          await Promise.all((rows.Items ?? []).map(item => owner.db.send(new DeleteItemCommand({ TableName: table,
            Key: { channelId: item.channelId!, messageId: item.messageId! } }))));
        }
        const key = `orgiq:call-chat:${encodeURIComponent(callId)}`;
        await owner.redis.del(key, `orgiq:call-page:${encodeURIComponent(callId)}`,
          `call:active:${callId}`, `call:active:${callId}:participants`, `call:accepted:${callId}`, `call:lobby:${lobby}`,
          ...clients.map(client => `client:calls:${client.id}`), ...Object.values(sessions).map(session => `call:user:${session.sub}`));
      }
    } finally {
      await Promise.allSettled((nodes ?? []).map(async node => {
        node.db.destroy(); await node.redis.quit();
        if (node.command.isOpen) node.command.destroy(); if (node.subscriber.isOpen) node.subscriber.destroy();
      }));
    }
  }, 15000);

  it('reads remote seats and delivers a canonical pinned page to the other gateway', async () => {
    const [a, b] = nodes as [Node, Node], [alice, bob] = clients as [Client, Client];
    expect(a.router.isClientLive(bob.id)).toBeNull();
    expect((await resolveConnectedCallSession(a.router, bob.id))?.sub).toBe(sessions.bob.sub);
    const pinned = await a.pages.put(callId, sessions.alice, 0, { kind: 'initiative', id: 'p-one' });
    await eventually(() => bob.frames.some(frame => frame.type === 'call-page' && frame.revision === 1));
    expect(bob.frames.find(frame => frame.type === 'call-page' && frame.revision === 1)).toEqual(pinned);
    expect(await b.pages.get(callId, sessions.alice)).toEqual(pinned);
    expect(await a.pages.get(callId, sessions.bob)).toEqual(pinned);
    await b.pages.clear(callId, sessions.alice, 1);
    await eventually(() => alice.frames.some(frame => frame.type === 'call-page' && frame.revision === 2 && frame.page === null));
  });

  it('delivers huddle chat across gateways and answers a retried delivery id with the original message', async () => {
    const [a, b] = nodes as [Node, Node], [alice, bob] = clients as [Client, Client];
    await join(alice); await join(bob);
    send(alice, 'Across the gateway', 'native-one');
    await eventually(() => acked(alice).length === 1);
    const first = acked(alice)[0]!;
    await eventually(() => bob.frames.some(frame => frame.action === 'message' && frame.message?.id === first));
    send(alice, 'Across the gateway', 'native-one');
    await eventually(() => acked(alice).length === 2);
    expect(acked(alice)).toEqual([first, first]);
    send(bob, 'Reply on the other gateway', 'native-two');
    await eventually(() => acked(bob).length === 1);
    await eventually(async () => (await b.chat.get(callId, sessions.alice, 50)).messages.length === 2);
    expect((await a.chat.get(callId, sessions.bob, 50)).messages.map(message => message.id)).toEqual([first, acked(bob)[0]]);
  });

  it('fences a remote recipient revoked during an awaited socket delivery and denies stale REST readers', async () => {
    const [a, b] = nodes as [Node, Node], [alice] = clients as [Client, Client];
    held = { recipient: sessions.alice.sub, entered: deferred(), release: deferred() };
    const [, bob] = clients as [Client, Client];
    await join(alice); await join(bob);
    send(bob, 'Revocation boundary', 'native-revoked');
    await held.entered.promise;
    identities.set(sessions.alice.sub, { ...sessions.alice, epoch: 1 });
    held.release.resolve(); await eventually(() => acked(bob).length === 1);
    expect(alice.frames.filter(frame => frame.action === 'message' && frame.message?.message === 'Revocation boundary')).toEqual([]);
    await expect(b.pages.get(callId, sessions.alice)).rejects.toMatchObject({ status: 401 });
    await expect(a.chat.get(callId, sessions.alice, 50)).rejects.toMatchObject({ status: 401 });
    alice.ws.terminate();
    await eventually(async () => await b.router.resolveClientData(alice.id) === null);
    expect(await resolveConnectedCallSession(b.router, alice.id)).toBeNull();
  });

  it('keeps shared pages and history floors intact while the connection directory is unavailable', async () => {
    const [a, b] = nodes as [Node, Node];
    const pinned = await a.pages.put(callId, sessions.alice, 0, { kind: 'initiative', id: 'p-one' });
    const before = await b.state.get(callId);
    b.directory.available = false;
    await expect(b.pages.get(callId, sessions.alice)).rejects.toMatchObject({ status: 503 });
    await expect(b.chat.get(callId, sessions.bob, 50)).rejects.toMatchObject({ status: 503 });
    expect(await b.state.get(callId)).toEqual(before);
    b.directory.available = true;
    expect(await b.pages.get(callId, sessions.bob)).toEqual(pinned);
    expect((await b.chat.get(callId, sessions.alice, 50)).participants).toHaveLength(2);
  });
});
