// The work-comment migration's contract over the in-memory source and the
// library-shaped memory ChatStore (lib/social-chat.ts RowsChatStore). The SQL
// half runs against real PostgreSQL in migrate-work-comments-postgres.test.ts,
// the DynamoDB half against DynamoDB Local in migrate-work-comments-dynamo.test.ts.
jest.mock('../../config.js', () => ({ config: { mock: { aurora: true } } }));

import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { migrateWorkComments, memoryCommentSource } from '../migrate-work-comments.js';
import { legacyCommentMessage, migratedMessageId, type LegacyWorkComment } from '../work-thread.js';
import { RowsChatStore } from '../social-chat.js';
import { workItemComments } from '../../mock/work-item-comments.js';
import { legacyWorkComment, socialChannelMessagesFixture } from '../../mock/social-channels.js';

const linked = (id: string, at: string, work = 'wi-a'): LegacyWorkComment => ({
  commentId: id, workItemId: work, authorPersonId: 'p-004', authorPersonName: 'Nora (directory)',
  authorUserId: 'u-nora', authorUserDisplayName: 'Nora DaSilva', body: `body ${id}`, createdAt: at,
});
const unlinked = (id: string, at: string): LegacyWorkComment => ({
  commentId: id, workItemId: 'wi-b', authorPersonId: 'p-051', authorPersonName: 'Priya Nair',
  authorUserId: null, authorUserDisplayName: null, body: `body ${id}`, createdAt: at,
});

function world(comments: LegacyWorkComment[]) {
  const rows: ChatMessage[] = [];
  return { rows, store: new RowsChatStore(() => rows), source: memoryCommentSource(() => comments) };
}

describe('migrateWorkComments', () => {
  const comments = [
    linked('wic-1', '2026-09-01T10:00:00.000Z'), linked('wic-2', '2026-09-02T10:00:00.000Z'),
    unlinked('wic-3', '2026-09-03T10:00:00.000Z'), linked('wic-4', '2026-09-04T10:00:00.000Z', 'wi-b'),
  ];

  it('writes each comment once, batched, with provenance and server-stamped senders', async () => {
    const w = world(comments);
    const report = await migrateWorkComments({ source: w.source, target: w.store, batchSize: 3, migrator: 'm1' });
    expect(report).toMatchObject({ batches: 2, claimed: 4, written: 4, alreadyInStore: 0, failures: [],
      unlinkedAuthors: ['p-051'], removedAuthors: 0, perWorkItem: { 'wi-a': 2, 'wi-b': 2 } });
    expect(w.rows).toHaveLength(4);
    const m1 = w.rows.find((m) => m.metadata?.['commentId'] === 'wic-1')!;
    expect(m1).toMatchObject({ channel: 'orgiq:work:wi-a', userId: 'u-nora', clientId: 'migration', timestamp: '2026-09-01T10:00:00.000Z',
      metadata: { migratedFrom: 'work_item_comments', commentId: 'wic-1', displayName: 'Nora DaSilva', authorPersonId: 'p-004' } });
    // A linked author is named by their login's display name, not the directory's free text.
    expect(m1.metadata?.['displayName']).not.toBe('Nora (directory)');
    // No login: named by the directory, no userId (never a person id posing as a user id).
    const m3 = w.rows.find((m) => m.metadata?.['commentId'] === 'wic-3')!;
    expect(m3.userId).toBeUndefined();
    expect(m3.metadata).toMatchObject({ displayName: 'Priya Nair', unlinkedAuthor: true, authorPersonId: 'p-051' });
  });

  it('is idempotent: a second run claims and writes nothing', async () => {
    const w = world(comments);
    await migrateWorkComments({ source: w.source, target: w.store, migrator: 'm1' });
    const again = await migrateWorkComments({ source: w.source, target: w.store, migrator: 'm2' });
    expect(again).toMatchObject({ claimed: 0, written: 0, batches: 0 });
    expect(w.rows).toHaveLength(4);
  });

  it('a fresh ledger over a store that already holds the messages writes nothing new (keyed on comment id)', async () => {
    const w = world(comments);
    await migrateWorkComments({ source: w.source, target: w.store, migrator: 'm1' });
    const report = await migrateWorkComments({ source: memoryCommentSource(() => comments), target: w.store, migrator: 'm3' });
    expect(report).toMatchObject({ claimed: 4, written: 0, alreadyInStore: 4 });
    expect(w.rows).toHaveLength(4);
  });

  it('two migrators racing over one ledger write every comment exactly once', async () => {
    const many = Array.from({ length: 40 }, (_, i) => linked(`wic-${String(i).padStart(3, '0')}`, new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString()));
    const w = world(many);
    const [a, b] = await Promise.all([
      migrateWorkComments({ source: w.source, target: w.store, batchSize: 7, migrator: 'a' }),
      migrateWorkComments({ source: w.source, target: w.store, batchSize: 7, migrator: 'b' }),
    ]);
    expect(a.written + b.written).toBe(40);
    expect(new Set(w.rows.map((m) => m.id)).size).toBe(40);
    expect(w.rows).toHaveLength(40);
  });

  it('dry run claims and writes nothing, and reports what would move', async () => {
    const w = world(comments);
    const report = await migrateWorkComments({ source: w.source, target: w.store, batchSize: 2, dryRun: true });
    expect(report).toMatchObject({ dryRun: true, claimed: 4, written: 0, batches: 2 });
    expect(w.rows).toEqual([]);
    expect(w.source.ledger.size).toBe(0);
  });

  it('a failed write leaves the claim unconfirmed and is reported', async () => {
    const w = world(comments);
    const target = { getMessage: w.store.getMessage.bind(w.store),
      putMessage: async (m: ChatMessage) => { if (m.metadata?.['commentId'] === 'wic-2') throw new Error('throttled'); await w.store.putMessage(m); } };
    const report = await migrateWorkComments({ source: w.source, target, migrator: 'm1' });
    expect(report.written).toBe(3);
    expect(report.failures).toEqual([{ commentId: 'wic-2', error: 'throttled' }]);
    expect(w.source.ledger.get('wic-2')?.writtenAt).toBeNull();
    expect(w.source.ledger.get('wic-1')?.writtenAt).not.toBeNull();
  });

  it('message ids keep thread order (time-prefixed, like the library) and are a pure function of the comment', () => {
    const early = migratedMessageId('wic-z', '2026-01-01T00:00:00.000Z');
    const late = migratedMessageId('wic-a', '2026-06-01T00:00:00.000Z');
    expect(early < late).toBe(true);
    expect(migratedMessageId('wic-z', '2026-01-01T00:00:00.000Z')).toBe(early);
    // Ids differing only in punctuation do not collide.
    expect(migratedMessageId('wic-a-b', '2026-01-01T00:00:00.000Z')).not.toBe(migratedMessageId('wic-ab', '2026-01-01T00:00:00.000Z'));
  });
});

describe('the mock thread IS the migration of the fixture', () => {
  it('every seeded human comment appears on its thread exactly as the migration writes it', () => {
    workItemComments.reset(); socialChannelMessagesFixture.reset();
    const expected = workItemComments.rows().filter((c) => !c.isSystem).map((c) => legacyCommentMessage(legacyWorkComment(c)));
    const thread = socialChannelMessagesFixture.rows().filter((m) => m.channel.startsWith('orgiq:work:'));
    expect(thread).toEqual(expected);
    // Every seeded human comment, counted from the fixture rather than typed here.
    expect(thread.length).toBeGreaterThan(0);
  });
});
