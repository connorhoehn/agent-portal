// /api/interviews waiting-room routes (docs/interviews-tenant-plan.md, rows I2.2 and I2.3; contract C3): the
// panel's side of the candidate's knock. Mounted in routes/interviews.ts with one line, after the router's
// ViewInterviews gate.
//
//   GET  /interviews/:id/waiting   the lead and the panel of that interview: `{ admission, mayAdmit }` for the
//                                  candidate's current guest session (not knocked when there is no live link or no
//                                  session); `mayAdmit` is whether this seat may let them in now (below).
//   POST /interviews/:id/admit     body `{ admit: boolean }`: let the candidate in, or turn them away (which they may
//                                  follow with a new knock). Answers `{ admission }`. The lead decides either way; a
//                                  panel member may let the candidate in (never turn them away) while they are in the
//                                  round's call and the lead is not (gap audit 2026-11-20 §4; lib/interviews/waiting-room.ts:
//                                  who is in the call is the call store's, read from verified sockets).
//
// Checks, in order: ConductInterview (the interviewer's action; every other role reads the same not-found), then the
// seat (lib/interviews/lobby.ts: the lead or the panel of this interview while its call can happen), else 404 as for
// any interview outside the viewer's scope. A panel member the rule refuses gets 403 with the reason. The rules of the
// admission itself are lib/interviews/invite/admission.ts's. A decision resolves the waiting bells.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { interviewsAction } from '../../lib/interviews/gate.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { staffHoldsInterviewSeat } from '../../lib/interviews/lobby.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { ADMIT_REFUSAL, admitAuthority, mayAdmitNow, resolveWaiting, seatsInRoom } from '../../lib/interviews/waiting-room.js';
import { admissionOf, applyAdmission, NOT_KNOCKED, type Admission } from '../../lib/interviews/invite/admission.js';
import { inviteDeadReason } from '../../lib/interviews/invite/rules.js';
import { inviteStore } from '../../lib/interviews/invite/store.js';
import type { Interview, Seat } from '../../lib/interviews/types.js';
import { interviewsNow } from '../../lib/interviews/clock.js';

export const admissionRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';
// A member without ConductInterview reads the same not-found (lib/interviews/gate.ts), never a 403.
const conduct = interviewsAction('ConductInterview', NO_INTERVIEW);
const NOBODY = 'Nobody is waiting to be let in.';
const CHANGED = 'The candidate\'s page changed while you were deciding. Look again.';

/** The interview and the caller's seat in it, when the caller holds a seat in its call now; otherwise the scope's not-found. */
async function seatedInterview(req: Request): Promise<{ interview: Interview; seat: Seat; userId: string }> {
  const session = resolveSession(req);
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((i) => i.id === param(req, 'id'));
  if (!session || !interview || !await staffHoldsInterviewSeat(session, interview.id)) throw new NotFoundError(NO_INTERVIEW);
  const seat = seatOf(interview, session.sub);
  if (!seat) throw new NotFoundError(NO_INTERVIEW);
  return { interview, seat, userId: session.sub };
}

/** The candidate's current admission: the interview's latest link while it is alive, else not knocked. */
async function currentAdmission(interview: Interview): Promise<{ admission: Admission; inviteId: string | null }> {
  const invite = await inviteStore().latestInvite(interview.id);
  if (!invite || inviteDeadReason(invite, interview, interviewsNow()) !== null) return { admission: { ...NOT_KNOCKED }, inviteId: null };
  return { admission: admissionOf(invite), inviteId: invite.id };
}

admissionRouter.get('/interviews/:id/waiting', conduct, asyncHandler(async (req, res) => {
  const { interview, seat, userId } = await seatedInterview(req);
  res.setHeader('Cache-Control', 'no-store');
  const [{ admission }, mayAdmit] = await Promise.all([currentAdmission(interview), mayAdmitNow(interview, seat, userId)]);
  res.json({ admission, mayAdmit });
}));

admissionRouter.post('/interviews/:id/admit', conduct, asyncHandler(async (req, res) => {
  const admit = (req.body as Record<string, unknown> | undefined)?.['admit'];
  const { interview, seat, userId } = await seatedInterview(req);
  if (typeof admit !== 'boolean') { res.status(400).json({ error: 'Say whether to let the candidate in.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  if (seat !== 'lead') {
    const here = await seatsInRoom(interview);
    const may = admitAuthority(seat, admit, { lead: here.lead, self: here.panel.has(userId) });
    if (may !== true) { res.status(403).json({ error: ADMIT_REFUSAL[may] }); return; }
  }
  const { inviteId, admission: before } = await currentAdmission(interview);
  if (!inviteId) { res.status(409).json({ error: NOBODY }); return; }
  const written = await applyAdmission(inviteId, { kind: 'decide', admit });
  if (written.ok) {
    // The spell is over either way: its bells leave the seats' inboxes.
    if (written.changed) void resolveWaiting(interview.id, before.knockedAt);
    res.json({ admission: written.admission }); return;
  }
  res.status(409).json({ error: written.reason === 'stale' || written.reason === 'precondition' ? CHANGED : NOBODY });
}));
