// /api/interviews waiting-room routes (docs/interviews-tenant-plan.md, rows I2.2 and I2.3; contract C3): the
// panel's side of the candidate's knock. Mounted in routes/interviews.ts with one line, after the router's
// ViewInterviews gate.
//
//   GET  /interviews/:id/waiting   the lead and the panel of that interview: `{ admission }` for the candidate's
//                                  current guest session (not knocked when there is no live link or no session).
//   POST /interviews/:id/admit     the lead only, body `{ admit: boolean }`: let the candidate in, or turn them
//                                  away (which they may follow with a new knock). Answers `{ admission }`.
//
// Checks, in order: ConductInterview (the interviewer's action; 403 for every other role on every id alike), then
// the seat (lib/interviews/lobby.ts: the lead or the panel of this interview while its call can happen), else 404
// as for any interview outside the viewer's scope; the write then needs the lead, else 404 too. The rules of
// the admission itself are lib/interviews/invite/admission.ts's.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { staffHoldsInterviewSeat } from '../../lib/interviews/lobby.js';
import { admissionOf, applyAdmission, NOT_KNOCKED, type Admission } from '../../lib/interviews/invite/admission.js';
import { inviteDeadReason } from '../../lib/interviews/invite/rules.js';
import { inviteStore } from '../../lib/interviews/invite/store.js';
import type { Interview } from '../../lib/interviews/types.js';

export const admissionRouter = Router();
const conduct = requireAction('ConductInterview');

const NO_INTERVIEW = 'There is no interview here that you can open.';
const NOBODY = 'Nobody is waiting to be let in.';
const CHANGED = 'The candidate\'s page changed while you were deciding. Look again.';

/** The interview, when the caller holds a seat in its call now; otherwise the scope's not-found. */
async function seatedInterview(req: Request, leadOnly: boolean): Promise<Interview> {
  const session = resolveSession(req);
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((i) => i.id === param(req, 'id'));
  if (!session || !interview || !await staffHoldsInterviewSeat(session, interview.id)) throw new NotFoundError(NO_INTERVIEW);
  if (leadOnly && interview.leadId !== session.sub) throw new NotFoundError(NO_INTERVIEW);
  return interview;
}

/** The candidate's current admission: the interview's latest link while it is alive, else not knocked. */
async function currentAdmission(interview: Interview): Promise<{ admission: Admission; inviteId: string | null }> {
  const invite = await inviteStore().latestInvite(interview.id);
  if (!invite || inviteDeadReason(invite, interview, new Date()) !== null) return { admission: { ...NOT_KNOCKED }, inviteId: null };
  return { admission: admissionOf(invite), inviteId: invite.id };
}

admissionRouter.get('/interviews/:id/waiting', conduct, asyncHandler(async (req, res) => {
  const interview = await seatedInterview(req, false);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ admission: (await currentAdmission(interview)).admission });
}));

admissionRouter.post('/interviews/:id/admit', conduct, asyncHandler(async (req, res) => {
  const admit = (req.body as Record<string, unknown> | undefined)?.['admit'];
  const interview = await seatedInterview(req, true);
  if (typeof admit !== 'boolean') { res.status(400).json({ error: 'Say whether to let the candidate in.' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  const { inviteId } = await currentAdmission(interview);
  if (!inviteId) { res.status(409).json({ error: NOBODY }); return; }
  const written = await applyAdmission(inviteId, { kind: 'decide', admit });
  if (written.ok) { res.json({ admission: written.admission }); return; }
  res.status(409).json({ error: written.reason === 'stale' ? CHANGED : NOBODY });
}));
