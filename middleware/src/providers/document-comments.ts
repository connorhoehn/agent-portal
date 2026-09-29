// Assessment document comments on platform-api threads
// (docs/assessment-documents-parity-goal.md, Phase 4; plan gap 4).
//
// The Comments tab and the canvas margin read the same threads the
// realtime-examples editor reads: platform-api's document comments —
// document-wide (`scope: 'document'`) and anchored (a Y.js relative position
// on a span of the page), with replies and resolve. The browser never holds a
// platform credential: it names a SOURCE id, and the BFF resolves the canonical
// document UUID and calls platform-api with its own short-lived, revocable
// document grant (providers/document-workflows.ts). The grant's `comment`
// operation is granted to every assessment reader, so commenting follows
// reading, as it does upstream.
//
// Backends, in order:
//   - DOCUMENT_PLATFORM_INTERNAL_URL set → platform-api, through the grant.
//   - dev:mock without a platform-api → the platform-comment fixture
//     (mock/document-comments.ts), in the same item shape and under the same
//     rules (scope/section/anchor/parent exclusivity, author-only edits, the
//     author deletes), so the tab behaves identically offline.
//   - neither → 503.
//
// Before the first read of a document the legacy Aurora thread is carried
// across once (providers/document-comment-import.ts). Display names come from
// the identity store: platform-api records a grant's `sub` as the display name
// (a grant carries no email), which would show "u-farah" on every card.

import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import type { Session } from '../lib/session.js';
import { assessmentBroker } from '../lib/assessment-broker.js';
import { getKnowledgeDoc } from './assessment.js';
import { documentSourceRevision, ensureDocumentMapping } from './document-mapping.js';
import { DocumentWorkflowError, performDocumentWorkflow } from './document-workflows.js';
import { ensureLegacyCommentsImported, type CommentImportStatus } from './document-comment-import.js';
import { platformDocumentCommentsFixture, type PlatformDocumentComment, type PlatformCommentAnchor } from '../mock/document-comments.js';

export type { PlatformDocumentComment } from '../mock/document-comments.js';
export type CommentsBackend = 'platform' | 'mock' | 'none';

export function documentCommentsBackend(): CommentsBackend {
  if (process.env['DOCUMENT_PLATFORM_INTERNAL_URL']) return 'platform';
  if (config.mock.aurora) return 'mock';
  return 'none';
}

export interface DocumentCommentsList {
  documentId: string;
  comments: PlatformDocumentComment[];
  import: CommentImportStatus;
}

export interface DocumentCommentResult { status: number; body: Record<string, unknown> }

const MAX_TEXT = 10_000;
const MAX_ANCHOR_POSITION = 2048;
const MAX_QUOTE = 500;
const PLATFORM_COMMENT_COLOR = '#4A90D9';
const MAX_PAGES = 10;

function fields(body: unknown, allowed: string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !allowed.includes(key))) throw new DocumentWorkflowError(400, 'Invalid comment fields');
  return body as Record<string, unknown>;
}

function commentId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\\/\u0000-\u001f]/.test(value) || value === '.' || value === '..') {
    throw new DocumentWorkflowError(400, 'Invalid comment id');
  }
  return value;
}

/** platform-api's anchor rule (routes/documentComments.ts parseAnchor), mirrored for the mock backend. */
function parseAnchor(value: unknown): PlatformCommentAnchor | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new DocumentWorkflowError(400, 'anchor must be an object');
  const { v, key, start, end, quote } = value as Record<string, unknown>;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new DocumentWorkflowError(400, 'anchor.v must be a positive integer version');
  if (typeof key !== 'string' || !key.trim()) throw new DocumentWorkflowError(400, 'anchor.key is required');
  for (const [name, position] of [['start', start], ['end', end]] as const) {
    if (typeof position !== 'string' || !position) throw new DocumentWorkflowError(400, `anchor.${name} is required`);
    if (position.length > MAX_ANCHOR_POSITION) throw new DocumentWorkflowError(400, `anchor.${name} is too long`);
  }
  if (typeof quote !== 'string') throw new DocumentWorkflowError(400, 'anchor.quote must be a string');
  return { v, key: key.trim(), start: start as string, end: end as string, quote: quote.slice(0, MAX_QUOTE) };
}

