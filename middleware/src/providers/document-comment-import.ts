// The one-time import of a document's legacy comment thread into
// platform-api's document comments (docs/assessment-documents-parity-goal.md,
// Phase 4; plan gap 4, recommendation C).
//
// What moves, and how:
//
//   assessment_knowledge_comments (BFF Aurora, or the dev:mock fixture)
//     → platform-api `document-comments` (DynamoDB), keyed (documentId, commentId)
//
//   - ids, authors and timestamps are PRESERVED. platform-api's POST route
//     mints a fresh ulid, stamps "now" and takes the author from the caller's
//     grant, so an import through the public route would rewrite every one of
//     them. The import therefore writes the repository's own item shape
//     directly, with a conditional put per row — which is also what makes it
//     idempotent: a second run finds every row present and writes nothing.
//   - a root becomes a document-wide thread (`scope: 'document'`) — the legacy
//     thread never pointed at a sentence, and inventing an anchor for it would
//     be fabricating a claim about which text someone meant. A reply keeps its
//     `parentCommentId`. A reply whose parent is gone becomes a root.
//   - an edit keeps its `editedAt`. A soft-deleted comment is carried only when
//     live replies hang off it, as a tombstone ("This comment was removed.")
//     with `deletedAt` and WITHOUT its original words; one with no replies is
//     not carried at all — there is nothing left of it to preserve.
//   - reactions do not move. platform-api has no reactions on document
//     comments (its reactions route is mounted for room posts only), so they
//     stay in assessment_knowledge_reactions, keyed by the same comment ids —
//     the reason preserving ids is not optional.
//
// When it runs: lazily, the first time a document's comments are read through
// the BFF (providers/document-comments.ts). A document never opened has no
// platform identity to import into yet. The ledger row
// (assessment_document_comment_imports, or its dev:mock fixture) is written
// only after every row landed, and from then on the legacy write routes answer
// 409 rather than writing into a thread nobody reads.
//
// Where it writes:
//   - DOCUMENT_PLATFORM_INTERNAL_URL set → platform-api's DynamoDB table,
//     named by DOCUMENT_COMMENT_IMPORT_TABLE (the table platform-api reads,
//     e.g. `document-comments`, with its DDB_TABLE_PREFIX if it has one) and
//     reached at DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT when that is set
//     (DynamoDB-local on the social profile). Unset table → the import reports
//     `unconfigured` and nothing is written or recorded; the Comments tab says
//     how many earlier comments have not moved.
//   - no platform, dev:mock → the platform-comment fixture, same shape.

import { config } from '../config.js';
import { exec } from './aurora.js';
import * as M from '../mock/assessment.js';
import {
  documentCommentImportsFixture,
  platformDocumentCommentsFixture,
  type PlatformDocumentComment,
} from '../mock/document-comments.js';

export type CommentImportState = 'imported' | 'none' | 'unconfigured' | 'failed';

export interface CommentImportStatus {
  state: CommentImportState;
  /** Rows now on platform-api from the legacy thread. */
  imported: number;
  /** Legacy rows read (tombstones with no replies included, though not carried). */
  legacy: number;
  importedAt?: string;
  reason?: string;
}

/** Same default colour platform-api stamps on a comment it creates. */
const PLATFORM_COMMENT_COLOR = '#4A90D9';
const TOMBSTONE_TEXT = 'This comment was removed.';

/**
 * Aurora returns `created_at::text` as `2026-09-20 10:00:00.123+00`, which
 * `Date` does not reliably parse (and a NAIVE string would be read as local
 * time — the devbox-fleet bug). Normalise to ISO-8601 UTC.
 */
