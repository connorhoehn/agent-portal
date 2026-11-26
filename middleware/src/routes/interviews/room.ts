// /api/interviews — the interview room, the panel's side (docs/interviews-tenant-plan.md row I2.4, decision 21;
// contract C5). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET  /interviews/:id/room    the lead and the panel: the room view (lib/interviews/room.ts roomView)
//   POST /interviews/:id/start   the lead, when they join the call: accepted or ready → live. Body `{ revision }`.
//   POST /interviews/:id/end     the lead, from End interview: live → ended, with endedAt. Body `{ revision }`.
//                                The recruiter (AssignInterviews) too, for a live round the lead left (gap audit
//                                2026-11-20 §1): the same End, scorecards owed (lib/interviews/cancel.ts recruiterEndMove).
//
// Outside the seats (another interviewer, the recruiter, the hiring manager, the admin) the interview is not
// found: 404, as phase 0 does. A panel member asking to start or end is refused (403): they know the round
// exists. The writes are compare-and-set on the revision the page loaded: 409 with the row as it now is.
// Both writes answer `{ interview }` as GET /interviews/:id gives it.

import { interviewEnded } from '../../lib/interviews/result-bells.js';
import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { interviewsAction, interviewsAnyAction } from '../../lib/interviews/gate.js';
import { recruiterEndMove } from '../../lib/interviews/cancel.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { endMove, roomView, startMove, type RoomMove } from '../../lib/interviews/room.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import type { WriteResult } from '../../lib/interviews/store.js';
import type { Interview } from '../../lib/interviews/types.js';
import { interviewsNow } from '../../lib/interviews/clock.js';
import { forgetInterviewGuest } from '../../lib/interviews/invite/admission.js';
import { publishInterviewHint } from '../../lib/interviews/live-hint.js';

export const roomRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';
// A member without ConductInterview reads the same not-found (lib/interviews/gate.ts), never a 403.
const conduct = interviewsAction('ConductInterview', NO_INTERVIEW);
// End: the lead (ConductInterview) or the recruiter (AssignInterviews); anyone else reads the not-found.
const conductOrAssign = interviewsAnyAction(['ConductInterview', 'AssignInterviews'], NO_INTERVIEW);
const STALE = 'Someone else changed this interview while you were in the room. The room now shows what was saved: try again.';
const OUT_OF_DATE = 'This page is out of date. Reload it and try again.';

function revisionOf(req: Request): number | null {
  const r = (req.body as Record<string, unknown> | undefined)?.['revision'];
  return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null;
}

/** The interview's record as the read route gives it, from a fresh read. */
async function answer(req: Request, res: Response, result: WriteResult<Interview>): Promise<void> {
  if (!result.ok && result.reason === 'not-found') throw new NotFoundError(NO_INTERVIEW);
  const ix = await indexFor(req);
  const now = ix.world.interviews.find((i) => i.id === result.row.id);
  const record = now ? ix.interviewRecord(now) : null;
  res.setHeader('Cache-Control', 'no-store');
  if (!result.ok) { res.status(409).json({ error: STALE, interview: record }); return; }
  res.json({ interview: record });
}

roomRouter.get('/interviews/:id/room', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  const app = i ? ix.applications.get(i.applicationId) : undefined;
  const opening = app ? ix.openings.get(app.openingId) : undefined;
  const candidate = app ? ix.candidates.get(app.candidateId) : undefined;
  const view = i && opening && candidate ? roomView(i, opening, candidate.name, session.sub, ix.people) : null;
  if (!view) throw new NotFoundError(NO_INTERVIEW);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ room: view });
}));

function roomWrite(move: (i: Interview, userId: string, req: Request) => RoomMove | Promise<RoomMove>, write: (i: Interview, revision: number) => Promise<WriteResult<Interview>>) {
  return asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const ix = await indexFor(req);
    const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
    if (!i) throw new NotFoundError(NO_INTERVIEW);
    const out = await move(i, session.sub, req);
    if (!out.ok && out.reason === 'no-seat') throw new NotFoundError(NO_INTERVIEW);
    const revision = revisionOf(req);
    if (revision === null) { res.status(400).json({ error: OUT_OF_DATE }); return; }
    if (!out.ok) { res.setHeader('Cache-Control', 'no-store'); res.status(out.reason === 'not-lead' ? 403 : 409).json({ error: out.message, interview: ix.interviewRecord(i) }); return; }
    if (i.revision !== revision) { await answer(req, res, { ok: false, reason: 'stale', row: i }); return; }
    if (!out.write) { await answer(req, res, { ok: true, row: i }); return; }
    await answer(req, res, await write(i, revision));
  });
}

/**
 * The lead's End, or the recruiter's on a round they hold no seat on. A seated person is always answered as a seat
 * (a panel member is refused); a recruiter without a seat gets recruiterEndMove.
 */
async function endMoveFor(i: Interview, userId: string, req: Request): Promise<RoomMove> {
  if (seatOf(i, userId)) return endMove(i, userId);
  const session = resolveSession(req)!;
  if (await isAllowed({ sub: session.sub, role: session.role, tenant: session.tenant }, 'AssignInterviews')) return recruiterEndMove(i);
  return endMove(i, userId);
}

/**
 * The call is over for the candidate: the gateway's verdict cache forgets every yes it holds for the guest. The
 * candidate's page learns it now, not on its next poll: the hint goes out first, while the guest still holds its
 * subscription. Shared by End and by "did not take place" on a live round (routes/interviews/cancel.ts).
 */
export async function closeRoom(interviewId: string): Promise<void> {
  await publishInterviewHint(interviewId, 'ended');
  await forgetInterviewGuest(interviewId, 'interview-ended');
}

roomRouter.post('/interviews/:id/start', conduct, roomWrite(startMove, (i, revision) => interviewsStore().startInterview(i.id, revision, interviewsNow().toISOString())));
roomRouter.post('/interviews/:id/end', conductOrAssign, roomWrite(endMoveFor, async (i, revision) => {
  const r = await interviewsStore().endInterview(i.id, interviewsNow().toISOString(), revision);
  if (r.ok) void interviewEnded(i.id); // the scorecard-due bells (I5.6)
  if (r.ok) await closeRoom(i.id);
  return r;
}));