async function names(): Promise<Map<string, string>> {
  try {
    const { listUsers } = await import('./identity.js');
    return new Map((await listUsers()).map(u => [u.id, u.displayName]));
  } catch {
    return new Map();
  }
}

function named(comment: PlatformDocumentComment, directory: ReadonlyMap<string, string>): PlatformDocumentComment {
  const known = directory.get(comment.userId);
  return known && (comment.displayName === comment.userId || !comment.displayName) ? { ...comment, displayName: known } : comment;
}

async function resolveSource(sourceId: string) {
  const source = await getKnowledgeDoc(sourceId);
  if (!source) throw new DocumentWorkflowError(404, 'Document not found');
  return source;
}

/** The canonical UUID without minting a grant — the same mapping the canvas uses. */
async function canonicalDocumentId(sourceId: string): Promise<string> {
  const source = await resolveSource(sourceId);
  const mapping = await ensureDocumentMapping(source.id, documentSourceRevision(source.markdown));
  return mapping.document_id;
}

function requireBackend(): Exclude<CommentsBackend, 'none'> {
  const backend = documentCommentsBackend();
  if (backend === 'none') throw new DocumentWorkflowError(503, 'Document comments are not configured');
  return backend;
}

function byTime(a: PlatformDocumentComment, b: PlatformDocumentComment): number {
  return a.timestamp.localeCompare(b.timestamp) || a.commentId.localeCompare(b.commentId);
}

/** Every thread on the document, oldest first, after the one-time legacy import. */
export async function listDocumentComments(sourceId: string, session: Session): Promise<DocumentCommentsList> {
  requireBackend();
  const documentId = await canonicalDocumentId(sourceId);
  const imported = await ensureLegacyCommentsImported(sourceId, documentId);
  const [comments, directory] = await Promise.all([readComments(sourceId, session, documentId), names()]);
  return { documentId, comments: comments.map(c => named(c, directory)).sort(byTime), import: imported };
}

/** The platform rows as they are — no import, no names. */
async function readComments(sourceId: string, session: Session, documentId: string): Promise<PlatformDocumentComment[]> {
  if (requireBackend() === 'mock') {
    return platformDocumentCommentsFixture.rows().filter(c => c.documentId === documentId).map(c => ({ ...c }));
  }
  const comments: PlatformDocumentComment[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await performDocumentWorkflow(sourceId, session, { kind: 'comments', method: 'GET', ...(cursor ? { cursor } : {}) });
    if (result.status !== 200) throw new DocumentWorkflowError(result.status, typeof result.body['error'] === 'string' ? result.body['error'] : 'Document comments are unavailable');
    const pageRows = Array.isArray(result.body['comments']) ? result.body['comments'] as PlatformDocumentComment[] : [];
    comments.push(...pageRows);
    cursor = typeof result.body['nextCursor'] === 'string' ? result.body['nextCursor'] : undefined;
    if (!cursor) break;
  }
  return comments;
}

function publish(event: 'created' | 'edited' | 'deleted', sourceId: string, comment: { commentId: string; text?: string; parentCommentId?: string }, actor: string): void {
  const ts = new Date().toISOString();
  // The same broker events the legacy thread emitted, so GET /events nudges
  // every viewer of the document to re-read its comments.
  if (event === 'created') assessmentBroker.publish({ type: 'knowledge.comment.created', id: comment.commentId, doc_id: sourceId, parent_id: comment.parentCommentId ?? null, by: actor, body: comment.text ?? '', ts });
  else if (event === 'edited') assessmentBroker.publish({ type: 'knowledge.comment.edited', id: comment.commentId, doc_id: sourceId, by: actor, body: comment.text ?? '', ts });
  else assessmentBroker.publish({ type: 'knowledge.comment.deleted', id: comment.commentId, doc_id: sourceId, by: actor, ts });
}

