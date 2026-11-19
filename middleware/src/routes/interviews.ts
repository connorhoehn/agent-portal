// /api/interviews — the interviews tenant's reads (docs/interviews-tenant-plan.md, rows I0.3 to I0.5).
//
// Mounted in index.ts behind requireTenant('interviews') and the server flag
// (lib/interviews/flag.ts). Every route here also needs ViewInterviews, which
// all three roles hold in their own Cedar file; WHICH rows each role reads is
// lib/interviews/scope.ts, applied to the store's rows before anything is
// shaped. A row outside the viewer's scope does not exist: 404, never 403, so
// an interviewer cannot learn another interviewer's interview ids by probing.
//
// The writes are sub-routers under routes/interviews/ (openings: row I1.3). Assign, accept, schedule and decide are later rows.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { inviteRouter } from './interviews/invite.js';
import { asyncHandler, NotFoundError } from '../lib/async-handler.js';
import { resumeRouter } from './interviews/resume.js';
import { debriefRouter } from './interviews/debrief.js';
import { resumeRows } from '../lib/interviews/resume/service.js';
import { retentionRouter } from './interviews/retention.js';
import { requireAction } from '../lib/authz.js';
import { admissionRouter } from './interviews/admission.js';
import { indexFor, param } from '../lib/interviews/request.js';
import { planRouter } from './interviews/plan.js';
import { prepareRouter } from './interviews/prepare.js';
import { scorecardsRouter } from './interviews/scorecards.js';
import { recapRouter } from './interviews/recap.js';
import { interviewsEnabled } from '../lib/interviews/flag.js';
import { roomRouter } from './interviews/room.js';
import { recordRouter } from './interviews/record.js';
import { consentEffectsRouter } from './interviews/consent-effects.js';
import { openingsRouter } from './interviews/openings.js';
import { recordsRouter } from './interviews/records.js';
import { consentsRouter } from './interviews/consents.js';
import { coachRouter } from './interviews/coach.js';
import { miloRouter } from './interviews/milo.js';
import { padRouter } from './interviews/pad.js';
import { boardRouter } from './interviews/board.js';
import { assignmentsRouter } from './interviews/assignments.js';
import { runsRouter } from './interviews/runs.js';
import { candidatesRouter } from './interviews/candidates.js';

/** With INTERVIEWS_ENABLED off every route is the ordinary not-found (lib/interviews/flag.ts). */
export function interviewsFlagGate(_req: Request, res: Response, next: NextFunction): void {
  if (interviewsEnabled()) { next(); return; }
  res.status(404).json({ error: 'Not found' });
}

export const interviewsRouter = Router();
interviewsRouter.use(requireAction('ViewInterviews'));

// A lane adds its routes as a sub-router in its own file under routes/interviews/ and mounts it with one line
// here, after the ViewInterviews gate: interviewsRouter.use(myRouter). Request helpers (indexFor, peopleLookup,
// param) are in lib/interviews/request.ts.

interviewsRouter.use(openingsRouter); // lane KIT (row I1.3): create an opening, edit its details, replace its kit
interviewsRouter.use(assignmentsRouter); // lane ASSIGN (row I1.4): assign a round, answer a seat, reassign

interviewsRouter.use(roomRouter); // lane ROOM (row I2.4): the panel's room, start and end the interview
interviewsRouter.get('/openings', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: ix.world.openings.map((o) => ix.openingRow(o)) });
}));

interviewsRouter.use(admissionRouter); // lane SEAT (row I2.2): the candidate's waiting room, the panel's side

interviewsRouter.get('/openings/:id', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const o = ix.openings.get(param(req, 'id'));
  if (!o) throw new NotFoundError('There is no opening here that you can open.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ opening: ix.openingRecord(o) });
}));

interviewsRouter.use(resumeRouter); // lane RESUME (row I1.6): a candidate's résumé file
interviewsRouter.use(recordsRouter); // lane RECORDS (rows I6.1, I6.2): consent records and the export of what Milo showed

interviewsRouter.use(consentEffectsRouter); // lane DECLINED (row I2.5): what each round runs without, for the recruiter
interviewsRouter.use(candidatesRouter); // lane DESK-B (Add a candidate)
interviewsRouter.get('/candidates', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: ix.candidateRows() });
}));

interviewsRouter.use(consentsRouter); // lane CONSENT (row I2.3): what the panel is told about the candidate's consents
interviewsRouter.use(retentionRouter); // lane RETENTION (row I6.3): a candidate's deletion request and deletion log
interviewsRouter.use(debriefRouter); // lane DEBRIEF (rows I5.4, I5.5): the debrief and the hiring manager's stage decision, E4
interviewsRouter.get('/candidates/:id', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const c = ix.candidates.get(param(req, 'id'));
  if (!c) throw new NotFoundError('There is no candidate here that you can open.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ candidate: ix.candidateRecord(c, await resumeRows().get(c.id)) });
}));

interviewsRouter.use(inviteRouter); // lane INVITE (row I2.1): issue, read and revoke the candidate's link
interviewsRouter.use(planRouter); // lane PLAN (row I3.10): Milo drafts a question plan for the lead

interviewsRouter.use(coachRouter); // lane COACH (row I3.3): Milo's suggestion for the lead, and the lead's answer
interviewsRouter.use(padRouter); // lane PADLOG (row I4.3)
interviewsRouter.use(boardRouter); // the whiteboard's checkpoints (WHITEBOARD-PLAN step 1)
interviewsRouter.use(miloRouter); // lane MILO-FOR-YOU (rows I3.6, I3.7): the live transcript, Milo's notes, the lead's private question
interviewsRouter.use(runsRouter); // lane RUNS (rows I4.4, I4.5)
interviewsRouter.get('/interviews', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: ix.interviewRows() });
}));

interviewsRouter.use(prepareRouter); // lane PREPARE (row I1.7): the lead chooses a round's questions
interviewsRouter.use(recordRouter); // lane RECORD-PAGE (row I5.1): the interview record, panel side of a finished interview only

interviewsRouter.use(scorecardsRouter); // lane SCORE (row I5.3): the scorecard, D8
interviewsRouter.use(recapRouter); // lane RECAP (row I5.2): Milo's recap, opened between the ratings and the recommendation, E3
interviewsRouter.get('/interviews/:id', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  const record = i ? ix.interviewRecord(i) : null;
  if (!record) throw new NotFoundError('There is no interview here that you can open.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ interview: record });
}));
