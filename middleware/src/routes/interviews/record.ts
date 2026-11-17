// /api/interviews — the interview record (docs/interviews-tenant-plan.md row I5.1, decision 4; contract E2).
// Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET /interviews/:id/record   the recording's part, the transcript and the markers of a finished interview.
//
// One rule decides every read, with no exceptions: the panel side of THAT interview (its lead, its panel, a recruiter,
// the opening's hiring manager, by the tenant's one scope rule) and only once it has ended (`ended`, `scored`,
// `reviewed`). No admin exception (as D3 of round 4). Another round's interviewer, another opening's hiring manager, a
// guest, another tenant, and every interview not yet ended get the tenant's not-found. The answer is never cached, and
// nothing of the record reaches a log line.
//
// An interviewer may open the record before their scorecard is in: these are the words they heard and the questions they
// asked, not Milo's reading of them (the recap waits for the ratings, decision 14).
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { resolveSession } from '../../lib/authz.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { isGuestId } from '../../lib/interviews/milo-policy.js';
import { RECORD_STATES, readRecord } from '../../lib/interviews/record/index.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { reachOf } from '../../lib/interviews/scope.js';
import { INTERVIEWS_TENANT } from '../../lib/interviews/types.js';

export const recordRouter = Router();

export const NO_RECORD_HERE = 'There is no interview here that you can open.';

recordRouter.get('/interviews/:id/record', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = resolveSession(req);
  if (!session || session.tenant !== INTERVIEWS_TENANT || session.role === 'admin' || isGuestId(session.sub)) throw new NotFoundError(NO_RECORD_HERE);
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  const application = interview ? ix.applications.get(interview.applicationId) : undefined;
  const opening = application ? ix.openings.get(application.openingId) : undefined;
  const candidate = application ? ix.candidates.get(application.candidateId) : undefined;
  if (!interview || !application || !opening || !candidate) throw new NotFoundError(NO_RECORD_HERE);
  // An interviewer's scope is already their own seats; this keeps a reassigned-away interviewer out too.
  if (reachOf(session.role) === 'assigned' && !seatOf(interview, session.sub)) throw new NotFoundError(NO_RECORD_HERE);
  if (reachOf(session.role) === 'nothing' || !RECORD_STATES.includes(interview.state)) throw new NotFoundError(NO_RECORD_HERE);
  res.json({ record: await readRecord({ interview, application, opening, candidate }) });
}));