/** A document-wide root, an anchored root, or a reply. */
export async function createDocumentComment(sourceId: string, session: Session, raw: unknown): Promise<DocumentCommentResult> {
  const backend = requireBackend();
  const body = fields(raw, ['text', 'parentCommentId', 'anchor', 'scope', 'sectionId']);
  const documentId = await canonicalDocumentId(sourceId);
  // A reply to an imported thread needs its parent on platform-api first.
  await ensureLegacyCommentsImported(sourceId, documentId);
  const directory = await names();
  if (backend === 'platform') {
    const result = await performDocumentWorkflow(sourceId, session, { kind: 'comment-create', method: 'POST', body });
    const comment = result.body['comment'] as PlatformDocumentComment | undefined;
    if (result.status === 201 && comment) {
      publish('created', sourceId, comment, session.sub);
      return { status: 201, body: { comment: named(comment, directory), documentId } };
    }
    return result;
  }
  // Mock backend — platform-api's rules, in platform-api's words.
  const sectionId = typeof body['sectionId'] === 'string' && body['sectionId'].trim() ? body['sectionId'].trim() : undefined;
  const anchor = parseAnchor(body['anchor']);
  const scope = body['scope'];
  const parentCommentId = body['parentCommentId'];
  if (scope !== undefined && scope !== 'document') throw new DocumentWorkflowError(400, 'scope must be document when supplied');
  if (scope === 'document' && (sectionId || anchor || parentCommentId)) throw new DocumentWorkflowError(400, 'document scope cannot also specify a section, anchor or parent');
  if (!sectionId && !anchor && !parentCommentId && scope !== 'document') throw new DocumentWorkflowError(400, 'one of sectionId, anchor, parentCommentId or scope:document is required');
  const rows = platformDocumentCommentsFixture.rows();
  if (parentCommentId !== undefined) {
    if (typeof parentCommentId !== 'string' || !parentCommentId.trim()) throw new DocumentWorkflowError(400, 'parentCommentId must be a non-empty string');
    if (!rows.some(r => r.documentId === documentId && r.commentId === parentCommentId)) throw new DocumentWorkflowError(404, 'Parent comment not found in this document');
  }
  const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
  if (!text || text.length > MAX_TEXT) throw new DocumentWorkflowError(400, 'text is required (max 10000 chars)');
  const comment: PlatformDocumentComment = {
    documentId, commentId: mockCommentId(), text, userId: session.sub, displayName: session.sub,
    color: PLATFORM_COMMENT_COLOR, timestamp: new Date().toISOString(),
    ...(sectionId ? { sectionId } : {}),
    ...(typeof parentCommentId === 'string' ? { parentCommentId } : {}),
    ...(anchor ? { anchor } : {}),
    ...(scope === 'document' ? { scope: 'document' as const } : {}),
  };
  rows.push(comment);
  publish('created', sourceId, comment, session.sub);
  return { status: 201, body: { comment: named({ ...comment }, directory), documentId } };
}

