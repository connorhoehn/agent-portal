// Opt in with BOTH CALL_CHAT_TEST_DYNAMODB_ENDPOINT and
// CALL_CHAT_TEST_REDIS_URL. Real SDK requests and Redis Lua are required;
// configured-but-unreachable stores fail rather than silently skip. Huddle
// messages are ordinary gateway chat stored by the library's DynamoChatStore
// on `orgiq:huddle:<callId>`; this suite checks the membership mirror and the
// resolver over those real stores: join boundaries survive a cold runtime,
// late joiners and reused call ids never read older rows, revoked actors and
// ended calls are refused. Identity fixtures and the transport handle are
// controlled here. No media is exercised.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import { randomBytes } from 'node:crypto';
import { DynamoDBClient, DescribeTableCommand, QueryCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { RedisCallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import { LocalRealtimeRouter } from '@connorhoehnslalom/realtime-modules/server';
import { DynamoChatStore } from '@connorhoehnslalom/realtime-modules/server/stores/dynamo';
import { RedisLite } from '../redis-lite.js';
import { CallChatRuntime, callChatChannel } from '../call-chat.js';
import { RedisCallChatStateStore } from '../call-chat-state.js';
import { observeCallPageLifecycle } from '../call-pages.js';
import { AppError } from '../async-handler.js';
import type { Session } from '../session.js';

// The default SDK HTTP handler's dynamic import does not work in Jest's VM;
// the SDK's fetch transport still executes real DynamoDB HTTP requests.
const { FetchHttpHandler } = require('@smithy/fetch-http-handler');
const endpoint = process.env['CALL_CHAT_TEST_DYNAMODB_ENDPOINT'];
const redisUrl = process.env['CALL_CHAT_TEST_REDIS_URL'];
if (!!endpoint !== !!redisUrl) throw new Error('Durable huddle integration requires BOTH real DynamoDB and Redis endpoints');
const suite = endpoint && redisUrl ? describe : describe.skip;
const prefix = 'orgiq-chat-';
const table = `${prefix}chat-messages`;
const loopback = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

type Bundle = ReturnType<typeof bundle>;
let callId: string, lobby: string, clock: number;
let sessions: Record<'alice' | 'bob' | 'charlie', Session>;
let bundles: Bundle[];
let identities: Map<string, Session>;
let allClientIds: Set<string>;

function dynamo() {
  return new DynamoDBClient({ endpoint, region: 'us-east-1', maxAttempts: 2,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, requestHandler: new FetchHttpHandler({ requestTimeout: 5000 }) });
}
function bundle(generation: string) {
  const redis = new RedisLite(redisUrl!, { commandTimeoutMs: 5000 });
  const calls = new RedisCallStateStore(redis);
  const client = dynamo();
  const messages = new DynamoChatStore({ client, tablePrefix: prefix });
  const state = new RedisCallChatStateStore(redis);
  const contexts = new Map<string, Record<string, unknown>>();
  let seatIndex = 0;
  const router = new LocalRealtimeRouter();
  router._setHandle({
    wss: null, dispose: async () => {}, listClients: () => [...contexts.keys()],
    getClientContext: id => contexts.get(id) ?? null,
    sendToClient: id => contexts.has(id),
  });
  const runtime = new CallChatRuntime({ calls, messages, state, router, maintenanceIntervalMs: 0, now: () => clock,
    lobbyAllowed: (auth, name) => name === lobby && name.split(':').includes(String(auth.userId)),
    authority: async session => {
      const current = identities.get(session.sub);
      if (session.tenant !== 'orgiq' || !current || current.epoch !== session.epoch || current.role !== session.role) throw new AppError(401, 'Session revoked');
      return { displayName: `${session.sub} Directory`, grants: current.grants };
    },
    grant: async (_session, authority, action) => authority.grants.social?.includes('participant') === true
      && ['ViewSocial', 'PostMessage'].includes(action),
  });
  const observed = observeCallPageLifecycle(calls, () => null, () => runtime);
  const connect = (person: keyof typeof sessions) => {
    const session = sessions[person]; const id = `${generation}-${++seatIndex}-${session.sub}`; allClientIds.add(id);
    contexts.set(id, { userId: session.sub, org: session.tenant, role: session.role, epoch: session.epoch,
      displayName: 'Untrusted socket display name', sessionIat: session.iat });
    return id;
  };
  return { redis, calls, observed, client, messages, state, contexts, router, runtime, connect };
}
async function register(b: Bundle, person: keyof typeof sessions) {
  const id = b.connect(person);
  await b.observed.registerParticipant(callId, id, sessions.alice.sub, lobby, [sessions.bob.sub, sessions.charlie.sub]);
  await b.calls.registerUserCall(sessions[person].sub, callId, 14400);
  return id;
}
/** What the chat service stores for a send: the library's own record on the call's channel. */
async function say(b: Bundle, person: keyof typeof sessions, text: string) {
  clock += 1000;
  const message = { id: `m-${clock}-${randomBytes(3).toString('hex')}`, clientId: `${person}-seat`, userId: sessions[person].sub,
    channel: callChatChannel(callId), message: text, timestamp: new Date(clock).toISOString(),
    metadata: { displayName: `${sessions[person].sub} Directory`, clientDeliveryId: `d-${clock}` } };
  await b.messages.putMessage(message);
  clock += 1000;
  return message;
}
async function restart(previous: Bundle, people: Array<keyof typeof sessions>) {
  previous.runtime.dispose(); previous.contexts.clear();
  const fresh = bundle(`fresh-${bundles.length}`); bundles.push(fresh);
  // A cold router recognizes only the new connection IDs. Resume must use
  // existing Redis seats and keep the members' boundaries.
  const old = (await fresh.calls.getCall(callId))!.participantClientIds;
  for (const [index, person] of people.entries()) {
    const id = fresh.connect(person);
    expect(await fresh.observed.resumeParticipant!(callId, id, sessions[person].sub, lobby, index === 0 ? old : [])).toBe(true);
  }
  return fresh;
}
const ids = (result: { messages: Array<{ id: string }> }) => result.messages.map(message => message.id);

suite('durable huddle membership over real Redis and DynamoDB Local', () => {
  beforeAll(async () => {
    if (new URL(endpoint!).protocol !== 'http:' || !loopback.has(new URL(endpoint!).hostname)
      || new URL(redisUrl!).protocol !== 'redis:' || !loopback.has(new URL(redisUrl!).hostname)) throw new Error('Durable huddle tests require explicit loopback stores');
    const client = dynamo(); const redis = new RedisLite(redisUrl!);
    try {
      expect(await redis.command('PING')).toBe('PONG');
      expect((await client.send(new DescribeTableCommand({ TableName: table }))).Table?.TableStatus).toBe('ACTIVE');
    } finally { client.destroy(); await redis.quit(); }
  }, 15000);

  beforeEach(async () => {
    const tag = `${Date.now()}-${randomBytes(6).toString('hex')}`;
    callId = `chat-durable-${tag}`; clock = Date.parse('2026-10-06T12:00:00.000Z');
    const person = (name: string): Session => ({
      sub: `durable-${tag}-${name}`, name: 'Untrusted cookie display name', tenant: 'orgiq', role: 'member', epoch: 0,
      grants: { orgiq: ['member'], social: ['participant'] }, iat: 100,
    });
    sessions = { alice: person('alice'), bob: person('bob'), charlie: person('charlie') };
    lobby = `orgiq:dm:${Object.values(sessions).map(session => session.sub).sort().join(':')}`;
    identities = new Map(Object.values(sessions).map(session => [session.sub, structuredClone(session)]));
    allClientIds = new Set(); bundles = [];
    const first = bundle('old'); bundles.push(first);
    await register(first, 'alice'); await register(first, 'bob');
    await first.calls.registerLobbyCall(lobby, callId, 14400); await first.calls.markAccepted(callId, 14400);
  });

  afterEach(async () => {
    for (const b of bundles ?? []) b.runtime.dispose();
    if (!bundles?.length) return;
    const b = bundles.at(-1)!;
    // Delete only this test's channel rows and exact Redis keys.
    try {
      const rows = await b.client.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'channelId = :ch',
        ExpressionAttributeValues: { ':ch': { S: callChatChannel(callId) } }, ConsistentRead: true }));
      await Promise.all((rows.Items ?? []).map(item => b.client.send(new DeleteItemCommand({ TableName: table,
        Key: { channelId: item.channelId!, messageId: item.messageId! } }))));
      await b.redis.del(`orgiq:call-chat:${encodeURIComponent(callId)}`,
        `call:active:${callId}`, `call:active:${callId}:participants`, `call:accepted:${callId}`, `call:lobby:${lobby}`,
        ...[...allClientIds].map(id => `client:calls:${id}`), ...Object.values(sessions).map(session => `call:user:${session.sub}`));
    } finally { await Promise.allSettled(bundles.map(async value => { value.client.destroy(); await value.redis.quit(); })); }
  }, 15000);

  it('replays the newest stored messages after a cold resume with each member\'s original boundary', async () => {
    const first = bundles[0]!; const sent = [];
    for (let index = 1; index <= 60; index++) sent.push(await say(first, index % 2 ? 'alice' : 'bob', `message-${index}`));
    expect(ids(await first.runtime.get(callId, sessions.bob, 50))).toEqual(sent.slice(-50).map(message => message.id));
    const fresh = await restart(first, ['alice', 'bob']);
    const replay = await fresh.runtime.get(callId, sessions.bob, 50);
    expect(ids(replay)).toEqual(sent.slice(-50).map(message => message.id));
    expect(replay.historyFrom).toBe((await first.state.get(callId)).members[sessions.bob.sub]?.historyFrom);
  }, 30000);

  it('a late joiner reads only later messages; leaving refuses reads and an explicit rejoin advances the boundary', async () => {
    const first = bundles[0]!;
    const early = await say(first, 'alice', 'Before Charlie joined');
    await expect(first.runtime.get(callId, sessions.charlie)).rejects.toMatchObject({ status: 403 });
    const charlie = await register(first, 'charlie');
    expect(ids(await first.runtime.get(callId, sessions.charlie))).toEqual([]);
    const joined = await say(first, 'alice', 'After Charlie joined');
    expect(ids(await first.runtime.get(callId, sessions.charlie))).toEqual([joined.id]);
    first.runtime.invalidate(callId, charlie);
    await first.observed.removeParticipant(callId, charlie); first.contexts.delete(charlie);
    await expect(first.runtime.get(callId, sessions.charlie)).rejects.toMatchObject({ status: 403 });
    await say(first, 'alice', 'While Charlie absent');
    await register(first, 'charlie');
    const rejoined = await say(first, 'alice', 'After explicit rejoin');
    const after = await first.runtime.get(callId, sessions.charlie);
    expect(ids(after)).toEqual([rejoined.id]);
    expect(after.messages.some(message => message.id === early.id)).toBe(false);
  }, 20000);

  it('rejects revoked or mismatched actors and keeps terminal history inaccessible to fresh runtimes', async () => {
    const first = bundles[0]!;
    await say(first, 'alice', 'Protected');
    await expect(first.runtime.get(callId, { ...sessions.bob, epoch: 1 })).rejects.toMatchObject({ status: 401 });
    identities.get(sessions.bob.sub)!.grants.social = [];
    await expect(first.runtime.get(callId, sessions.bob)).rejects.toMatchObject({ status: 403 });
    await first.observed.forgetCall(callId);
    const fresh = bundle('terminal'); bundles.push(fresh); fresh.connect('alice');
    expect((await fresh.state.get(callId)).ended).toBe(true);
    await expect(fresh.runtime.get(callId, sessions.alice)).rejects.toMatchObject({ status: 404 });
    expect(await fresh.runtime.memberRows(callId)).toEqual([expect.objectContaining({ userId: '', removedAt: expect.any(String) })]);
  }, 20000);

  it('a reused call id after state expiry never exposes the retained transcript', async () => {
    const first = bundles[0]!;
    for (let index = 1; index <= 3; index++) await say(first, 'alice', `Old private history ${index}`);
    await first.redis.del(`orgiq:call-chat:${encodeURIComponent(callId)}`, `call:active:${callId}`, `call:active:${callId}:participants`);
    first.runtime.dispose();
    const fresh = bundle('reused'); bundles.push(fresh);
    clock += 60_000;
    await register(fresh, 'charlie'); await register(fresh, 'bob');
    expect(ids(await fresh.runtime.get(callId, sessions.charlie))).toEqual([]);
    expect(ids(await fresh.runtime.get(callId, sessions.bob))).toEqual([]);
    const next = await say(fresh, 'charlie', 'New call');
    expect(ids(await fresh.runtime.get(callId, sessions.bob))).toEqual([next.id]);
  }, 20000);
});
