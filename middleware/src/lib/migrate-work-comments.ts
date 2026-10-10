// One-time projection of `work_item_comments` (human rows) into the gateway
// chat thread `orgiq:work:<id>` — the "two stores for one page conversation"
// finding (docs/audit/2026-10-07-audit-plan.md D2). After it runs the thread is
// the only store a human comment lives in; the table keeps its rows as
// read-only audit history beside the is_system audit events still written there.
//
// Contract:
//   * Idempotent, keyed on the comment id twice over: the ledger
//     `work_item_comment_migrations` (schema/work_item_comment_migration_schema.sql)
//     admits one claim per comment, and the message id is a pure function of the
//     comment (lib/work-thread.ts migratedMessageId), so a retried or raced write
//     lands on the same key. Re-running writes nothing.
//   * Concurrent migrators each claim disjoint rows (INSERT ... ON CONFLICT DO
//     UPDATE ... WHERE stale-and-unwritten): every comment is written once.
//   * Batched; `dryRun` claims and writes nothing and reports what would move.
//   * Sender identity comes from directory rows (app_users linked by
//     person_id), never from comment text; an author with no login migrates as
//     a named-but-unlinked sender (lib/work-thread.ts legacyCommentMessage).
//   * Message timestamps are the comments' own created_at, so a member's
//     history floor (`historyFrom`, strictly-after) applies to them exactly as
//     to any other message.
//
// CLI (bounded, explicit target):
//   SOCIAL_CHAT_STORE=dynamo SOCIAL_CHAT_DYNAMODB_ENDPOINT=… SOCIAL_CHAT_TABLE_PREFIX=… \
//     npx tsx src/lib/migrate-work-comments.ts [--dry-run] [--batch 100] [--report out.json]

import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';
import { legacyCommentMessage, type LegacyWorkComment } from './work-thread.js';

/** The slice of a ChatStore the migration needs (DynamoChatStore, RowsChatStore). */
export interface ThreadTarget {
  getMessage(channel: string, messageId: string): Promise<ChatMessage | null>;
  putMessage(message: ChatMessage): Promise<void>;
}

/** Where legacy comments come from, with the claim/confirm ledger. */
export interface CommentSource {
  /** Claim up to `limit` unmigrated human comments for `migrator`; returns only rows this call claimed. */
  claimBatch(migrator: string, limit: number): Promise<LegacyWorkComment[]>;
  /** Read-only: unmigrated human comments after `afterId`, id order (dry run). */
  pending(afterId: string, limit: number): Promise<LegacyWorkComment[]>;
  /** Record that the comment's message is in the chat store. */
  markWritten(commentId: string, migrator: string, channel: string, messageId: string): Promise<void>;
}

export interface MigrationReport {
  migrator: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  batches: number;
  /** Comments this run claimed (dry run: would claim). */
  claimed: number;
  /** Messages this run put into the chat store. */
  written: number;
  /** Claimed, but the message was already in the store (a retry after a lost confirm). */
  alreadyInStore: number;
  /** Authors with no linked login, migrated as named-but-unlinked senders. */
  unlinkedAuthors: string[];
  /** Comments whose person row is gone (author_id NULL): no name, no user. */
  removedAuthors: number;
  perWorkItem: Record<string, number>;
  failures: { commentId: string; error: string }[];
}

export interface MigrateOptions {
  source: CommentSource;
  target: ThreadTarget;
  batchSize?: number;
  dryRun?: boolean;
  migrator?: string;
  /** Upper bound on batches, so a run is always bounded. */
  maxBatches?: number;
  now?: () => Date;
}

