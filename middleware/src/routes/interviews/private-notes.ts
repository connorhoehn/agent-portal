// /api/interviews — an interviewer's private notes on a round, and their scorecard draft kept on the server (gap audit
// 2026-11-20, section 5). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate. The
// rules are lib/interviews/private-notes.ts.
//
//   GET /interviews/:id/my-notes          the signed-in person's own notes on the round, whether they may change them
//                                         now and, if not, why in one sentence.
//   PUT /interviews/:id/my-notes          save them. Body `{ body, revision }` (revision: the one the page read, 0 for none).
//   GET /interviews/:id/scorecard-draft   the signed-in person's own scorecard draft on the round, or none.
//   PUT /interviews/:id/scorecard-draft   save it. Body `{ draft, basedOn, revision }`. Deleted by the scorecard's submit.
//
// Only the author: there is no parameter naming whose notes, so every read and write is the session's own. No new
// action: ConductInterview through the tenant's not-found gate (lib/interviews/gate.ts), then the seat on that round,
// as the room's routes do. Anyone without the action (the recruiter, the hiring manager, another tenant's role at the
// mount) and anyone without a seat on the round (another interviewer; the lead for the panel's notes is the lead's
// own, never theirs; the admin) reads the same not-found. Outside the write window: 409 with the copy as it is. A save
// against an older revision: 409 with the copy as it now is.

import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { resolveSession } from '../../lib/authz.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { interviewsNow } from '../../lib/interviews/clock.js';
import { interviewsAction } from '../../lib/interviews/gate.js';
import { checkDraftSave, checkNoteSave, DRAFT_LIMITS, NOTE_LIMITS, noteRefusal, type PrivateNote, type ScorecardDraft } from '../../lib/interviews/private-notes.js';
import { param } from '../../lib/interviews/request.js';
import { stateRefusal } from '../../lib/interviews/scorecard.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import type { Interview } from '../../lib/interviews/types.js';

export const privateNotesRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';
const STALE_NOTES = 'These notes were saved from another window. The page now shows what was saved: check it, then try again.';
const STALE_DRAFT = 'This draft was saved from another window. The page now shows what was saved.';
const conduct = interviewsAction('ConductInterview', NO_INTERVIEW);

export interface MyNotesView {
  body: string;
  /** 0 while there are none. */
  revision: number;
  updatedAt: string | null;
  canWrite: boolean;
  refusal: string | null;
  limits: typeof NOTE_LIMITS;
}

export interface MyDraftView {
  draft: Pick<ScorecardDraft, 'draft' | 'basedOn' | 'revision' | 'updatedAt'> | null;
  canWrite: boolean;
  refusal: string | null;
  limits: typeof DRAFT_LIMITS;
}

/** The round and whether the session's person has a scorecard on it; a 404 when they hold no seat on it. */
async function mySeat(req: Request): Promise<{ i: Interview; me: string; hasOwn: boolean }> {
  const me = resolveSession(req)!.sub;
  const store = interviewsStore();
  const i = await store.getInterview(param(req, 'id'));
  if (!i || !seatOf(i, me)) throw new NotFoundError(NO_INTERVIEW);
  const hasOwn = (await store.listScorecards()).some((s) => s.interviewId === i.id && s.interviewerId === me);
  return { i, me, hasOwn };
}

function notesView(row: PrivateNote | null, refusal: string | null): MyNotesView {
  return { body: row?.body ?? '', revision: row?.revision ?? 0, updatedAt: row?.updatedAt ?? null, canWrite: refusal === null, refusal, limits: NOTE_LIMITS };
}
function draftView(row: ScorecardDraft | null, refusal: string | null): MyDraftView {
  return {
    draft: row ? { draft: row.draft, basedOn: row.basedOn, revision: row.revision, updatedAt: row.updatedAt } : null,
    canWrite: refusal === null, refusal, limits: DRAFT_LIMITS,
  };
}

const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

privateNotesRouter.get('/interviews/:id/my-notes', conduct, asyncHandler(async (req, res) => {
  const { i, me, hasOwn } = await mySeat(req);
  noStore(res);
  res.json({ notes: notesView(await interviewsStore().getPrivateNote(i.id, me), noteRefusal(i.state, hasOwn)) });
}));

privateNotesRouter.put('/interviews/:id/my-notes', conduct, asyncHandler(async (req, res) => {
  const { i, me, hasOwn } = await mySeat(req);
  noStore(res);
  const store = interviewsStore();
  const refusal = noteRefusal(i.state, hasOwn);
  if (refusal) { res.status(409).json({ error: refusal, notes: notesView(await store.getPrivateNote(i.id, me), refusal) }); return; }
  const checked = checkNoteSave(req.body);
  if (!checked.ok) { res.status(400).json({ error: checked.message, fields: [{ field: checked.field, message: checked.message }] }); return; }
  const out = await store.savePrivateNote({ interviewId: i.id, authorId: me, body: checked.value.body, updatedAt: interviewsNow().toISOString() }, checked.value.revision);
  if (!out.ok) { res.status(409).json({ error: STALE_NOTES, notes: notesView(out.reason === 'stale' ? out.row : null, null) }); return; }
  res.json({ notes: notesView(out.row, null) });
}));

privateNotesRouter.get('/interviews/:id/scorecard-draft', conduct, asyncHandler(async (req, res) => {
  const { i, me, hasOwn } = await mySeat(req);
  noStore(res);
  res.json({ draft: draftView(await interviewsStore().getScorecardDraft(i.id, me), stateRefusal(i.state, hasOwn)) });
}));

privateNotesRouter.put('/interviews/:id/scorecard-draft', conduct, asyncHandler(async (req, res) => {
  const { i, me, hasOwn } = await mySeat(req);
  noStore(res);
  const store = interviewsStore();
  const refusal = stateRefusal(i.state, hasOwn);
  if (refusal) { res.status(409).json({ error: refusal, draft: draftView(await store.getScorecardDraft(i.id, me), refusal) }); return; }
  const checked = checkDraftSave(req.body);
  if (!checked.ok) { res.status(400).json({ error: checked.message, fields: [{ field: checked.field, message: checked.message }] }); return; }
  const { draft, basedOn, revision } = checked.value;
  const out = await store.saveScorecardDraft({ interviewId: i.id, authorId: me, basedOn, draft, updatedAt: interviewsNow().toISOString() }, revision);
  if (!out.ok) { res.status(409).json({ error: STALE_DRAFT, draft: draftView(out.reason === 'stale' ? out.row : null, null) }); return; }
  res.json({ draft: draftView(out.row, null) });
}));
