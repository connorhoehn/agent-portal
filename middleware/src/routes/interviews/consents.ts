// GET /api/interviews/interviews/:id/consents: what the panel is told about the candidate's consents
// (docs/interviews-tenant-plan.md decision 5, row I2.3; contract C4). Mounted in routes/interviews.ts with one
// line, after the router's ViewInterviews gate.
//
// Answers `{ answered, off }` and nothing else about the choice: the interviewer is told only what is off, the
// recruiter is told so they can arrange what replaces it. Who may ask: the recruiter, and whoever holds a seat
// on this interview (the lead and the panel). The hiring manager, the cross-tenant admin and everyone else get
// the not-found every out-of-scope row gets (the stricter reading of decision 5, which names only the
// interviewer and the recruiter).
//
//   answered  all three answers are stored under the current notice; once the call has started, the answers
//             it started with stand whatever the notice says now.
//   off       the parts that are off. Every part while nothing is answered: nothing runs before consent.

import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { resolveSession } from '../../lib/authz.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { CONSENT_NOTICE } from '../../lib/interviews/consent/notice.js';
import { consentsChangeable, partsOff, type ConsentPart } from '../../lib/interviews/consent/rules.js';
import { consentStore } from '../../lib/interviews/consent/store.js';

export const consentsRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';

export interface StaffConsentsView { answered: boolean; off: ConsentPart[] }

consentsRouter.get('/interviews/:id/consents', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((i) => i.id === param(req, 'id'));
  const seated = !!interview && (interview.leadId === session.sub || interview.panelIds.includes(session.sub));
  if (!interview || !(session.role === 'recruiter' || seated)) throw new NotFoundError(NO_INTERVIEW);
  const record = await consentStore().getConsent(interview.id);
  const answered = record !== null && (record.noticeVersion === CONSENT_NOTICE.version || !consentsChangeable(interview.state));
  const view: StaffConsentsView = { answered, off: partsOff(answered ? record : null) };
  res.setHeader('Cache-Control', 'no-store');
  res.json(view);
}));