export function isoTimestamp(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value.trim());
  if (m) {
    const zone = !m[3] || m[3] === 'Z' ? 'Z' : m[3].length === 3 ? `${m[3]}:00` : m[3].includes(':') ? m[3] : `${m[3].slice(0, 3)}:${m[3].slice(3)}`;
    const parsed = new Date(`${m[1]}T${m[2]}${zone}`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * The legacy thread as platform-api items. Pure: the caller supplies the
 * canonical document UUID and the display names (identity store).
 */
export function planLegacyCommentImport(
  documentId: string,
  legacy: readonly M.KnowledgeComment[],
  names: ReadonlyMap<string, string>,
): PlatformDocumentComment[] {
  const byId = new Map(legacy.map(c => [c.id, c]));
  const liveReplyParents = new Set(legacy.filter(c => !c.deleted_at && c.parent_id).map(c => c.parent_id as string));
  // A tombstone is kept only while something live hangs beneath it. Walk up so
  // a removed reply that itself has live replies keeps its removed parent too.
  const keep = new Set<string>();
  for (const c of legacy) {
    if (!c.deleted_at || liveReplyParents.has(c.id)) keep.add(c.id);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...keep]) {
      const parent = byId.get(id)?.parent_id;
      if (parent && byId.has(parent) && !keep.has(parent)) { keep.add(parent); grew = true; }
    }
  }
  return legacy
    .filter(c => keep.has(c.id))
    .map((c): PlatformDocumentComment => {
      const parent = c.parent_id && keep.has(c.parent_id) ? c.parent_id : null;
      return {
        documentId,
        commentId: c.id,
        text: c.deleted_at ? TOMBSTONE_TEXT : c.body,
        userId: c.author,
        displayName: names.get(c.author) ?? c.author,
        color: PLATFORM_COMMENT_COLOR,
        timestamp: isoTimestamp(c.created_at),
        ...(parent ? { parentCommentId: parent } : { scope: 'document' as const }),
        ...(c.edited_at && !c.deleted_at ? { editedAt: isoTimestamp(c.edited_at) } : {}),
        ...(c.deleted_at ? { deletedAt: isoTimestamp(c.deleted_at) } : {}),
        importedFrom: 'assessment_knowledge_comments',
      };
    });
}

// ── the ledger ──────────────────────────────────────────────────────────────

const str = (name: string, value: string) => ({ name, value: { stringValue: value } });
const long = (name: string, value: number) => ({ name, value: { longValue: value } });

async function readLedger(documentId: string): Promise<{ imported: number; legacy: number; imported_at: string } | null> {
  if (config.mock.aurora) {
    const row = documentCommentImportsFixture.rows().find(r => r.document_id === documentId);
    return row ? { imported: row.imported, legacy: row.legacy, imported_at: row.imported_at } : null;
  }
  const rows = await exec(`SELECT imported, legacy, imported_at::text AS imported_at
      FROM assessment_document_comment_imports WHERE document_id = CAST(:document AS uuid)`, [str('document', documentId)]);
  const row = rows[0];
  return row ? { imported: Number(row['imported']), legacy: Number(row['legacy']), imported_at: isoTimestamp(String(row['imported_at'])) } : null;
}

async function writeLedger(documentId: string, sourceId: string, imported: number, legacy: number): Promise<string> {
  const now = new Date().toISOString();
  if (config.mock.aurora) {
    const rows = documentCommentImportsFixture.rows();
    const existing = rows.find(r => r.document_id === documentId);
    if (existing) return existing.imported_at;
    rows.push({ document_id: documentId, source_id: sourceId, imported, legacy, imported_at: now });
    return now;
  }
  await exec(`INSERT INTO assessment_document_comment_imports (document_id, source_id, imported, legacy)
      VALUES (CAST(:document AS uuid), :source, :imported, :legacy)
      ON CONFLICT (document_id) DO NOTHING`,
  [str('document', documentId), str('source', sourceId), long('imported', imported), long('legacy', legacy)]);
  return now;
}

/**
 * Has this source's legacy thread moved? The legacy comment write routes ask,
 * so a comment is never written into the thread the Comments tab stopped
 * reading.
 */
export async function legacyThreadMoved(sourceId: string): Promise<boolean> {
  if (config.mock.aurora) return documentCommentImportsFixture.rows().some(r => r.source_id === sourceId);
  try {
    const rows = await exec(`SELECT 1 FROM assessment_document_comment_imports WHERE source_id = :source LIMIT 1`, [str('source', sourceId)]);
    return rows.length > 0;
  } catch {
    // A cluster without the table has imported nothing.
    return false;
  }
}

