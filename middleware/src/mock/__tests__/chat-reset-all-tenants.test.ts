// Every chat channel's state — not only `social:` — lives in registered
// fixtures under MOCK_AURORA, so POST /api/__mock/reset undoes it
// (the e2e "post to conversation" specs depend on this being idempotent).
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } },
}));

import { createMemorySocialChatBackend } from '../../lib/social-chat.js';
import { MemoryReactionStore, RowsFileUploadMetadataStore } from '../../lib/gateway-attachments.js';
import { fixtureRegistry } from '../core/index.js';
import { gatewayReactionsFixture, gatewayUploadsFixture } from '../gateway-attachments.js';

const channels = ['pipelines:run:r1', 'orgiq:initiative:p-auth-migration', 'assessment:doc:d1', 'orgiq:dm:u-a:u-b', 'social:ch:general'];

test('a reset removes messages, receipts, pins, reactions and uploads on every tenant channel', async () => {
  const be = createMemorySocialChatBackend({ fixtures: true });
  const reactions = new MemoryReactionStore(() => gatewayReactionsFixture.rows());
  const uploads = new RowsFileUploadMetadataStore(() => gatewayUploadsFixture.rows());
  // Some channels carry seeded history (#general, Auth Migration's initiative thread): a reset puts exactly that back.
  const seededIn = new Map<string, number>();
  for (const channel of channels) seededIn.set(channel, (await be.chatStore.listMessages(channel, 100)).length);
  for (const channel of channels) {
    await be.chatStore.putMessage({ id: `m-${channel}`, clientId: 'c', userId: 'u-a', channel, message: 'Highlights', metadata: {}, timestamp: new Date().toISOString() });
    await reactions.add({ channel, targetId: `m-${channel}`, emoji: '+1', userId: 'u-a', timestamp: new Date().toISOString() } as never);
  }
  await uploads.create({ uploadId: 'up1', channel: channels[0]!, uploader: 'u-a', filename: 'f.txt', size: 1, status: 'pending' });
  expect(await be.chatStore.listMessages(channels[0]!, 10)).toHaveLength(seededIn.get(channels[0]!)! + 1);
  expect(await reactions.list(channels[1]!)).toHaveLength(1);
  expect(await uploads.get('up1')).not.toBeNull();

  fixtureRegistry.resetAll();

  for (const channel of channels) {
    const after = await be.chatStore.listMessages(channel, 100);
    expect(after).toHaveLength(seededIn.get(channel)!);
    expect(after.some((m) => m.id === `m-${channel}`)).toBe(false);
  }
  expect(await reactions.list(channels[1]!)).toHaveLength(0);
  expect(await uploads.get('up1')).toBeNull();
});
