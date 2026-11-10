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
import { socialBindingsFixture } from '../../mock/social-bindings.js';
import { discussionHome } from '../initiative-discussion.js';

// Inference Platform has no bound channel (mock/social-bindings.ts): its notes stay on the initiative thread.
const input = {
  projectId: 'p-inference-platform', workItemId: 'wi-inf-e1-b3',
  userId: 'u-vera', displayName: 'Vera Green', personId: 'p-002',
  body: 'Confirm the cardinality threshold in CI.', deliveryId: 'rehearsal-comment-1',
  // The binding read admits Vera (a Social grant); the last describe takes it away.
  readsSocial: true,
};
// Auth Migration is bound to #auth-migration.
const bound = { ...input, projectId: 'p-auth-migration', workItemId: 'wi-auth-e2-b3', deliveryId: 'rehearsal-comment-2' };
beforeEach(() => {
  setSocialChatBackend(createMemorySocialChatBackend());
  (historyFloor as jest.Mock).mockResolvedValue(null);
});
afterEach(() => { setSocialChatBackend(null); socialBindingsFixture.reset(); });

it('stores once in the initiative conversation and projects the note only onto its work item', async () => {
  const before = await workThreadSummary(input.workItemId, input.userId);
  const message = await postInitiativeWorkComment(input);
  expect(message.discussion).toBe('thread');
  expect((await socialChat().chatStore.listMessages('orgiq:initiative:p-inference-platform', 1000)).some(m => m.id === message.id)).toBe(true);
  expect((await listWorkItemComments(input.workItemId, input.userId)).comments.filter(c => c.id === message.id)).toHaveLength(1);
  expect((await workThreadSummary(input.workItemId, input.userId)).commentCount).toBe(before.commentCount + 1);
  expect((await listWorkItemComments('wi-inf-e1-s1', input.userId)).comments.some(c => c.id === message.id)).toBe(false);
});

it('on a bound initiative the note is a record on the work item, never on the old initiative thread (leftovers 2)', async () => {
  const message = await postInitiativeWorkComment(bound);
  expect(message.discussion).toBe('channel');
  expect(message.channel).toBe('orgiq:work:wi-auth-e2-b3');
  expect((await socialChat().chatStore.listMessages('orgiq:initiative:p-auth-migration', 1000)).some(m => m.id === message.id)).toBe(false);
  expect((await listWorkItemComments(bound.workItemId, bound.userId)).comments.filter(c => c.id === message.id)).toHaveLength(1);
  // Idempotent on the delivery id there too.
  expect((await postInitiativeWorkComment(bound)).id).toBe(message.id);
});

it('retries return the original message and refuse a different body under the same delivery id', async () => {
  const first = await postInitiativeWorkComment(input);
  const second = await postInitiativeWorkComment(input);
  expect(second.id).toBe(first.id);
  await expect(postInitiativeWorkComment({ ...input, body: 'Different note' })).rejects.toMatchObject({ status: 409 });
});

it('refuses a work item from a different initiative', async () => {
  await expect(postInitiativeWorkComment({ ...input, projectId: 'p-observability' })).rejects.toMatchObject({ status: 404 });
});

it('applies the initiative history floor before projecting its messages into a work feed', async () => {
  const message = await postInitiativeWorkComment(input);
  (historyFloor as jest.Mock).mockImplementation(async (channel: string) => channel === message.channel ? message.timestamp : null);
  expect((await listWorkItemComments(input.workItemId, 'reader')).comments.some(c => c.id === message.id)).toBe(false);
});

describe('a private binding the caller may not know of (sweep 12, L2)', () => {
  // Bind Inference Platform to #moderators: private, Lena and Mira only (mock/social-channels.ts).
  const bindPrivate = () => socialBindingsFixture.rows().push({ tenant: 'orgiq', contextKind: 'initiative', contextId: 'p-inference-platform', channel: 'social:ch:moderators', createdBy: 'u-lena', createdAt: '2026-11-01T00:00:00.000Z' });

  it('a non-member is answered as on an unbound initiative, and the note lands on the thread their pane shows', async () => {
    bindPrivate();
    const message = await postInitiativeWorkComment({ ...input, deliveryId: 'sweep12-l2-a' });
    // Neutral: the same answer the read route gives this caller (no channel).
    expect(message.discussion).toBe('thread');
    expect(message.channel).toBe('orgiq:initiative:p-inference-platform');
    expect(await discussionHome('p-inference-platform')).toBeNull();
    expect(JSON.stringify(message)).not.toContain('moderators');
    // Still a record on the work item for everyone who reads its feed.
    expect((await listWorkItemComments(input.workItemId, input.userId)).comments.some(c => c.id === message.id)).toBe(true);
  });

  it('a member of the private channel is told to post the reference there', async () => {
    bindPrivate();
    const message = await postInitiativeWorkComment({ ...input, userId: 'u-mira', displayName: 'Mira Okafor', personId: null, deliveryId: 'sweep12-l2-b' });
    expect(message.discussion).toBe('channel');
    expect(message.channel).toBe('orgiq:work:wi-inf-e1-b3');
  });

  it('a member whose Social grant is gone is answered as their pane shows: the old thread, never the channel', async () => {
    bindPrivate();
    const message = await postInitiativeWorkComment({ ...input, userId: 'u-mira', displayName: 'Mira Okafor', personId: null, deliveryId: 'sweep12-l2-c', readsSocial: false });
    expect(message.discussion).toBe('thread');
    expect(message.channel).toBe('orgiq:initiative:p-inference-platform');
    expect(JSON.stringify(message)).not.toContain('moderators');
    expect((await listWorkItemComments(input.workItemId, input.userId)).comments.some(c => c.id === message.id)).toBe(true);
  });

  it('a public binding is the channel either way (the page names it to a viewer without Social too)', async () => {
    const message = await postInitiativeWorkComment({ ...bound, deliveryId: 'sweep12-l2-d', readsSocial: false });
    expect(message.discussion).toBe('channel');
  });
});
