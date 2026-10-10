// Full, separately running BFFs: real cookie/JWT login, native WebSockets,
// Redis and DynamoDB Local, and provider SQL through native-rds-preload.mjs.
// No route, identity-provider, call or socket receipt is mocked by this test.
// This remains local transport acceptance, not Aurora/IAM/cloud acceptance.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import pg from 'pg';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoChatStore } from '@connorhoehnslalom/realtime-modules/server/stores/dynamo';
import { RedisNotificationStore } from '@connorhoehnslalom/realtime-modules/notification';
import { createClient } from 'redis';

if (process.env.ORGIQ_BFF_CLUSTER_ACCEPTANCE !== '1' && process.env.ORGIQ_BFF_REDIS_FAILURE_ACCEPTANCE !== '1'
  && process.env.ORGIQ_BFF_DYNAMO_FAILURE_ACCEPTANCE !== '1') throw new Error('Opt in to a dedicated full-BFF acceptance profile');
const bases = ['http://127.0.0.1:3063', 'http://127.0.0.1:3064'];
const db = new pg.Pool({ connectionString: 'postgresql://orgiq:local-cluster-fixture@127.0.0.1:15483/orgiq', max: 2 });
const ddb = new DynamoDBClient({ endpoint: 'http://127.0.0.1:18063', region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
const durable = new DynamoChatStore({ client: ddb, tablePrefix: 'orgiq-bff-cluster-' });
const inboxRedis = createClient({ url: 'redis://127.0.0.1:16483' });
inboxRedis.on('error', error => console.warn('[native-inbox-fixture]', error.name));
await inboxRedis.connect();
const inbox = new RedisNotificationStore({ redisClient: inboxRedis,
  logger: { info() {}, debug() {}, warn() {}, error() { throw new Error('Native inbox transport failed'); } } });
const clients = new Set();
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await pause(20); }
  throw new Error(`Timed out: ${label}`);
}
function updateCookies(principal, response) {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(';')[0], at = pair.indexOf('=');
    principal.jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
}
async function request(principal, path, method = 'GET', body, base = principal.base) {
  const response = await fetch(base + path, { method, headers: {
    cookie: [...principal.jar].map(([key, value]) => `${key}=${value}`).join('; '),
    ...(body ? { 'content-type': 'application/json' } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  updateCookies(principal, response);
  return { status: response.status, body: await response.json() };
}
async function login(node, userId, tenant = 'orgiq') {
  const principal = { base: bases[node], userId, jar: new Map() };
  const logged = await request(principal, '/api/session/login', 'POST', { userId });
  assert.equal(logged.status, 200, 'actual picker login');
  if (tenant !== 'orgiq') assert.equal((await request(principal, '/api/session/tenant', 'POST', { tenant })).status, 200);
  const token = await request(principal, '/api/session/realtime-token');
  assert.equal(token.status, 200);
  const claims = JSON.parse(Buffer.from(token.body.token.split('.')[1], 'base64url').toString());
  assert.equal(claims.sub, userId, 'cookie clear/issue selects the minted principal');
  assert.equal(claims.org, tenant);
  return { ...principal, token: token.body.token };
}
async function connect(principal) {
  const frames = [], ws = new WebSocket(principal.base.replace('http:', 'ws:') + '/ws', ['bearer-token-v1', principal.token]);
  ws.on('error', () => {});
  ws.on('message', raw => { frames.push(JSON.parse(String(raw))); });
  const client = { ...principal, ws, frames };
  clients.add(client);
  await until(() => frames.some(frame => frame.type === 'session'), 'authenticated WS session');
  client.id = frames.find(frame => frame.type === 'session').clientId;
  return client;
}
function send(client, frame) { client.ws.send(JSON.stringify(frame)); }
async function call(alice, bob, lobbyName = 'orgiq:initiative:cluster-project') {
  const callId = randomUUID();
  send(alice, { service: 'call', action: 'invite', callId, lobbyName, callerId: alice.userId, targetUserIds: [bob.userId] });
  await until(() => bob.frames.some(frame => frame.action === 'invite' && frame.data?.callId === callId), 'peer invite');
  send(bob, { service: 'call', action: 'accepted', callId, lobbyName, callerId: bob.userId, targetUserIds: [alice.userId] });
  await until(() => alice.frames.some(frame => frame.action === 'accepted' && frame.data?.callId === callId), 'peer accept');
  await until(async () => (await request(alice, `/api/calls/${callId}/chat`)).body.participants?.length === 2, 'shared durable seats');
  return callId;
}
// Huddle chat travels the gateway socket exactly as the portal's HuddleChat
// sends it (useChat over `orgiq:huddle:<callId>`, seat-only): join, then a send
// frame carrying a delivery id, accepted only on the library's persisted `sent`.
const huddleChannel = callId => `orgiq:huddle:${callId}`;
const huddleRefusal = (frame, channel) => frame.type === 'error' && (frame.channel === channel || (frame.service === 'chat' && frame.channel === undefined));
async function joinHuddle(client, callId) {
  const channel = huddleChannel(callId), start = client.frames.length;
  send(client, { service: 'chat', action: 'join', channel });
  await until(() => {
    const later = client.frames.slice(start), refused = later.find(frame => huddleRefusal(frame, channel));
    if (refused) throw new Error(`huddle join refused: ${refused.code ?? refused.error?.code ?? ''} ${refused.error?.message ?? refused.message ?? ''}`);
    return later.some(frame => frame.type === 'chat' && frame.action === 'joined' && frame.channel === channel);
  }, 'huddle chat join');
}
async function sendHuddle(client, callId, text) {
  const channel = huddleChannel(callId), deliveryId = randomUUID(), start = client.frames.length;
  send(client, { service: 'chat', action: 'send', channel, message: text, metadata: { displayName: client.userId, clientDeliveryId: deliveryId } });
  let message;
  await until(() => {
    const later = client.frames.slice(start), refused = later.find(frame => huddleRefusal(frame, channel));
    if (refused) throw new Error(`huddle send refused: ${refused.code ?? refused.error?.code ?? ''} ${refused.error?.message ?? refused.message ?? ''}`);
    message = later.find(frame => frame.type === 'chat' && frame.action === 'message' && frame.channel === channel
      && frame.message?.metadata?.clientDeliveryId === deliveryId)?.message;
    return !!message && later.some(frame => frame.type === 'chat' && frame.action === 'sent' && frame.channel === channel && frame.messageId === message.id);
  }, 'persisted huddle acknowledgement');
  return message;
}
const receivedHuddle = (client, id) => client.frames.some(frame => frame.type === 'chat' && frame.action === 'message' && frame.message?.id === id);
function close(...peers) { for (const peer of peers) { peer.ws.terminate(); clients.delete(peer); } }
async function upgradeStatus(principal, node = 1) {
  const ws = new WebSocket(bases[node].replace('http:', 'ws:') + '/ws', ['bearer-token-v1', principal.token]);
  let deadline;
  const status = new Promise(resolve => {
    ws.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    ws.on('open', () => resolve(101)); ws.on('error', () => {});
  });
  try { return await Promise.race([status, new Promise(resolve => { deadline = setTimeout(() => resolve('timeout'), 6000); })]); }
  finally { clearTimeout(deadline); ws.terminate(); }
}
async function seedUser(id, roles) {
  await db.query('INSERT INTO app_users (id,display_name) VALUES ($1,$2) ON CONFLICT (id) DO NOTHING', [id, id]);
  for (const [tenant, role] of roles) await db.query('INSERT INTO user_tenant_roles (user_id,tenant_id,role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, tenant, role]);
}
after(async () => { close(...clients); await db.end(); ddb.destroy(); inboxRedis.destroy(); });
await until(async () => (await Promise.all(bases.map(async base => {
  try { return (await fetch(base + '/api/session/me')).status === 200; } catch { return false; }
}))).every(Boolean), 'both full BFF listeners ready', 10000);

export { bases, db, durable, inbox, clients, pause, until, request, login, connect, send, call, close, upgradeStatus, seedUser, execute,
  huddleChannel, joinHuddle, sendHuddle, receivedHuddle };
