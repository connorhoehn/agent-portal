// Opt-in DynamoDB Local contract for the work-comment migration's chat-store
// half: the library's DynamoChatStore over real SDK requests. Opt in with
// PAGE_THREAD_TEST_DYNAMODB_ENDPOINT (loopback only). The suite creates its
// OWN tables under a random `orgiq-chat-pagethread-<hex>-` prefix from the
// public schema manifest and deletes exactly those tables afterwards; it never
// touches the shared stack's tables.
//
// Proves: (1) idempotency at the store key — re-running, or two migrators with
// NO shared ledger, leave exactly one item per comment; (2) the history floor —
// a member whose `historyFrom` is after a migrated comment's created_at does
// not read it through the library's own ChatService.getChannelHistoryFor, and
// the BFF's REST rule (routes/chat-pins.ts messageVisible) agrees.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, QueryCommand, waitUntilTableExists } from '@aws-sdk/client-dynamodb';
import { ChatService } from '@connorhoehn/realtime-modules/chat';
import { LocalRealtimeRouter } from '@connorhoehn/realtime-modules/server';
import { DynamoChatStore } from '@connorhoehn/realtime-modules/server/stores/dynamo';
import { memoryCommentSource, migrateWorkComments } from '../migrate-work-comments.js';
import type { LegacyWorkComment } from '../work-thread.js';

// The default SDK HTTP handler's dynamic import does not work in Jest's VM;
// the fetch transport still executes real DynamoDB HTTP requests.
const { FetchHttpHandler } = require('@smithy/fetch-http-handler');
const endpoint = process.env['PAGE_THREAD_TEST_DYNAMODB_ENDPOINT'];
if (endpoint && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname)) throw new Error('DynamoDB Local must be on loopback');
const suite = endpoint ? describe : describe.skip;
const prefix = `orgiq-chat-pagethread-${randomBytes(4).toString('hex')}-`;
const TABLES = ['chat-messages', 'chat-members'];
const manifest = JSON.parse(readFileSync(require.resolve('@connorhoehn/realtime-examples-cdk/dynamodb-schemas.json', { paths: [resolvePath(process.cwd(), '..', 'infra')] }), 'utf8')) as
  { tables: { tableName: string; hashKey: { name: string; type: 'S' }; rangeKey?: { name: string; type: 'S' } }[] };

const client = () => new DynamoDBClient({ endpoint, region: 'us-east-1', maxAttempts: 2,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, requestHandler: new FetchHttpHandler({ requestTimeout: 5000 }) });
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const comment = (i: number, work = 'wi-dyn'): LegacyWorkComment => ({
  commentId: `wic-${String(i).padStart(3, '0')}`, workItemId: work, authorPersonId: i % 2 ? 'p-004' : 'p-051',
  authorPersonName: i % 2 ? 'Nora (directory)' : 'Priya Nair', authorUserId: i % 2 ? 'u-nora' : null,
  authorUserDisplayName: i % 2 ? 'Nora DaSilva' : null, body: `Comment ${i}`,
  createdAt: new Date(Date.UTC(2026, 8, 1, 12, i)).toISOString(),
});

async function itemsOn(c: DynamoDBClient, channel: string): Promise<number> {
  const out = await c.send(new QueryCommand({ TableName: `${prefix}chat-messages`, KeyConditionExpression: 'channelId = :c',
    ExpressionAttributeValues: { ':c': { S: channel } }, Select: 'COUNT' }));
  return out.Count ?? 0;
}

