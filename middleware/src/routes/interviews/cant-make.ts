// /api/interviews — the recruiter clears the candidate's "I can't make this time" (gap audit 2026-11-20 §6;
// lib/interviews/cant-make.ts). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   POST /interviews/:id/cant-make/clear   the recruiter (AssignInterviews, as Cancel is): the notice goes, nothing else
//                                          changes. Body `{ revision }`. Compare-and-set: 409 with the row as it now is.
//
// Outside the viewer's scope, or without AssignInterviews, the round is not found (lib/interviews/gate.ts). A round with
// no notice answers 200 with the row unchanged. Rescheduling and cancelling clear it too (store.ts), and so does erasure.

import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { interviewsAction } from '../../lib/interviews/gate.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';

export const cantMakeRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';
const STALE = 'Someone else changed this round while you were looking at it. It now shows what was saved: check it, then try again.';
const assign = interviewsAction('AssignInterviews', NO_INTERVIEW);

cantMakeRouter.post('/interviews/:id/cant-make/clear', assign, asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!i) throw new NotFoundError(NO_INTERVIEW);
  res.setHeader('Cache-Control', 'no-store');
  const r = (req.body as Record<string, unknown> | undefined)?.['revision'];
  if (typeof r !== 'number' || !Number.isInteger(r) || r < 1) { res.status(400).json({ error: 'This page is out of date. Reload it and try again.', fields: [] }); return; }
  if (!i.cantMake) { res.json({ interview: ix.interviewRow(i) }); return; }
  if (i.revision !== r) { res.status(409).json({ error: STALE, interview: ix.interviewRow(i) }); return; }
  const written = await interviewsStore().setCantMake(i.id, null, r);
  if (!written.ok && written.reason === 'not-found') throw new NotFoundError(NO_INTERVIEW);
  const fresh = await indexFor(req);
  const now = fresh.world.interviews.find((x) => x.id === i.id);
  const row = now ? fresh.interviewRow(now) : null;
  if (!written.ok) { res.status(409).json({ error: STALE, interview: row }); return; }
  res.json({ interview: row });
}));
