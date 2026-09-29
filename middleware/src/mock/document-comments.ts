// Document comments as platform-api stores them, for `dev:mock` with no
// platform-api behind the BFF (DOCUMENT_PLATFORM_INTERNAL_URL unset).
//
// The assessment Comments tab moved from the BFF's own Aurora thread
// (`assessment_knowledge_comments`) to platform-api's document comments
// (docs/assessment-documents-parity-plan.md, recommendation C). With the
// social profile running, the BFF proxies to the real service. Without it,
// these rows stand in, in the SAME shape — the item platform-api's
// DocumentCommentRepository writes and `GET /api/documents/:id/comments`
// returns (`{ documentId, commentId, text, userId, displayName, color,
// timestamp, scope?, parentCommentId?, anchor?, resolved?, … }`), captured from
// the running service rather than typed from memory.
//
// Seeded EMPTY on purpose: every row here is either written by a session or
// carried across by the one-time import of the legacy thread
// (providers/document-comment-import.ts), which is the path a real deployment
// takes. Both are undone by POST /api/__mock/reset.

import { defineFixture } from './core/index.js';

export interface PlatformCommentAnchor { v: number; key: string; start: string; end: string; quote: string }

export interface PlatformDocumentComment {
  documentId: string;
  commentId: string;
  text: string;
  userId: string;
  displayName: string;
  color: string;
  timestamp: string;
  /** A root on the whole document (no section, no anchor). */
  scope?: 'document';
  sectionId?: string;
  parentCommentId?: string;
  anchor?: PlatformCommentAnchor;
  anchoredAt?: string;
  resolved?: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  editedAt?: string;
  /** Set only on rows the one-time import wrote: where the row came from. */
  importedFrom?: 'assessment_knowledge_comments';
  /** An imported tombstone that still has replies — the original text is not carried. */
  deletedAt?: string;
}

export const platformDocumentCommentsFixture = defineFixture<PlatformDocumentComment>({
  key: 'assessment-platform-document-comments',
  scenarios: {
    default: () => [],
    empty: () => [],
    error: () => { throw new Error('document-comments table unavailable'); },
  },
});

/** One row per document whose legacy thread has been carried to platform-api. */
export interface DocumentCommentImport {
  document_id: string;
  source_id: string;
  /** Rows written (or found already present) on platform-api. */
  imported: number;
  /** Legacy rows read, including tombstones that were not carried. */
  legacy: number;
  imported_at: string;
}

export const documentCommentImportsFixture = defineFixture<DocumentCommentImport>({
  key: 'assessment-document-comment-imports',
  scenarios: { default: () => [], empty: () => [] },
});
