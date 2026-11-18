// /api/interviews — Milo's recap (docs/interviews-tenant-plan.md decisions 4, 6, 14, 15; row I5.2; contract E3).
// Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   POST /interviews/:id/recap/open   ConductInterview plus a seat on the interview, once it has ended. Body
//                                     `{ ratings: [{ competencyId, rating 1..4 }] }`, the round's own competencies rated (scorecard.ts roundCompetencyIds).
//                                     Stores the ratings for (interview, this person) the first time only, writes the
//                                     recap when it is not there yet, and answers `{ recap: RecapBody }`.
//   GET  /interviews/:id/recap        `{ recap: RecapBody }`, never writing:
//                                       a seat on it         only after their own open is stored or their own scorecard
//                                                            is in (rate first, decision 14);
//                                       the recruiter, the opening's hiring manager, the admin, within scope
//                                                            once the interview has ended;
//                                       an interviewer seated on ANOTHER round of the same application
//                                                            only when the scorecards' rule lets them read the others'
//                                                            scorecards there (scope.ts `othersRevealed`: their own is
//                                                            in for every round of it they sit on), once it has ended.
//   POST /interviews/:id/recap/ask    a seat with ConductInterview whose own open is stored, once the interview has ended and
//                                     until it is reviewed: body `{ question }` → the room ask's answer body (contract F1).
//                                     Everyone else, a seat that has not opened the recap, the recruiter, the hiring manager,
//                                     the admin and a guest: 404. Not ended: 409. A missing or over-long question: 400.
// The candidate's consent answers are the recruiter's and the hiring manager's to read (the profile's Consents), and appear
// on no scorecard (decision 4). `no-transcript` tells the reader the transcript was declined (or nothing was said), so an
// interviewer, seated or not, reads it as `none`: the same answer as Milo declined or a recap that failed (hardening H4).
// Everyone else (another round's interviewer otherwise, another opening's hiring manager, a guest, another tenant) gets
// the tenant's not-found: 404, never 403, as phase 0 does. A role without ConductInterview posting an open is refused at
// the action (403), as the scorecard's submit is. An open before the interview has ended is 409; ratings that do not
// rate the round's own competencies once from 1 to 4 are 400.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, requireAction, resolveSession } from '../../lib/authz.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { checkOpenRatings, openRecap, ratingsAtRecap, readRecap, type RecapRef } from '../../lib/interviews/recap/index.js';
import { isGuestId } from '../../lib/interviews/milo-policy.js';
import { askMiloAfterCall, checkQuestion } from '../../lib/interviews/milo-notes/index.js';
import { MAX_QUESTION_CHARS } from '../../lib/interviews/milo-notes/prompt.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { othersRevealed, reachOf } from '../../lib/interviews/scope.js';
import { roundCompetencyIds } from '../../lib/interviews/scorecard.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import { loadWorld } from '../../lib/interviews/store.js';
import type { Interview, InterviewsWorld } from '../../lib/interviews/types.js';

export const recapRouter = Router();
const conduct = requireAction('ConductInterview');

const NO_RECAP = 'There is no recap here that you can open.';
const NOT_ENDED = 'Milo\'s recap opens once the interview has ended.';
const BAD_QUESTION = `Type a question of at most ${MAX_QUESTION_CHARS} characters.`;
const RATE_ALL = 'Rate this round\'s competencies from 1 to 4 before you open Milo\'s recap.';

const ENDED: ReadonlySet<Interview['state']> = new Set(['ended', 'scored', 'reviewed']);

function refIn(world: Pick<InterviewsWorld, 'interviews' | 'applications' | 'openings'>, id: string): RecapRef | null {
  const interview = world.interviews.find((x) => x.id === id);
  const app = interview ? world.applications.find((a) => a.id === interview.applicationId) : undefined;
  const opening = app ? world.openings.find((o) => o.id === app.openingId) : undefined;
  return interview && opening ? { interview, opening } : null;
}

