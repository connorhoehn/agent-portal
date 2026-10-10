jest.mock('../../config.js', () => ({ config: { mock: { aurora: true }, region: 'us-east-1', aurora: {} } }));
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../routes/chat-pins.js', () => ({
  historyFloor: jest.fn(async () => null),
  messageVisible: (message: { deletedAt?: string; metadata?: { deleted?: boolean }; timestamp: string }, floor?: string | null) =>
    !message.deletedAt && !message.metadata?.deleted && (!floor || message.timestamp > floor),
}));

import { postInitiativeWorkComment } from '../initiative-comments.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../social-chat.js';
import { listWorkItemComments, workThreadSummary } from '../../providers/work-items.js';
import { historyFloor } from '../../routes/chat-pins.js';

const input = {
  projectId: 'p-observability', workItemId: 'wi-obs-e3-s1',
  userId: 'u-vera', displayName: 'Vera Green', personId: 'p-002',
  body: 'Confirm the cardinality threshold in CI.', deliveryId: 'rehearsal-comment-1',
};
beforeEach(() => {
  setSocialChatBackend(createMemorySocialChatBackend());
  (historyFloor as jest.Mock).mockResolvedValue(null);
});
afterEach(() => setSocialChatBackend(null));

it('stores once in the initiative conversation and projects the note only onto its work item', async () => {
  const before = await workThreadSummary(input.workItemId, input.userId);
  const message = await postInitiativeWorkComment(input);
  expect((await socialChat().chatStore.listMessages('orgiq:initiative:p-observability', 1000)).some(m => m.id === message.id)).toBe(true);
  expect((await listWorkItemComments(input.workItemId, input.userId)).comments.filter(c => c.id === message.id)).toHaveLength(1);
  expect((await workThreadSummary(input.workItemId, input.userId)).commentCount).toBe(before.commentCount + 1);
  expect((await listWorkItemComments('wi-obs-e3-s2', input.userId)).comments.some(c => c.id === message.id)).toBe(false);
});

it('retries return the original message and refuse a different body under the same delivery id', async () => {
  const first = await postInitiativeWorkComment(input);
  const second = await postInitiativeWorkComment(input);
  expect(second.id).toBe(first.id);
  await expect(postInitiativeWorkComment({ ...input, body: 'Different note' })).rejects.toMatchObject({ status: 409 });
});

it('refuses a work item from a different initiative', async () => {
  await expect(postInitiativeWorkComment({ ...input, projectId: 'p-auth-migration' })).rejects.toMatchObject({ status: 404 });
});

it('applies the initiative history floor before projecting its messages into a work feed', async () => {
  const message = await postInitiativeWorkComment(input);
  (historyFloor as jest.Mock).mockImplementation(async (channel: string) => channel === message.channel ? message.timestamp : null);
  expect((await listWorkItemComments(input.workItemId, 'reader')).comments.some(c => c.id === message.id)).toBe(false);
});