suite('work-comment migration into DynamoDB Local', () => {
  jest.setTimeout(60_000);
  const c = client();
  const store = () => new DynamoChatStore({ client: c, tablePrefix: prefix, logger });

  beforeAll(async () => {
    for (const name of TABLES) {
      const t = manifest.tables.find((x) => x.tableName === name)!;
      const keys = [t.hashKey, ...(t.rangeKey ? [t.rangeKey] : [])];
      await c.send(new CreateTableCommand({ TableName: `${prefix}${name}`, BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: keys.map((k) => ({ AttributeName: k.name, AttributeType: k.type })),
        KeySchema: keys.map((k, i) => ({ AttributeName: k.name, KeyType: i === 0 ? 'HASH' : 'RANGE' })) }));
      await waitUntilTableExists({ client: c, maxWaitTime: 30, minDelay: 1, maxDelay: 2 }, { TableName: `${prefix}${name}` });
    }
  });
  afterAll(async () => {
    for (const name of TABLES) await c.send(new DeleteTableCommand({ TableName: `${prefix}${name}` })).catch(() => undefined);
  });

  it('re-running, and two migrators with no shared ledger, leave exactly one item per comment', async () => {
    const comments = Array.from({ length: 25 }, (_, i) => comment(i));
    const first = await migrateWorkComments({ source: memoryCommentSource(() => comments), target: store(), batchSize: 6, migrator: 'one' });
    expect(first).toMatchObject({ claimed: 25, written: 25, failures: [], unlinkedAuthors: ['p-051'] });
    expect(await itemsOn(c, 'orgiq:work:wi-dyn')).toBe(25);

    const rerun = await migrateWorkComments({ source: memoryCommentSource(() => comments), target: store(), migrator: 'two' });
    expect(rerun).toMatchObject({ claimed: 25, written: 0, alreadyInStore: 25 });

    // Worst case: two migrators that do not share a ledger race over new rows.
    const more = Array.from({ length: 20 }, (_, i) => comment(100 + i, 'wi-race'));
    const [a, b] = await Promise.all(['a', 'b'].map((m) => migrateWorkComments({ source: memoryCommentSource(() => more), target: store(), batchSize: 5, migrator: m })));
    expect(a!.failures.concat(b!.failures)).toEqual([]);
    expect(await itemsOn(c, 'orgiq:work:wi-race')).toBe(20);
    expect(await itemsOn(c, 'orgiq:work:wi-dyn')).toBe(25);

    const read = await store().listMessages('orgiq:work:wi-dyn', 100);
    expect(read.map((m) => m.metadata?.['commentId'])).toEqual(comments.map((x) => x.commentId)); // thread order = created_at order
    expect(read.find((m) => m.metadata?.['commentId'] === 'wic-001')).toMatchObject({ userId: 'u-nora', metadata: { displayName: 'Nora DaSilva', migratedFrom: 'work_item_comments' } });
    expect(read.find((m) => m.metadata?.['commentId'] === 'wic-000')!.userId).toBeUndefined();
  });

  it('history floor: a member who joined after a comment was written does not read it', async () => {
    const comments = [comment(0, 'wi-floor'), comment(10, 'wi-floor'), comment(20, 'wi-floor')];
    const s = store();
    await migrateWorkComments({ source: memoryCommentSource(() => comments), target: s, migrator: 'floor' });
    const channel = 'orgiq:work:wi-floor';
    // u-late's history starts at the second comment's instant: strictly after it.
    await s.members.putMember({ channel, userId: 'u-late', role: 'member', addedBy: 'u-nora', addedAt: comments[1]!.createdAt,
      historyFrom: comments[1]!.createdAt, removedAt: null });
    await s.members.putMember({ channel, userId: 'u-early', role: 'owner', addedBy: 'u-early', addedAt: comments[0]!.createdAt,
      historyFrom: null, removedAt: null });

    const service = new ChatService({ messageRouter: new LocalRealtimeRouter() as never, logger: logger as never, chatStore: s, membershipStore: s.members } as never);
    const late = await service.getChannelHistoryFor('u-late', channel, 50);
    expect(late.map((m) => m.metadata?.['commentId'])).toEqual(['wic-020']);
    const early = await service.getChannelHistoryFor('u-early', channel, 50);
    expect(early.map((m) => m.metadata?.['commentId'])).toEqual(['wic-000', 'wic-010', 'wic-020']);
    // A non-member of a channel with a member list reads nothing.
    expect(await service.getChannelHistoryFor('u-outsider', channel, 50)).toEqual([]);

    // The BFF REST read applies the same strictly-after rule over the same rows.
    const { messageVisible } = await import('../../routes/chat-pins.js');
    const floor = Date.parse((await s.members.getMember!(channel, 'u-late'))!.historyFrom!);
    const all = await s.listMessages(channel, 50);
    expect(all.filter((m) => messageVisible(m, floor)).map((m) => m.metadata?.['commentId'])).toEqual(['wic-020']);
  });
});