/** Resolve / unresolve a thread, edit its text (author only), or re-anchor a root. */
export async function updateDocumentComment(sourceId: string, session: Session, rawId: unknown, raw: unknown): Promise<DocumentCommentResult> {
  const backend = requireBackend();
  const id = commentId(rawId);
  const body = fields(raw, ['resolved', 'text', 'anchor']);
  // Resolving an imported thread needs it on platform-api first.
  const documentId = await canonicalDocumentId(sourceId);
  await ensureLegacyCommentsImported(sourceId, documentId);
  const directory = await names();
  if (backend === 'platform') {
    const result = await performDocumentWorkflow(sourceId, session, { kind: 'comment-update', method: 'PATCH', commentId: id, body });
    const comment = result.body['comment'] as PlatformDocumentComment | undefined;
    if (result.status === 200 && comment && body['text'] !== undefined) publish('edited', sourceId, comment, session.sub);
    return result.status === 200 && comment && comment.userId ? { status: 200, body: { ...result.body, comment: named(comment, directory) } } : result;
  }
  const existing = platformDocumentCommentsFixture.rows().find(r => r.documentId === documentId && r.commentId === id);
  if (!existing) throw new DocumentWorkflowError(404, 'Comment not found');
  const { resolved, text, anchor } = body;
  if (anchor !== undefined) {
    if (text !== undefined || resolved !== undefined) throw new DocumentWorkflowError(400, 'Re-anchor in its own request');
    if (existing.parentCommentId) throw new DocumentWorkflowError(400, 'A reply is positioned by its thread and has no anchor');
    const parsed = parseAnchor(anchor);
    if (!parsed) throw new DocumentWorkflowError(400, 'anchor is required');
    if (existing.userId !== session.sub) throw new DocumentWorkflowError(403, 'Only the author or the document owner may move a comment');
    existing.anchor = parsed; existing.anchoredAt = new Date().toISOString(); delete existing.scope;
    return { status: 200, body: { comment: named({ ...existing }, directory), documentId } };
  }
  if (text !== undefined) {
    if (existing.userId !== session.sub) throw new DocumentWorkflowError(403, 'Only the author may edit comment text');
    if (typeof text !== 'string' || !text.trim() || text.trim().length > MAX_TEXT) throw new DocumentWorkflowError(400, 'text is required (max 10000 chars)');
    if (resolved !== undefined) throw new DocumentWorkflowError(400, 'Edit text and resolve in separate requests');
    existing.text = text.trim(); existing.editedAt = new Date().toISOString();
    publish('edited', sourceId, existing, session.sub);
    return { status: 200, body: { comment: named({ ...existing }, directory), documentId } };
  }
  if (typeof resolved !== 'boolean') throw new DocumentWorkflowError(400, 'resolved (boolean) or text is required');
  const now = new Date().toISOString();
  if (resolved) { existing.resolved = true; existing.resolvedBy = session.sub; existing.resolvedAt = now; }
  else { delete existing.resolved; delete existing.resolvedBy; delete existing.resolvedAt; }
  // The shape platform-api answers a resolve with, plus the bridge's documentId.
  return { status: 200, body: { comment: { documentId, commentId: id, resolved, ...(resolved ? { resolvedBy: session.sub, resolvedAt: now } : {}) }, documentId } };
}

/** The author removes their comment (the document owner, upstream, as well). */
export async function deleteDocumentComment(sourceId: string, session: Session, rawId: unknown): Promise<DocumentCommentResult> {
  const backend = requireBackend();
  const id = commentId(rawId);
  const documentId = await canonicalDocumentId(sourceId);
  await ensureLegacyCommentsImported(sourceId, documentId);
  if (backend === 'platform') {
    const result = await performDocumentWorkflow(sourceId, session, { kind: 'comment-delete', method: 'DELETE', commentId: id });
    if (result.status === 204) publish('deleted', sourceId, { commentId: id }, session.sub);
    return result;
  }
  const rows = platformDocumentCommentsFixture.rows();
  const at = rows.findIndex(r => r.documentId === documentId && r.commentId === id);
  if (at < 0) throw new DocumentWorkflowError(404, 'Comment not found');
  if (rows[at]!.userId !== session.sub) throw new DocumentWorkflowError(403, 'Only the author or the document owner may delete a comment');
  rows.splice(at, 1);
  publish('deleted', sourceId, { commentId: id }, session.sub);
  return { status: 204, body: {} };
}

/**
 * Comment ids a reaction may target on this document, for the reactions
 * routes: they validate a target against the legacy thread, and a comment
 * written since the move exists only here. Never throws — an unreachable
 * backend adds no targets.
 */
export async function documentCommentTargetIds(sourceId: string, session: Session): Promise<string[]> {
  try {
    // Reading reactions never triggers the import: imported comments keep
    // their legacy ids, which the legacy target list already covers.
    if (documentCommentsBackend() === 'none') return [];
    return (await readComments(sourceId, session, await canonicalDocumentId(sourceId))).map(c => c.commentId);
  } catch {
    return [];
  }
}

/** Sortable like platform-api's ulids (time first), distinguishable from them. */
function mockCommentId(): string {
  return `${Date.now().toString(36).padStart(10, '0').toUpperCase()}${randomBytes(8).toString('hex').toUpperCase()}`;
}
