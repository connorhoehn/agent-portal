// Dynamo round trips a DM send's index/audience hooks cost (capacity-sockets,
// 2026-10-06): a tenant DM's audience comes from its name instead of a
// conversations-GSI Query, and SOCIAL_CHAT_INDEX_WRITES=transaction writes
// both members' index rows in one TransactWriteItems request.
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', aurora: {}, auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));
jest.mock('../role-registry.js', () => ({ roleRegistry: () => [] }));

import { createSocialChatBackend, peerOperationLingerMs, socialChatIndexWrites } from '../realtime-gateway.js';
import type { SocialChatConfig } from '../social-chat.js';

const cfg = { store: 'dynamo', region: 'us-east-1', endpoint: 'http://127.0.0.1:1', tablePrefix: 'send-test-' } as unknown as SocialChatConfig;
const prev = process.env['SOCIAL_CHAT_INDEX_WRITES'];
afterEach(() => { if (prev === undefined) delete process.env['SOCIAL_CHAT_INDEX_WRITES']; else process.env['SOCIAL_CHAT_INDEX_WRITES'] = prev; });

function fakeClient() {
  const sent: Array<{ name: string; input: any }> = [];
  return { sent, send: async (command: any) => { sent.push({ name: command.constructor.name, input: command.input }); return command.constructor.name === 'QueryCommand' ? { Items: [] } : {}; } };
}
const message = (channel: string) => ({ id: 'm1', clientId: 'c1', userId: 'u-a', channel, message: 'hi', timestamp: '2026-10-06T12:00:00.000Z' });

it('a tenant DM audience is its named members, with no conversations Query; other channels still ask the index', async () => {
  const client = fakeClient();
  const backend = createSocialChatBackend(cfg, { client });
  await backend.ready;
  const options = backend.chatOptions() as unknown as { channelAudience: (c: string) => Promise<string[]> | string[] };
  client.sent.length = 0;
  expect(await options.channelAudience('social:dm:u-a:u-b')).toEqual(['u-a', 'u-b']);
  expect(client.sent).toEqual([]);
  await options.channelAudience('social:ch:general');
  expect(client.sent.map(s => s.name)).toEqual(['QueryCommand']);
  expect(client.sent[0].input.IndexName).toBe('channel-index');
});

it('index writes are per member by default and one transaction when SOCIAL_CHAT_INDEX_WRITES=transaction', async () => {
  for (const [mode, expected] of [[undefined, ['UpdateItemCommand', 'UpdateItemCommand']], ['transaction', ['TransactWriteItemsCommand']]] as const) {
    if (mode) process.env['SOCIAL_CHAT_INDEX_WRITES'] = mode; else delete process.env['SOCIAL_CHAT_INDEX_WRITES'];
    const client = fakeClient();
    const backend = createSocialChatBackend(cfg, { client });
    await backend.ready;
    client.sent.length = 0;
    await backend.conversations.recordDmMessage('social:dm:u-a:u-b', ['u-a', 'u-b'], message('social:dm:u-a:u-b') as any);
    expect(client.sent.map(s => s.name)).toEqual(expected);
  }
});

it('REALTIME_PEER_OPERATION_LINGER_MS and SOCIAL_CHAT_INDEX_WRITES parse strictly', () => {
  expect(peerOperationLingerMs({})).toBe(500);
  expect(peerOperationLingerMs({ REALTIME_PEER_OPERATION_LINGER_MS: '0' })).toBe(0);
  expect(peerOperationLingerMs({ REALTIME_PEER_OPERATION_LINGER_MS: '2000' })).toBe(2000);
  for (const bad of ['-1', '1.5', 'x', '2001']) expect(() => peerOperationLingerMs({ REALTIME_PEER_OPERATION_LINGER_MS: bad })).toThrow();
  expect(socialChatIndexWrites({})).toBe('each');
  expect(socialChatIndexWrites({ SOCIAL_CHAT_INDEX_WRITES: 'transaction' })).toBe('transaction');
  expect(() => socialChatIndexWrites({ SOCIAL_CHAT_INDEX_WRITES: 'batch' })).toThrow();
});
