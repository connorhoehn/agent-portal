// /api/interviews — the recruiter's stage moves (gap audit 2026-11-20, section 2). Mounted in routes/interviews.ts
// with one line, after the router's ViewInterviews gate. The rules are lib/interviews/stage-moves.ts.
//
//   POST /applications/:id/move    the recruiter (ManageCandidates): start screening, mark hired, offer declined, or
//                                  reopen. Body `{ move, basedOn, reason? }` (basedOn: the history length the page
//                                  read, as the stage decision and withdraw name it).
//
// No new action: an application's stage outside the hiring manager's decision is the application's (ManageCandidates,
// "openings, candidates, applications"), as withdraw is. Anyone without it, and anyone outside the tenant (the mount's
// requireTenant), reads the not-found (lib/interviews/gate.ts). Outside the viewer's scope the row is not found (404).
// A move the stage does not take: 409 with a sentence. A stale `basedOn`: 409. The hiring manager's decision route
// (routes/interviews/debrief.ts) is a separate write and is unchanged.

import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { resolveSession } from '../../lib/authz.js';
import { interviewsNow } from '../../lib/interviews/clock.js';
import { interviewsAction } from '../../lib/interviews/gate.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { checkStageMove, roundsOf, stageMove, stageMoveChange } from '../../lib/interviews/stage-moves.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';

export const stageMovesRouter = Router();

const NO_APPLICATION = 'There is no candidate here that you can open.';
const STALE = 'Someone else changed this candidate while you were looking at it. Reload and try again.';

const manage = interviewsAction('ManageCandidates', NO_APPLICATION);

stageMovesRouter.post('/applications/:id/move', manage, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const app = ix.applications.get(param(req, 'id'));
  if (!app) throw new NotFoundError(NO_APPLICATION);
  const checked = checkStageMove(req.body);
  res.setHeader('Cache-Control', 'no-store');
  if (!checked.ok) {
    res.status(400).json({ error: checked.problems.length === 1 ? checked.problems[0]!.message : 'Some answers need another look.', fields: checked.problems });
    return;
  }
  const { move, basedOn, reason } = checked.value;
  if (app.history.length !== basedOn) { res.status(409).json({ error: STALE, application: { id: app.id, stage: app.stage } }); return; }
  const out = stageMove(app.stage, move, roundsOf(app, ix.world.interviews));
  if (!out.ok) { res.status(409).json({ error: out.message, application: { id: app.id, stage: app.stage } }); return; }
  const change = stageMoveChange({ to: out.to, move, reason, by: session.sub, at: interviewsNow().toISOString() });
  const written = await interviewsStore().decideStage(app.id, change, basedOn);
  if (!written.ok) {
    if (written.reason === 'not-found') throw new NotFoundError(NO_APPLICATION);
    res.status(409).json({ error: STALE, application: { id: written.row.id, stage: written.row.stage } });
    return;
  }
  res.json({ application: { id: written.row.id, stage: written.row.stage, basedOn: written.row.history.length } });
}));
