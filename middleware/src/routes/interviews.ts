// /api/interviews — the interviews tenant's reads (docs/interviews-tenant-plan.md, rows I0.3 to I0.5).
//
// Mounted in index.ts behind requireTenant('interviews') and the server flag
// (lib/interviews/flag.ts). Every route here also needs ViewInterviews, which
// all three roles hold in their own Cedar file; WHICH rows each role reads is
// lib/interviews/scope.ts, applied to the store's rows before anything is
// shaped. A row outside the viewer's scope does not exist: 404, never 403, so
// an interviewer cannot learn another interviewer's interview ids by probing.
//
// Phase 0 has no writes. Assign, accept, schedule and decide are later rows.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';
import { indexFor, param } from '../lib/interviews/request.js';
import { interviewsEnabled } from '../lib/interviews/flag.js';

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


interviewsRouter.get('/openings', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: ix.world.openings.map((o) => ix.openingRow(o)) });
}));

interviewsRouter.get('/openings/:id', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const o = ix.openings.get(param(req, 'id'));
  if (!o) throw new NotFoundError('There is no opening here that you can open.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ opening: ix.openingRecord(o) });
}));

interviewsRouter.get('/candidates', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: ix.candidateRows() });
}));

interviewsRouter.get('/candidates/:id', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const c = ix.candidates.get(param(req, 'id'));
  if (!c) throw new NotFoundError('There is no candidate here that you can open.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ candidate: ix.candidateRecord(c) });
}));

interviewsRouter.get('/interviews', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: ix.interviewRows() });
}));

interviewsRouter.get('/interviews/:id', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  const record = i ? ix.interviewRecord(i) : null;
  if (!record) throw new NotFoundError('There is no interview here that you can open.');
  res.setHeader('Cache-Control', 'no-store');
  res.json({ interview: record });
}));
