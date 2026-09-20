import { useEffect, useMemo, useState } from 'react';
import { useFetch } from '../../../hooks/useFetch';
import { sendJson } from '../../../lib/writeJson';
import { applyCommentUpdates, commentsForDoc, retainCommentUpdates, withStoredComments, type KnowledgeCommentItem, type StoredReaction } from './knowledgeFormat';
import type { AssessmentSSEEvent } from './types';

interface StoredCommentWire {
  id: string; doc_id: string; body: string; author: string; created_at: string;
  edited_at?: string | null; deleted_at?: string | null; parent_id?: string | null;
}

/** Existing BFF records keep their IDs, authors, replies and reactions during canvas migration. */
export function useKnowledgeDocumentThread(id: string, events: AssessmentSSEEvent[], connected: boolean, gapped: boolean) {
  const stored = useFetch<{ comments: StoredCommentWire[] }>(`/api/assessment/knowledge/doc/comments?id=${encodeURIComponent(id)}`);
  const reactions = useFetch<{ reactions: StoredReaction[] }>(`/api/assessment/knowledge/doc/reactions?id=${encodeURIComponent(id)}`);
  const [error, setError] = useState<string | null>(null);
  const live = useMemo(() => commentsForDoc(events, id), [events, id]);
  const rows = useMemo<KnowledgeCommentItem[]>(() => (stored.data?.comments ?? []).filter(c => c.doc_id === id).map(c => ({
    id: c.id, clientId: c.author, userId: c.author, displayName: c.author, content: c.body, timestamp: c.created_at,
    ...(c.parent_id ? { parentId: c.parent_id } : {}), ...(c.edited_at ? { editedAt: c.edited_at } : {}), ...(c.deleted_at ? { deletedAt: c.deleted_at } : {}),
  })), [stored.data, id]);
  const [state, setState] = useState<{ id: string; rows: KnowledgeCommentItem[] }>({ id, rows: [] });
  useEffect(() => {
    setState(previous => ({ id, rows: applyCommentUpdates(retainCommentUpdates(previous.id === id ? previous.rows : [], withStoredComments(rows, live)), events, id) }));
  }, [rows, live, events, id]);
  const latest = events.filter(event => (event.type === 'knowledge.comment.created' || event.type === 'knowledge.comment.edited' || event.type === 'knowledge.comment.deleted') && event.doc_id === id).at(-1);
  useEffect(() => {
    if (connected || gapped) { stored.refresh(); reactions.refresh(); }
    // Refresh callbacks are not event triggers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, connected, gapped, latest]);
  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
    setError(null);
    try { await sendJson('/api/assessment/knowledge/doc/comment', method, body); stored.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Comment could not be saved.'); throw cause; }
  }
  async function react(targetId: string, emoji: string) {
    try { await sendJson('/api/assessment/knowledge/doc/reaction', 'POST', { id, targetId, emoji }); reactions.refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Reaction could not be saved.'); }
  }
  return {
    comments: state.id === id ? state.rows : [], reactions: reactions.data?.reactions ?? [],
    error: error ?? stored.error ?? reactions.error, clearError: () => setError(null),
    send: (body: string, parentId?: string) => mutate('POST', { id, body, parentId }),
    edit: (message: { id?: string }, body: string) => message.id ? mutate('PATCH', { commentId: message.id, body }) : Promise.resolve(),
    remove: (message: { id?: string }) => message.id ? mutate('DELETE', { commentId: message.id }) : Promise.resolve(), react,
  };
}
