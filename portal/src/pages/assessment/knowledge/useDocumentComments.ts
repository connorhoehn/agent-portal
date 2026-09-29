// The document's comments on platform-api threads, through the BFF.
//
// realtime-examples calls platform-api's `/api/documents/:id/comments` from the
// browser with the user's own token. Here the browser holds no platform
// credential: it names the SOURCE id and the BFF answers with the canonical
// document's threads, calling platform-api with its own document grant
// (middleware providers/document-comments.ts). The library's
// `useDocumentComments` has no transport seam to do the same yet — a
// `fetcher` / `commentsPath` option is on a ui-components branch
// (feat/document-comments-transport), unreleased — so this hook is that
// transport until the library ships it.
//
// Freshness: every write re-reads; other viewers' writes arrive as the
// `knowledge.comment.*` events the BFF publishes on GET /events (the pane's
// SSE feed), and a slow poll covers a resolve (which has no event of its own)
// and a dropped stream.
//
// Reactions stay where they were — the BFF's own store, keyed by comment id
// (platform-api has no reactions on document comments). Imported comments
// kept their ids, so their earlier reactions still line up.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFetch } from '../../../hooks/useFetch';
import { sendJson } from '../../../lib/writeJson';
import { commentThreads, openThreadCount, type DocumentCommentsResponse, type PlatformCommentAnchor } from './documentCommentsModel';
import type { StoredReaction } from './knowledgeFormat';
import type { AssessmentSSEEvent } from './types';

const POLL_MS = 15_000;
const COMMENT_EVENTS = new Set(['knowledge.comment.created', 'knowledge.comment.edited', 'knowledge.comment.deleted', 'knowledge.reaction.toggled']);

export function useDocumentComments(sourceId: string, events: readonly AssessmentSSEEvent[]) {
  const base = `/api/assessment/knowledge/doc/workflows/comments?id=${encodeURIComponent(sourceId)}`;
  const list = useFetch<DocumentCommentsResponse>(base, POLL_MS);
  const reactions = useFetch<{ reactions: StoredReaction[] }>(`/api/assessment/knowledge/doc/reactions?id=${encodeURIComponent(sourceId)}`, POLL_MS);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const latest = useMemo(() => [...events].reverse().find(e => COMMENT_EVENTS.has(e.type) && (e as { doc_id?: string }).doc_id === sourceId), [events, sourceId]);
  const { refresh: refreshList } = list;
  const { refresh: refreshReactions } = reactions;
  useEffect(() => {
    if (!latest) return;
    refreshList(); refreshReactions();
  }, [latest, refreshList, refreshReactions]);

  const threads = useMemo(() => commentThreads(list.data?.comments ?? []), [list.data]);

  const write = useCallback(async (run: () => Promise<unknown>) => {
    setError(null); setPending(true);
    try { await run(); refreshList(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The comment could not be saved.'); throw cause; }
    finally { setPending(false); }
  }, [refreshList]);

  const at = (commentId?: string) => commentId
    ? `/api/assessment/knowledge/doc/workflows/comments/${encodeURIComponent(commentId)}?id=${encodeURIComponent(sourceId)}`
    : base;

  return {
    threads,
    openCount: openThreadCount(threads),
    loading: list.isLoading && !list.data,
    importStatus: list.data?.import,
    documentId: list.data?.documentId ?? null,
    reactions: reactions.data?.reactions ?? [],
    error: error ?? list.error,
    clearError: () => setError(null),
    pending,
    /** A thread on the whole document. */
    addDocumentComment: (text: string) => write(() => sendJson(at(), 'POST', { text, scope: 'document' })),
    /** A thread pinned to the text the anchor names. */
    addAnchoredComment: (text: string, anchor: PlatformCommentAnchor) => write(() => sendJson(at(), 'POST', { text, anchor })),
    reply: (parentCommentId: string, text: string) => write(() => sendJson(at(), 'POST', { text, parentCommentId })),
    resolve: (commentId: string, resolved: boolean) => write(() => sendJson(at(commentId), 'PATCH', { resolved })),
    react: async (targetId: string, emoji: string) => {
      try { await sendJson('/api/assessment/knowledge/doc/reaction', 'POST', { id: sourceId, targetId, emoji }); refreshReactions(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : 'The reaction could not be saved.'); }
    },
    refresh: () => { refreshList(); refreshReactions(); },
  };
}

export type DocumentCommentsState = ReturnType<typeof useDocumentComments>;