/** The recap as an interviewer reads it: nothing that tells which of the candidate's answers left it without one. */
export function forInterviewer<B extends { state: string }>(body: B): B {
  return body.state === 'no-transcript' ? { ...body, state: 'none' } : body;
}

/** The interview's recap reference when the viewer may read the recap now; null otherwise (answered as not-found). */
async function readable(req: Request): Promise<RecapRef | null> {
  const session = resolveSession(req)!;
  const id = param(req, 'id');
  const reach = reachOf(session.role);
  if (reach === 'nothing') return null;
  if (reach === 'everything' || reach === 'own-openings') {
    // Scope first: the hiring manager's world holds only their own openings.
    const ix = await indexFor(req);
    const ref = refIn(ix.world, id);
    return ref && ENDED.has(ref.interview.state) ? ref : null;
  }
  // An interviewer: their seat on it, or the scorecards' rule for another round of the same application.
  const world = await loadWorld(interviewsStore());
  const ref = refIn(world, id);
  if (!ref || !ENDED.has(ref.interview.state)) return null;
  const me = session.sub;
  if (seatOf(ref.interview, me)) {
    const ownCard = world.scorecards.some((s) => s.interviewId === ref.interview.id && s.interviewerId === me);
    if (ownCard) return ref;
    return (await ratingsAtRecap(ref.interview.id, me)) ? ref : null;
  }
  return othersRevealed(world, me, ref.interview.applicationId) ? ref : null;
}

recapRouter.get('/interviews/:id/recap', asyncHandler(async (req, res) => {
  const ref = await readable(req);
  if (!ref) throw new NotFoundError(NO_RECAP);
  res.setHeader('Cache-Control', 'no-store');
  const reach = reachOf(resolveSession(req)!.role);
  const recap = await readRecap(ref);
  res.json({ recap: reach === 'everything' || reach === 'own-openings' ? recap : forInterviewer(recap) });
}));

recapRouter.post('/interviews/:id/recap/open', conduct, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const world = await loadWorld(interviewsStore());
  const ref = refIn(world, param(req, 'id'));
  if (!ref || !seatOf(ref.interview, session.sub)) throw new NotFoundError(NO_RECAP);
  res.setHeader('Cache-Control', 'no-store');
  if (!ENDED.has(ref.interview.state)) { res.status(409).json({ error: NOT_ENDED }); return; }
  const ratings = checkOpenRatings(req.body, ref.opening, roundCompetencyIds(ref.interview, ref.opening.kit));
  if (!ratings) { res.status(400).json({ error: RATE_ALL, fields: [{ field: 'ratings', message: RATE_ALL }] }); return; }
  res.json({ recap: forInterviewer(await openRecap(ref, { userId: session.sub }, ratings)) });
}));

recapRouter.post('/interviews/:id/recap/ask', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (isGuestId(session.sub) || !(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NO_RECAP);
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!interview || !seatOf(interview, session.sub)) throw new NotFoundError(NO_RECAP);
  const app = ix.applications.get(interview.applicationId);
  const opening = app ? ix.openings.get(app.openingId) : undefined;
  const candidate = app ? ix.candidates.get(app.candidateId) : undefined;
  if (!opening || !candidate) throw new NotFoundError(NO_RECAP);
  res.setHeader('Cache-Control', 'no-store');
  const question = checkQuestion(req.body);
  if (question === null) { res.status(400).json({ error: BAD_QUESTION }); return; }
  const out = await askMiloAfterCall({ interview, opening, candidateName: candidate.name, nameOf: (id) => ix.people(id).name }, { userId: session.sub }, question);
  if (out.kind === 'not-found') throw new NotFoundError(NO_RECAP);
  if (out.kind === 'not-ended') { res.status(409).json({ error: out.body.line, ...out.body }); return; }
  res.json(out.body);
}));
