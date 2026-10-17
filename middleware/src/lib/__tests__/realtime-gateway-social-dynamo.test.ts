// The gateway's chat store when DynamoDB is configured (docs/social-tenant-design.md
// §4.4): `chat({ chatStore })` takes realtime-modules' DynamoChatStore — the
// middleware writes no store of its own — and a message sent over the socket
// reaches DynamoDB through it, with the `social:dm:` conversations index that
// the library leaves to the host (it only indexes `chat:dm:` names itself).
//
// The default suite drives a recording fake DynamoDB client (any SDK v3 client
// with `send` is what the store takes). With SOCIAL_CHAT_DDB_IT=<endpoint> set
// — e.g. http://127.0.0.1:8000, DynamoDB Local under the `social` compose
// profile, whose init job creates the chat-* tables — the last block runs the
// same round trip against the real tables.

jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
// Production reads the Cedar registry through ESM; this CJS harness declares
// the same Social capabilities without importing the registry's import.meta.
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [
  { id: 'participant', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'moderator', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
  { id: 'community-admin', tenant: 'social', capabilities: ['ViewSocial', 'PostMessage', 'StartCall'] },
] }));

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket from 'ws';
import { DynamoChatStore } from '@connorhoehn/realtime-modules/server/stores/dynamo';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { attachRealtimeGateway, createSocialChatBackend, REALTIME_GATEWAY_PATH } from '../realtime-gateway.js';
import { socialChatConfig, type SocialChatBackend } from '../social-chat.js';
import { signRealtimeToken, realtimeClaims } from '../realtime-token.js';
import type { Session } from '../session.js';
import { getUser } from '../../providers/identity.js';

const SECRET = 'test-realtime-secret';
type Frame = Record<string, unknown> & { type?: string; action?: string };
type Open = { ws: WebSocket; frames: Frame[] };
type Sent = { name: string; input: Record<string, any> };

const prevSecret = process.env['REALTIME_JWT_SECRET'];
beforeAll(() => {
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  process.env['REALTIME_JWT_SECRET'] = SECRET;
});
afterAll(() => {
  if (prevSecret === undefined) delete process.env['REALTIME_JWT_SECRET'];
  else process.env['REALTIME_JWT_SECRET'] = prevSecret;
});

/** Records every command; answers reads with nothing, the way empty tables would. */
function recordingClient() {
  const sent: Sent[] = [];
  return {
    sent,
    async send(command: { constructor: { name: string }; input: Record<string, any> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === 'QueryCommand' || command.constructor.name === 'ScanCommand') return { Items: [] };
      if (command.constructor.name === 'BatchGetItemCommand') return { Responses: {} };
      return {};
    },
  };
}

