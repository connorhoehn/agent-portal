// /api/interviews — the debrief and the stage decision (docs/interviews-tenant-plan.md decisions 6, 14, 15; rows I5.4,
// I5.5; contract E4). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET  /candidates/:id/debrief      the recruiter, the hiring manager of an opening the candidate applied to (those
//                                     applications only), the admin: per application the stage and its history, each
//                                     round with every submitted scorecard side by side, who is still due, and where
//                                     its recap and record are (lib/interviews/debrief/view.ts). An interviewer: not
//                                     found, whatever they have submitted.
//   POST /applications/:id/stage      DecideCandidate plus being that opening's hiring manager. Body `{ decision:
//                                     'advance' | 'hold' | 'reject', reason, basedOn }`, `basedOn` the history length the
//                                     page read. Appends the decision to the history (never edits one), moves the stage
//                                     (lib/interviews/debrief/rules.ts), marks the application's `scored` rounds
//                                     `reviewed`, and rings the opening's recruiter.
//
// Refusals: the recruiter and the admin read the debrief and do not decide: 403 with that sentence. Another opening's
// hiring manager: 404 (it is outside their scope). A role without DecideCandidate: 403 at the action. A bad body: 400
// with the field. A stale `basedOn`: 409 with the debrief as it now reads. A move the stage does not allow: 409 with its
// sentence.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { NO_DEBRIEF_HERE, ONLY_THE_HIRING_MANAGER, STALE_DECISION, checkDecision, decisionChange, decisionMove, scorecardsMissing, toReview } from '../../lib/interviews/debrief/rules.js';
import { debriefView, type DebriefView } from '../../lib/interviews/debrief/view.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { stageDecided } from '../../lib/interviews/result-bells.js';
import { reachOf } from '../../lib/interviews/scope.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import { loadWorld } from '../../lib/interviews/store.js';

export const debriefRouter = Router();

const NO_APPLICATION_HERE = 'There is no application here that you can decide on.';

debriefRouter.get('/candidates/:id/debrief', asyncHandler(async (req, res) => {
  const view = debriefView(await indexFor(req), param(req, 'id'));
  if (!view) throw new NotFoundError(NO_DEBRIEF_HERE);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ debrief: view });
}));

async function debriefOf(req: Request, candidateId: string): Promise<DebriefView | null> {
  return debriefView(await indexFor(req), candidateId);
}

/** The recruiter and the admin read every debrief and decide none: say so, before the action check answers a bare 403. */
async function readersDoNotDecide(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = resolveSession(req);
    if (session && reachOf(session.role) === 'everything') {
      const app = (await interviewsStore().listApplications()).find((a) => a.id === param(req, 'id'));
      if (!app) { next(new NotFoundError(NO_APPLICATION_HERE)); return; }
      res.setHeader('Cache-Control', 'no-store');
      res.status(403).json({ error: ONLY_THE_HIRING_MANAGER });
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}

/** Mark the application's `scored` rounds `reviewed`; a race re-reads and tries once more. */
async function markReviewed(applicationId: string): Promise<void> {
  const store = interviewsStore();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const world = await loadWorld(store);
    const app = world.applications.find((a) => a.id === applicationId);
    if (!app) return;
    const pending = toReview(app, world.interviews);
    if (!pending.length) return;
    const outs = await Promise.all(pending.map((i) => store.markReviewed(i.id, i.revision)));
    if (outs.every((o) => o.ok || o.reason === 'not-found')) return;
  }
}

debriefRouter.post('/applications/:id/stage', readersDoNotDecide, requireAction('DecideCandidate'), asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const id = param(req, 'id');
  const ix = await indexFor(req);
  const app = ix.applications.get(id);
  const opening = app ? ix.openings.get(app.openingId) : undefined;
  // Another opening's hiring manager does not see this application at all; the opening's own is the only decider.
  if (!app || !opening || opening.hiringManagerId !== session.sub) throw new NotFoundError(NO_APPLICATION_HERE);

  res.setHeader('Cache-Control', 'no-store');
  const checked = checkDecision(req.body);
  if (!checked.ok) { res.status(400).json({ error: checked.fields[0]!.message, fields: checked.fields }); return; }
  const { decision, reason, basedOn } = checked.value;
  if (basedOn !== app.history.length) { res.status(409).json({ error: STALE_DECISION, debrief: await debriefOf(req, app.candidateId) }); return; }

  const interviews = ix.interviewsOf(app.id);
  const cards = ix.world.scorecards.filter((s) => interviews.some((i) => i.id === s.interviewId));
  const move = decisionMove(app.stage, decision, interviews, cards);
  if (!move.ok) { res.status(409).json({ error: move.message, debrief: await debriefOf(req, app.candidateId) }); return; }

  const change = decisionChange({ to: move.to, decision, reason, by: session.sub, at: new Date().toISOString(), missing: scorecardsMissing(interviews, cards) });
  const out = await interviewsStore().decideStage(app.id, change, basedOn);
  if (!out.ok) {
    if (out.reason === 'not-found') throw new NotFoundError(NO_APPLICATION_HERE);
    res.status(409).json({ error: STALE_DECISION, debrief: await debriefOf(req, app.candidateId) });
    return;
  }
  await markReviewed(app.id);
  void stageDecided(app.id, session.sub);
  res.status(201).json({ debrief: await debriefOf(req, app.candidateId) });
}));
