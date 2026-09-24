// A work item's acceptance criteria and comment thread — read, plus the
// optimistic writes the detail column makes on them.
//
// Both reads are keyed on the item: switching items must never show the last
// item's checklist for a frame. Writes apply locally first and are confirmed;
// a refusal puts the list back and says why (surfaceWriteError), the same
// contract the work tree's own edits keep.

import { useCallback, useState } from 'react';
import { useFetch } from '../../hooks/useFetch';
import { sendJson } from '../../lib/writeJson';
import { isPendingId, surfaceWriteError } from './writeJson';

/** One acceptance criterion (GET /api/graph/work-items/:id/criteria). */
export interface Criterion {
  id: string;
  workItemId: string;
  text: string;
  done: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
}

/** One row of the item's thread (GET /api/graph/work-items/:id/comments).
 *  `isSystem` rows are audit events — status changes, run settlements. */
export interface ThreadComment {
  id: string;
  workItemId: string;
  authorId: string | null;
  authorName: string | null;
  authorTitle: string | null;
  body: string;
  isSystem: boolean;
  createdAt: string;
}

const base = (id: string) => `/api/graph/work-items/${encodeURIComponent(id)}`;

export function useWorkItemThread(itemId: string | null) {
  // An item the server has not acknowledged has no thread to read yet.
  const live = itemId != null && !isPendingId(itemId);
  const crit = useFetch<{ criteria: Criterion[] }>(live ? `${base(itemId)}/criteria` : null);
  const notes = useFetch<{ comments: ThreadComment[]; total: number }>(live ? `${base(itemId)}/comments` : null);

  // Local edits sit on top of the read, keyed by item so they never leak.
  const [critLocal, setCritLocal] = useState<{ key: string; rows: Criterion[] } | null>(null);
  const [notesLocal, setNotesLocal] = useState<{ key: string; rows: ThreadComment[] } | null>(null);

  const criteria = critLocal && critLocal.key === itemId ? critLocal.rows : crit.data?.criteria ?? [];
  const comments = notesLocal && notesLocal.key === itemId ? notesLocal.rows : notes.data?.comments ?? [];

  const writeCriteria = useCallback(async (
    next: Criterion[],
    send: () => Promise<Criterion | null>,
    what: string,
    /** The local id the saved row replaces — a new criterion's temp id. */
    replaceId?: string,
  ) => {
    if (!itemId) return;
    const before = criteria;
    setCritLocal({ key: itemId, rows: next });
    try {
      const saved = await send();
      if (saved) {
        setCritLocal((cur) => (cur && cur.key === itemId
          ? { key: itemId, rows: cur.rows.map((r) => (r.id === (replaceId ?? saved.id) ? saved : r)) }
          : cur));
      }
    } catch (err) {
      setCritLocal({ key: itemId, rows: before });
      surfaceWriteError(err, what);
    }
  }, [itemId, criteria]);

  const renumber = (rows: Criterion[]) => rows.map((r, i) => ({ ...r, position: i }));

  const toggle = useCallback((id: string, done: boolean) => {
    if (!itemId) return;
    void writeCriteria(
      criteria.map((c) => (c.id === id ? { ...c, done } : c)),
      () => sendJson<Criterion>(`${base(itemId)}/criteria/${encodeURIComponent(id)}`, 'PATCH', { done }),
      'Ticking this criterion',
    );
  }, [itemId, criteria, writeCriteria]);

  const add = useCallback((text: string) => {
    if (!itemId) return;
    const now = new Date().toISOString();
    const draft: Criterion = { id: `tmp-${Date.now()}`, workItemId: itemId, text, done: false, position: criteria.length, createdAt: now, updatedAt: now };
    void writeCriteria(
      [...criteria, draft],
      () => sendJson<Criterion>(`${base(itemId)}/criteria`, 'POST', { text }),
      'Adding this criterion',
      draft.id,
    );
  }, [itemId, criteria, writeCriteria]);

  const edit = useCallback((id: string, text: string) => {
    if (!itemId) return;
    void writeCriteria(
      criteria.map((c) => (c.id === id ? { ...c, text } : c)),
      () => sendJson<Criterion>(`${base(itemId)}/criteria/${encodeURIComponent(id)}`, 'PATCH', { text }),
      'Editing this criterion',
    );
  }, [itemId, criteria, writeCriteria]);

  const remove = useCallback((id: string) => {
    if (!itemId) return;
    void writeCriteria(
      renumber(criteria.filter((c) => c.id !== id)),
      async () => { await sendJson<unknown>(`${base(itemId)}/criteria/${encodeURIComponent(id)}`, 'DELETE'); return null; },
      'Removing this criterion',
    );
  }, [itemId, criteria, writeCriteria]);

  const move = useCallback((id: string, toIndex: number) => {
    if (!itemId) return;
    const rows = criteria.filter((c) => c.id !== id);
    const moving = criteria.find((c) => c.id === id);
    if (!moving) return;
    rows.splice(toIndex, 0, moving);
    void writeCriteria(
      renumber(rows),
      async () => { await sendJson<Criterion>(`${base(itemId)}/criteria/${encodeURIComponent(id)}`, 'PATCH', { position: toIndex }); return null; },
      'Moving this criterion',
    );
  }, [itemId, criteria, writeCriteria]);

  /** Post a comment. Resolves true once the server has it, so the composer
   *  can keep the draft when it did not. */
  const postComment = useCallback(async (body: string): Promise<boolean> => {
    if (!itemId) return false;
    try {
      const saved = await sendJson<ThreadComment>(`${base(itemId)}/comments`, 'POST', { body });
      setNotesLocal({ key: itemId, rows: [...comments, saved] });
      return true;
    } catch (err) {
      surfaceWriteError(err, 'Posting this comment');
      return false;
    }
  }, [itemId, comments]);

  /** Re-read the thread — after a write elsewhere (a status move) added an
   *  audit row the local copy has never seen. */
  const { refresh: refreshNotes } = notes;
  const refreshComments = useCallback(() => {
    setNotesLocal(null);
    refreshNotes();
  }, [refreshNotes]);

  const humanComments = comments.filter((c) => !c.isSystem);
  return {
    criteria: [...criteria].sort((a, b) => a.position - b.position),
    criteriaLoading: live && crit.isLoading && !crit.data,
    criteriaError: crit.error,
    comments,
    commentCount: humanComments.length,
    commentsLoading: live && notes.isLoading && !notes.data,
    commentsError: notes.error,
    toggle, add, edit, remove, move, postComment, refreshComments,
  };
}

export type WorkItemThread = ReturnType<typeof useWorkItemThread>;