async function serve(backend: SocialChatBackend) {
  const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
  const handle = attachRealtimeGateway(server, { redisUrl: null, pingIntervalMs: 0, socialChat: backend });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const sockets: WebSocket[] = [];
  const connectAs = async (sub: string, name: string): Promise<Open> => {
    const user = await getUser(sub, { authoritative: true });
    const session = { sub, name, role: user?.grants['social']?.[0], tenant: 'social', grants: user?.grants ?? {}, epoch: user?.epoch ?? 0, iat: Math.floor(Date.now() / 1000) } as Session;
    const { token } = await signRealtimeToken(realtimeClaims(session), SECRET);
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${REALTIME_GATEWAY_PATH}`, ['bearer-token-v1', token]);
      sockets.push(ws);
      const frames: Frame[] = [];
      ws.on('message', (data) => frames.push(JSON.parse(String(data)) as Frame));
      ws.on('error', reject);
      ws.on('open', () => {
        const start = Date.now();
        const tick = setInterval(() => {
          if (frames.some((f) => f.type === 'session')) { clearInterval(tick); resolve({ ws, frames }); }
          else if (Date.now() - start > 2_000) { clearInterval(tick); reject(new Error('no session frame')); }
        }, 10);
      });
    });
  };
  const close = async () => {
    for (const ws of sockets) ws.terminate();
    await handle.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { connectAs, close };
}

const send = (o: Open, frame: Record<string, unknown>) => o.ws.send(JSON.stringify(frame));
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean, ms = 3_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const received = (o: Open, channel: string, text: string) => o.frames.some((f) =>
  f.type === 'chat' && f.action === 'message' && (f['message'] as { channel?: string; message?: string }).channel === channel
  && (f['message'] as { message?: string }).message === text);

describe('socialChatConfig', () => {
  it('is memory with nothing set, and DynamoDB when an endpoint or a table prefix is named', () => {
    expect(socialChatConfig({}).store).toBe('memory');
    expect(socialChatConfig({ SOCIAL_CHAT_DYNAMODB_ENDPOINT: 'http://127.0.0.1:8000' })).toMatchObject({ store: 'dynamo', endpoint: 'http://127.0.0.1:8000', tablePrefix: '' });
    expect(socialChatConfig({ SOCIAL_CHAT_TABLE_PREFIX: 'orgiq-social-' })).toMatchObject({ store: 'dynamo', endpoint: null, tablePrefix: 'orgiq-social-' });
    expect(socialChatConfig({ SOCIAL_CHAT_TABLE_PREFIX: 'orgiq-social-', SOCIAL_CHAT_STORE: 'memory' }).store).toBe('memory');
    expect(socialChatConfig({ SOCIAL_CHAT_STORE: 'dynamo' }).store).toBe('dynamo');
  });

  it('builds the memory backend when the config says memory', () => {
    expect(createSocialChatBackend({ store: 'memory', endpoint: null, tablePrefix: '', region: 'us-east-1' }).kind).toBe('memory');
  });
});

describe('the DynamoChatStore wiring (recording client)', () => {
  it('chat({ chatStore }) is the library DynamoChatStore, and a DM send writes chat-messages and indexes both members', async () => {
    const client = recordingClient();
    const backend = createSocialChatBackend({ store: 'dynamo', endpoint: null, tablePrefix: 'test-', region: 'us-east-1' }, { client });
    expect(backend.kind).toBe('dynamo');
    expect(backend.chatStore).toBeInstanceOf(DynamoChatStore);
    expect((backend.chatStore as DynamoChatStore).tables.messages).toBe('test-chat-messages');
    await backend.ready;
    const { connectAs, close } = await serve(backend);
    try {
      const dm = 'social:dm:u-mira:u-sana';
      const mira = await connectAs('u-mira', 'Mira Okafor');
      const sana = await connectAs('u-sana', 'Sana Iqbal');
      send(sana, { service: 'chat', action: 'join', channel: dm });
      send(mira, { service: 'chat', action: 'join', channel: dm });
      await settle();
      client.sent.length = 0;
      send(mira, { service: 'chat', action: 'send', channel: dm, message: 'through dynamo' });
      await until(() => received(sana, dm, 'through dynamo'));
      await until(() => client.sent.some((c) => c.input['TableName'] === 'test-chat-conversations' && JSON.stringify(c.input).includes('u-sana')));
      const put = client.sent.find((c) => c.name === 'PutItemCommand' && c.input['TableName'] === 'test-chat-messages');
      expect(put?.input['Item']).toMatchObject({ channelId: { S: dm }, message: { S: 'through dynamo' }, userId: { S: 'u-mira' } });
      const indexed = client.sent.filter((c) => c.input['TableName'] === 'test-chat-conversations').map((c) => JSON.stringify(c.input));
      expect(indexed.some((k) => k.includes('u-mira'))).toBe(true);
      expect(indexed.some((k) => k.includes('u-sana'))).toBe(true);
      // One conversation row write per member, never the library's channel
      // hook and the host's DM index both (that doubled every DM send's writes).
      await settle();
      const writes = client.sent.filter((c) => c.name === 'UpdateItemCommand' && c.input['TableName'] === 'test-chat-conversations')
        .map((c) => c.input['Key']?.userId?.S).sort();
      expect(writes).toEqual(['u-mira', 'u-sana']);
    } finally { await close(); }
  });

  it('hydrates the membership mirror from chat-members (seeded once from the fixtures under MOCK_AURORA)', async () => {
    const client = recordingClient();
    const backend = createSocialChatBackend({ store: 'dynamo', endpoint: null, tablePrefix: '', region: 'us-east-1' }, { client });
    await backend.ready;
    const seeded = client.sent.filter((c) => c.name === 'PutItemCommand' && c.input['TableName'] === 'chat-members');
    expect(seeded.some((c) => c.input['Item']?.channel?.S === 'social:ch:general' && c.input['Item']?.userId?.S === 'u-sana')).toBe(true);
    // The recording client stores nothing, so the hydrated mirror is what
    // chat-members answered — empty — and the guard refuses: fail closed.
    expect(backend.membershipStore.isActiveMember('social:ch:general', 'u-sana')).toBe(false);
  });
});

const IT = process.env['SOCIAL_CHAT_DDB_IT']?.trim();
(IT ? describe : describe.skip)(`DynamoDB Local round trip (SOCIAL_CHAT_DDB_IT=${IT ?? ''})`, () => {
  it('a channel message and a DM land in the real chat-* tables and come back through a fresh DynamoChatStore', async () => {
    const backend = createSocialChatBackend({ store: 'dynamo', endpoint: IT!, tablePrefix: '', region: 'us-east-1' });
    await backend.ready;
    expect(backend.membershipStore.isActiveMember('social:ch:general', 'u-sana')).toBe(true);
    const { connectAs, close } = await serve(backend);
    const stamp = `it-${Date.now()}`;
    try {
      const mira = await connectAs('u-mira', 'Mira Okafor');
      const sana = await connectAs('u-sana', 'Sana Iqbal');
      for (const o of [mira, sana]) send(o, { service: 'chat', action: 'join', channel: 'social:ch:general' });
      for (const o of [mira, sana]) send(o, { service: 'chat', action: 'join', channel: 'social:dm:u-mira:u-sana' });
      await settle(400);
      send(mira, { service: 'chat', action: 'send', channel: 'social:ch:general', message: `channel ${stamp}` });
      send(mira, { service: 'chat', action: 'send', channel: 'social:dm:u-mira:u-sana', message: `dm ${stamp}` });
      await until(() => received(sana, 'social:ch:general', `channel ${stamp}`) && received(sana, 'social:dm:u-mira:u-sana', `dm ${stamp}`));
      await settle(400);
      const fresh = new DynamoChatStore({
        client: new DynamoDBClient({ region: 'us-east-1', endpoint: IT!, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }),
      });
      expect((await fresh.listMessages('social:ch:general', 50)).some((m) => m.message === `channel ${stamp}`)).toBe(true);
      expect((await fresh.listMessages('social:dm:u-mira:u-sana', 50)).some((m) => m.message === `dm ${stamp}`)).toBe(true);
      // chat-messages sorts by messageId: the newest must be the one just sent, not a seeded row.
      expect((await backend.lastMessage('social:ch:general'))?.message).toBe(`channel ${stamp}`);
      const rows = await fresh.conversations.listForUser('u-sana');
      expect(rows.find((r) => r.channel === 'social:dm:u-mira:u-sana')?.lastMessagePreview).toBe(`dm ${stamp}`);
    } finally { await close(); }
  });
});