// ── the writers ─────────────────────────────────────────────────────────────

type Writer = (items: PlatformDocumentComment[]) => Promise<number>;

function mockWriter(): Writer {
  return async (items) => {
    const rows = platformDocumentCommentsFixture.rows();
    for (const item of items) {
      if (!rows.some(r => r.documentId === item.documentId && r.commentId === item.commentId)) rows.push({ ...item });
    }
    return items.length;
  };
}

/** Configured only when the platform table is named; the endpoint is optional (DynamoDB-local). */
export function platformCommentImportTarget(): { table: string; endpoint: string | null } | null {
  const table = process.env['DOCUMENT_COMMENT_IMPORT_TABLE']?.trim();
  if (!table) return null;
  const endpoint = process.env['DOCUMENT_COMMENT_IMPORT_DYNAMODB_ENDPOINT']?.trim() || null;
  return { table, endpoint };
}

function dynamoWriter(target: { table: string; endpoint: string | null }): Writer {
  return async (items) => {
    const { DynamoDBClient, ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb');
    const local = !!target.endpoint && process.env['NODE_ENV'] !== 'production';
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({
      region: process.env['AWS_REGION'] || 'us-east-1',
      ...(target.endpoint ? { endpoint: target.endpoint } : {}),
      // DynamoDB-local accepts any key; never send the operator's real
      // credentials to a loopback emulator.
      ...(local ? { credentials: { accessKeyId: 'local', secretAccessKey: 'local' } } : {}),
    }), { marshallOptions: { removeUndefinedValues: true } });
    let landed = 0;
    for (const item of items) {
      try {
        await client.send(new PutCommand({
          TableName: target.table, Item: item,
          ConditionExpression: 'attribute_not_exists(commentId)',
        }));
      } catch (error) {
        // Already there from an earlier, interrupted run: that row is imported.
        if (!(error instanceof ConditionalCheckFailedException)) throw error;
      }
      landed += 1;
    }
    return landed;
  };
}

async function displayNames(): Promise<Map<string, string>> {
  try {
    const { listUsers } = await import('./identity.js');
    return new Map((await listUsers()).map(u => [u.id, u.displayName]));
  } catch {
    return new Map();
  }
}

/**
 * Carry `sourceId`'s legacy thread to `documentId` once. Safe to call on every
 * read: after the first success it is one ledger lookup.
 */
export async function ensureLegacyCommentsImported(sourceId: string, documentId: string): Promise<CommentImportStatus> {
  const done = await readLedger(documentId);
  if (done) return { state: done.imported > 0 ? 'imported' : 'none', imported: done.imported, legacy: done.legacy, importedAt: done.imported_at };

  const { listKnowledgeComments } = await import('./assessment.js');
  const legacy = (await listKnowledgeComments(sourceId)) ?? [];
  const platform = !!process.env['DOCUMENT_PLATFORM_INTERNAL_URL'];
  let writer: Writer;
  if (platform) {
    const target = platformCommentImportTarget();
    if (!target) {
      // Nothing to move is not a configuration problem.
      if (legacy.length === 0) return { state: 'none', imported: 0, legacy: 0 };
      return { state: 'unconfigured', imported: 0, legacy: legacy.length,
        reason: 'The one-time comment import is not configured (DOCUMENT_COMMENT_IMPORT_TABLE).' };
    }
    writer = dynamoWriter(target);
  } else if (config.mock.aurora) {
    writer = mockWriter();
  } else {
    return { state: 'unconfigured', imported: 0, legacy: legacy.length, reason: 'Document comments are not configured.' };
  }

  const items = planLegacyCommentImport(documentId, legacy, await displayNames());
  try {
    const imported = items.length ? await writer(items) : 0;
    const importedAt = await writeLedger(documentId, sourceId, imported, legacy.length);
    return { state: imported > 0 ? 'imported' : 'none', imported, legacy: legacy.length, importedAt };
  } catch (error) {
    return { state: 'failed', imported: 0, legacy: legacy.length,
      reason: `Earlier comments could not be moved yet: ${error instanceof Error ? error.message : String(error)}` };
  }
}
