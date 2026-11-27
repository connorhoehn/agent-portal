// An interviewer's private notes on a round and their scorecard draft kept on the server (gap audit 2026-11-20 §5;
// middleware routes/interviews/private-notes.ts). Only the author ever reads or writes either; every route answers the
// session's own. Saves are compare-and-set on `revision` (0 for none yet): a save from an older tab is answered 409
// with the copy as it now is, which the page then shows.
import { INTERVIEWS_API } from './interviews.ts';
import { writeJson } from './writeJson.ts';

export const NOTES_PRIVACY_LINE = 'Only you can see these notes.';
/** How long typing pauses before the notes or the draft are saved. */
export const SAVE_DELAY_MS = 800;

export interface MyNotes {
  body: string;
  revision: number;
  updatedAt: string | null;
  canWrite: boolean;
  refusal: string | null;
  limits: { chars: number };
}

export interface ServerDraft { draft: Record<string, unknown>; basedOn: number; revision: number; updatedAt: string }
export interface MyDraft { draft: ServerDraft | null; canWrite: boolean; refusal: string | null }

export const myNotesUrl = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/my-notes`;
export const myDraftUrl = (interviewId: string): string => `${INTERVIEWS_API}/interviews/${encodeURIComponent(interviewId)}/scorecard-draft`;

export type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'stale';

/** The line beside the notes: what happened to the last change, in plain words. */
export function saveStateLine(state: SaveState, refusal: string | null): string {
  if (refusal) return refusal;
  switch (state) {
    case 'saving': return 'Saving…';
    case 'saved': return 'Saved.';
    case 'failed': return 'Not saved. Your notes are still here; they will be saved again when you type.';
    case 'stale': return 'These notes were changed in another window. This shows what was saved there.';
    default: return '';
  }
}
export const saveStateTone = (state: SaveState): 'secondary' | 'danger' => (state === 'failed' || state === 'stale' ? 'danger' : 'secondary');

export type SaveOutcome<T> = { ok: true; value: T } | { ok: false; stale: boolean; value: T | null; error: string };

export async function saveMyNotes(interviewId: string, body: string, revision: number): Promise<SaveOutcome<MyNotes>> {
  const r = await writeJson<{ notes?: MyNotes }>(myNotesUrl(interviewId), 'PUT', { body, revision });
  if (r.ok && r.data?.notes) return { ok: true, value: r.data.notes };
  return { ok: false, stale: r.status === 409, value: r.data?.notes ?? null, error: r.error ?? 'Your notes could not be saved.' };
}

export async function saveServerDraft(interviewId: string, draft: object, basedOn: number, revision: number): Promise<SaveOutcome<MyDraft>> {
  const r = await writeJson<{ draft?: MyDraft }>(myDraftUrl(interviewId), 'PUT', { draft, basedOn, revision });
  if (r.ok && r.data?.draft) return { ok: true, value: r.data.draft };
  return { ok: false, stale: r.status === 409, value: r.data?.draft ?? null, error: r.error ?? 'Your draft could not be saved.' };
}

/**
 * Which draft the scorecard opens with, and whether to upload. The server's copy for this version wins unless the
 * browser's own is newer (it was typed offline); a browser draft the server does not have is uploaded once, against
 * the revision the server holds (0 for none; a server copy for an older version is overwritten).
 */
export function chooseDraft(server: ServerDraft | null, local: { savedAt?: string } | null, basedOn: number):
  { use: 'server' | 'local' | 'none'; upload: boolean; revision: number } {
  const revision = server?.revision ?? 0;
  const current = server && server.basedOn === basedOn ? server : null;
  if (current && (!local || !local.savedAt || Date.parse(current.updatedAt) >= Date.parse(local.savedAt))) return { use: 'server', upload: false, revision };
  if (local) return { use: 'local', upload: true, revision };
  return { use: 'none', upload: false, revision };
}

/** "Use my notes from the interview" is offered when there are notes and the scorecard's summary is still empty. */
export const offersNotes = (notes: Pick<MyNotes, 'body'> | null, summary: string): boolean => !!notes && notes.body.trim() !== '' && summary.trim() === '';