export async function migrateWorkComments(opts: MigrateOptions): Promise<MigrationReport> {
  const batchSize = opts.batchSize ?? 100;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new Error('batchSize must be an integer from 1 to 1000');
  const maxBatches = opts.maxBatches ?? 10_000;
  const now = opts.now ?? (() => new Date());
  const migrator = opts.migrator ?? `migrator-${randomUUID()}`;
  const report: MigrationReport = {
    migrator, dryRun: !!opts.dryRun, startedAt: now().toISOString(), finishedAt: '',
    batches: 0, claimed: 0, written: 0, alreadyInStore: 0, unlinkedAuthors: [], removedAuthors: 0, perWorkItem: {}, failures: [],
  };
  const unlinked = new Set<string>();
  const note = (c: LegacyWorkComment) => {
    report.claimed += 1;
    report.perWorkItem[c.workItemId] = (report.perWorkItem[c.workItemId] ?? 0) + 1;
    if (!c.authorPersonId) report.removedAuthors += 1;
    else if (!c.authorUserId) unlinked.add(c.authorPersonId);
  };

  let after = '';
  while (report.batches < maxBatches) {
    const batch = opts.dryRun ? await opts.source.pending(after, batchSize) : await opts.source.claimBatch(migrator, batchSize);
    if (batch.length === 0) break;
    report.batches += 1;
    for (const c of batch) {
      note(c);
      if (opts.dryRun) continue;
      const message = legacyCommentMessage(c);
      try {
        if (await opts.target.getMessage(message.channel, message.id)) report.alreadyInStore += 1;
        else { await opts.target.putMessage(message); report.written += 1; }
        await opts.source.markWritten(c.commentId, migrator, message.channel, message.id);
      } catch (err) {
        // The claim stays unwritten; a later run takes it over once stale.
        report.failures.push({ commentId: c.commentId, error: (err as Error).message });
      }
    }
    after = batch[batch.length - 1]!.commentId;
    // A batch that failed entirely would be reclaimed only after the lease, so stop rather than spin.
    if (!opts.dryRun && report.failures.length > 0 && report.failures.length >= report.claimed) break;
  }
  report.unlinkedAuthors = [...unlinked].sort();
  report.finishedAt = now().toISOString();
  return report;
}

// ── Aurora source (RDS Data API) ─────────────────────────────────────────────

type Exec = (sql: string, params?: SqlParameter[]) => Promise<Record<string, unknown>[]>;
const str = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });

/** A claim older than this with no written_at belongs to a migrator that died; it may be taken over. */
export const CLAIM_LEASE = "INTERVAL '5 minutes'";

const SELECT_COMMENT = `
  SELECT c.id AS comment_id, c.work_item_id, c.author_id, p.name AS person_name,
         u.id AS user_id, u.display_name AS user_display_name, c.body,
         to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24":"MI":"SS.MS"Z"') AS created_at`;
// The colons in that format are quoted on purpose: an unquoted \`:MI\` reads as a
// \`:name\` placeholder to a parameter scanner (the Data API's, and the test transport's).
// One login per person, chosen deterministically (lowest id) when several link the same person.
const AUTHOR_JOINS = `
  LEFT JOIN people p ON p.id = c.author_id
  LEFT JOIN LATERAL (SELECT a.id, a.display_name FROM app_users a WHERE a.person_id = c.author_id ORDER BY a.id LIMIT 1) u ON TRUE`;

export const CLAIM_SQL = (limit: number) => `
  WITH cand AS (
    SELECT c.id, c.work_item_id
      FROM work_item_comments c
      LEFT JOIN work_item_comment_migrations m ON m.comment_id = c.id
     WHERE NOT c.is_system
       AND (m.comment_id IS NULL OR (m.written_at IS NULL AND m.claimed_at < NOW() - ${CLAIM_LEASE}))
     ORDER BY c.id
     LIMIT ${limit}
  ), claimed AS (
    INSERT INTO work_item_comment_migrations (comment_id, work_item_id, migrator)
    SELECT id, work_item_id, :migrator FROM cand
    ON CONFLICT (comment_id) DO UPDATE SET migrator = EXCLUDED.migrator, claimed_at = NOW()
      WHERE work_item_comment_migrations.written_at IS NULL
        AND work_item_comment_migrations.claimed_at < NOW() - ${CLAIM_LEASE}
    RETURNING comment_id
  )
  ${SELECT_COMMENT}
    FROM claimed k JOIN work_item_comments c ON c.id = k.comment_id
  ${AUTHOR_JOINS}
   ORDER BY c.id`;

export const PENDING_SQL = (limit: number) => `
  ${SELECT_COMMENT}
    FROM work_item_comments c
  ${AUTHOR_JOINS}
   WHERE NOT c.is_system AND c.id > :after
     AND NOT EXISTS (SELECT 1 FROM work_item_comment_migrations m WHERE m.comment_id = c.id AND m.written_at IS NOT NULL)
   ORDER BY c.id
   LIMIT ${limit}`;

