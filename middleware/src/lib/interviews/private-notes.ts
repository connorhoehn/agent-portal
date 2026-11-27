// An interviewer's private notes on one round, and their scorecard draft kept on the server (gap audit 2026-11-20,
// section 5). Pure: the rules the routes (routes/interviews/private-notes.ts) apply before they call the store.
//
//   Notes   one plain text per seat per interview, at most NOTE_LIMITS.chars characters. Only its author ever reads or
//           writes it: no lead, recruiter, hiring manager or admin reads another person's notes, and nothing else in the
//           tenant (the record, the debrief, the export, Milo) reads them. Writable from when the round can be prepared
//           (accepted) until the author's scorecard for the round is in; after that, and on a round that did not go
//           ahead (cancelled, declined), they stay readable to the author and are not changed again.
//   Draft   what the scorecard form holds before Submit, per author per interview, as the page keeps it (an object the
//           server does not interpret beyond its size), with `basedOn`, the version the draft corrects (0 for a first
//           scorecard). Writable while the author may submit (scorecard.ts stateRefusal); deleted when they submit.
//
// Both are compare-and-set on their own revision (0 for "none yet"): a save from a second tab made against an older
// revision is `stale` and answers the copy as it now is.
//
// Retention: both are erased with the media (retention/erasers.ts), so a candidate's deletion request removes them at
// once, and the media period removes them otherwise. They are working material, not the record: the scorecard is.

import type { InterviewState } from './types.js';

export const NOTE_LIMITS = { chars: 10_000 } as const;
/** A serialized draft: well above a full scorecard (SCORECARD_LIMITS) and its per-competency notes. */
export const DRAFT_LIMITS = { bytes: 64_000 } as const;

export interface PrivateNote {
  interviewId: string;
  authorId: string;
  body: string;
  revision: number;
  updatedAt: string;
}

export interface ScorecardDraft {
  interviewId: string;
  authorId: string;
  /** The version of the author's scorecard this draft corrects; 0 for a first scorecard. */
  basedOn: number;
  draft: Record<string, unknown>;
  revision: number;
  updatedAt: string;
}

const NOTE_STATES: ReadonlySet<InterviewState> = new Set(['accepted', 'ready', 'live', 'ended']);

/** Why the author may not change their notes now, in one sentence; null when they may. `hasOwnScorecard`: any version is in. */
export function noteRefusal(state: InterviewState, hasOwnScorecard: boolean): string | null {
  if (state === 'cancelled' || state === 'declined') return 'This round did not go ahead, so these notes can no longer be changed.';
  if (hasOwnScorecard || state === 'scored' || state === 'reviewed') return 'Your scorecard for this round is in, so these notes can no longer be changed.';
  if (!NOTE_STATES.has(state)) return 'You can write notes once everyone on this round has accepted it.';
  return null;
}

type Checked<T> = { ok: true; value: T } | { ok: false; message: string; field: string };

const revisionOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** `{ body, revision }`: plain text up to the limit, and the revision the page read (0 for none). */
export function checkNoteSave(body: unknown): Checked<{ body: string; revision: number }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const revision = revisionOf(b['revision']);
  if (revision === null) return { ok: false, field: 'revision', message: 'This page is out of date. Reload it and try again.' };
  if (typeof b['body'] !== 'string') return { ok: false, field: 'body', message: 'Notes are plain text.' };
  if (b['body'].length > NOTE_LIMITS.chars) return { ok: false, field: 'body', message: `Notes can be at most ${NOTE_LIMITS.chars.toLocaleString('en-US')} characters.` };
  return { ok: true, value: { body: b['body'], revision } };
}

/** `{ draft, basedOn, revision }`: an object no bigger than the limit, the version it corrects, and the revision the page read. */
export function checkDraftSave(body: unknown): Checked<{ draft: Record<string, unknown>; basedOn: number; revision: number }> {
  const b = (body ?? {}) as Record<string, unknown>;
  const revision = revisionOf(b['revision']);
  const basedOn = revisionOf(b['basedOn']);
  if (revision === null || basedOn === null) return { ok: false, field: 'revision', message: 'This page is out of date. Reload it and try again.' };
  const d = b['draft'];
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, field: 'draft', message: 'The draft could not be read.' };
  if (Buffer.byteLength(JSON.stringify(d), 'utf8') > DRAFT_LIMITS.bytes) return { ok: false, field: 'draft', message: 'The draft is too large to save.' };
  return { ok: true, value: { draft: d as Record<string, unknown>, basedOn, revision } };
}
