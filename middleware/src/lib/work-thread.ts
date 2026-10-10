// A work item's conversation is ONE store: the gateway chat thread
// `orgiq:work:<id>` (lib/tenant-channels.ts family `orgiq:work`). This module is
// the pure half of that rule — the channel name, and how a legacy
// `work_item_comments` row becomes a message on it — shared by the one-time
// migration (lib/migrate-work-comments.ts), the mock fixture that derives the
// thread's seeded history (mock/social-channels.ts) and the REST write path
// (providers/work-items.ts createWorkItemComment). No I/O here.
//
// Identity: a message's sender is stamped by the SERVER from directory rows —
// the author's linked app user (`app_users.person_id`) and its display name, or,
// for a person with no login, the person's directory name with no userId (the
// library's deleted-sender rule: a row names its sender by userId, or by the
// name it carries, never by a socket client id). Nothing in a comment's body or
// any free-text column is ever read as identity.

import { createHash, randomBytes } from 'node:crypto';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/chat';

export const WORK_THREAD_PREFIX = 'orgiq:work:';
export const MIGRATED_FROM = 'work_item_comments';

export function workThreadChannel(workItemId: string): string {
  return `${WORK_THREAD_PREFIX}${workItemId}`;
}

/** One human `work_item_comments` row with its author resolved from the directory. */
export interface LegacyWorkComment {
  commentId: string;
  workItemId: string;
  /** people.id; null when the person row was deleted (ON DELETE SET NULL). */
  authorPersonId: string | null;
  /** people.name — the directory's name, used only when no login is linked. */
  authorPersonName: string | null;
  /** app_users.id linked to the person, when one exists. */
  authorUserId: string | null;
  /** app_users.display_name of that user. */
  authorUserDisplayName: string | null;
  body: string;
  /** ISO-8601 UTC. */
  createdAt: string;
}

/**
 * The thread message id for a migrated comment. The library's DynamoDB table
 * sorts a channel by `messageId`, and its own ids are `Date.now().toString(36)`
 * plus a suffix, so the prefix is the comment's own instant: the history keeps
 * its order among live messages. The suffix is a digest of the comment id, so
 * the id is a pure function of the comment — the idempotency key every write
 * lands on, whichever migrator writes it, however many times.
 */
export function migratedMessageId(commentId: string, createdAt: string): string {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) throw new Error(`comment ${commentId} has no valid created_at`);
  return `${ms.toString(36)}wic${createHash('sha256').update(commentId).digest('hex').slice(0, 20)}`;
}

/** A fresh message id in the library's shape, for a server-side write at `at`. */
export function liveMessageId(at: string): string {
  return `${Date.parse(at).toString(36)}${randomBytes(6).toString('hex')}`;
}

/** The thread message a legacy comment becomes. Provenance rides in metadata. */
export function legacyCommentMessage(c: LegacyWorkComment): ChatMessage {
  const linked = !!c.authorUserId;
  const displayName = linked ? (c.authorUserDisplayName ?? c.authorPersonName) : c.authorPersonName;
  const metadata: Record<string, unknown> = {
    migratedFrom: MIGRATED_FROM,
    commentId: c.commentId,
    ...(displayName ? { displayName } : {}),
    ...(c.authorPersonId ? { authorPersonId: c.authorPersonId } : {}),
    ...(linked ? {} : { unlinkedAuthor: true }),
  };
  return {
    id: migratedMessageId(c.commentId, c.createdAt),
    clientId: 'migration',
    ...(linked ? { userId: c.authorUserId! } : {}),
    channel: workThreadChannel(c.workItemId),
    message: c.body,
    metadata,
    timestamp: new Date(Date.parse(c.createdAt)).toISOString(),
  };
}

/** The message a REST write (POST /api/graph/work-items/:id/comments) puts on the thread. */
export function restCommentMessage(input: {
  workItemId: string; userId: string; displayName: string; personId: string; body: string; at: string;
}): ChatMessage {
  return {
    id: liveMessageId(input.at),
    clientId: 'rest',
    userId: input.userId,
    channel: workThreadChannel(input.workItemId),
    message: input.body,
    metadata: { displayName: input.displayName, authorPersonId: input.personId },
    timestamp: input.at,
  };
}