export const MARK_WRITTEN_SQL = `
  UPDATE work_item_comment_migrations
     SET written_at = NOW(), channel = :channel, message_id = :message_id
   WHERE comment_id = :comment_id AND migrator = :migrator AND written_at IS NULL`;

function rowToComment(r: Record<string, unknown>): LegacyWorkComment {
  const s = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    commentId: String(r['comment_id']), workItemId: String(r['work_item_id']),
    authorPersonId: s('author_id'), authorPersonName: s('person_name'),
    authorUserId: s('user_id'), authorUserDisplayName: s('user_display_name'),
    body: String(r['body'] ?? ''), createdAt: String(r['created_at']),
  };
}

export function auroraCommentSource(exec: Exec): CommentSource {
  return {
    async claimBatch(migrator, limit) {
      return (await exec(CLAIM_SQL(limit), [str('migrator', migrator)])).map(rowToComment);
    },
    async pending(afterId, limit) {
      return (await exec(PENDING_SQL(limit), [str('after', afterId)])).map(rowToComment);
    },
    async markWritten(commentId, migrator, channel, messageId) {
      await exec(MARK_WRITTEN_SQL, [str('channel', channel), str('message_id', messageId), str('comment_id', commentId), str('migrator', migrator)]);
    },
  };
}

// ── In-memory source (mock / tests) ─────────────────────────────────────────

export interface MemoryLedgerRow { migrator: string; writtenAt: string | null; channel: string | null; messageId: string | null }

/** The same rules over in-process rows: one claim per comment, confirmed on write. */
export function memoryCommentSource(rows: () => LegacyWorkComment[], ledger = new Map<string, MemoryLedgerRow>()): CommentSource & { ledger: Map<string, MemoryLedgerRow> } {
  const ordered = () => [...rows()].sort((a, b) => (a.commentId < b.commentId ? -1 : a.commentId > b.commentId ? 1 : 0));
  return {
    ledger,
    async claimBatch(migrator, limit) {
      const out: LegacyWorkComment[] = [];
      for (const c of ordered()) {
        if (out.length >= limit) break;
        if (ledger.has(c.commentId)) continue;
        ledger.set(c.commentId, { migrator, writtenAt: null, channel: null, messageId: null });
        out.push(c);
      }
      return out;
    },
    async pending(afterId, limit) {
      return ordered().filter((c) => c.commentId > afterId && !ledger.get(c.commentId)?.writtenAt).slice(0, limit);
    },
    async markWritten(commentId, migrator, channel, messageId) {
      const row = ledger.get(commentId);
      if (row && row.migrator === migrator && !row.writtenAt) Object.assign(row, { writtenAt: new Date().toISOString(), channel, messageId });
    },
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<void> {
  const flag = (name: string) => argv.includes(name);
  const value = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const dryRun = flag('--dry-run');
  const batchSize = Number(value('--batch') ?? 100);
  const reportPath = value('--report');
  const { exec } = await import('../providers/aurora.js');
  const { socialChatConfig } = await import('./social-chat.js');
  const cfg = socialChatConfig();
  let target: ThreadTarget;
  if (cfg.store === 'dynamo') {
    const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
    const { DynamoChatStore } = await import('@connorhoehnslalom/realtime-modules/server/stores/dynamo');
    const local = !!cfg.endpoint && process.env['NODE_ENV'] !== 'production';
    const client = new DynamoDBClient({ region: cfg.region, ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
      ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}) });
    target = new DynamoChatStore({ client, tablePrefix: cfg.tablePrefix });
  } else if (dryRun) {
    target = { getMessage: async () => null, putMessage: async () => { throw new Error('dry run'); } };
  } else {
    throw new Error('Refusing to migrate into a process-local memory store: set SOCIAL_CHAT_STORE=dynamo (and its endpoint/prefix)');
  }
  const report = await migrateWorkComments({ source: auroraCommentSource(exec), target, batchSize, dryRun });
  const text = JSON.stringify(report, null, 2);
  if (reportPath) (await import('node:fs')).writeFileSync(reportPath, `${text}\n`);
  process.stdout.write(`${text}\n`);
  if (report.failures.length) process.exitCode = 1;
}

if (process.argv[1] && /migrate-work-comments\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((err: unknown) => { console.error((err as Error).message); process.exitCode = 1; });
}
