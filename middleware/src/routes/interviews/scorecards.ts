// /api/interviews — the scorecard (docs/interviews-tenant-plan.md row I5.3; decisions 6, 14, 15, 20; contract D8).
// Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET  /interviews/:id/scorecard   the lead and each panel member: their own latest scorecard with its earlier
//                                    versions (or none), the kit's competencies with their anchors, whether they may
//                                    submit now, and the others' scorecards on the candidate only once their own is in
//                                    (scope.ts othersRevealed). The recruiter, the opening's hiring manager and the
//                                    admin read every submission as it arrives, and submit nothing.
//   POST /interviews/:id/scorecard   ConductInterview plus the seat: submit the first version, or correct it (a new
//                                    version, with `reason`, against `basedOn`, the latest version the page read).
//                                    Body `{ ratings: [{ competencyId, rating 1..4, note }], recommendation, summary,
//                                    reason?, basedOn }`. There is no field naming the author: it is always the
//                                    signed-in person, so nobody submits for someone else and Milo never writes one.
//
// Outside the viewer's scope (another round's interviewer, another opening's hiring manager) the interview is not
// found: 404, as phase 0 does. A submit from outside the seats is 404 too; a role without ConductInterview is
// refused at the action (403). A stale submit is 409 with the scorecard as it now reads. When every seated
// person's scorecard is in, the interview moves to `scored` (one compare-and-set write).

import { scorecardSubmitted } from '../../lib/interviews/result-bells.js';
import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { ratingsAtRecap } from '../../lib/interviews/recap/index.js';
import { othersRevealed, reachOf } from '../../lib/interviews/scope.js';
import {
  NO_SCORECARD_HERE, SCORECARD_LIMITS, checkScorecard, roundCompetencyIds, isScoredNow, newScorecardVersion, stateRefusal, submitMove, versionsOf,
} from '../../lib/interviews/scorecard.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import { loadWorld } from '../../lib/interviews/store.js';
import type { Interview, KitCompetency, RoundType, Seat } from '../../lib/interviews/types.js';
import type { ScorecardView, WorldIndex } from '../../lib/interviews/views.js';
import { interviewsNow } from '../../lib/interviews/clock.js';

export const scorecardsRouter = Router();
const conduct = requireAction('ConductInterview');

/** One scorecard by someone else, with the round it judges. */
export type OtherScorecard = ScorecardView & { interviewId: string; round: string };

/** D8: what GET /interviews/:id/scorecard answers. */
export interface ScorecardPageView {
  interview: {
    id: string; state: Interview['state']; endedAt: string | null; revision: number;
    round: { id: string; name: string; type: RoundType; minutes: number };
    candidate: { id: string; name: string };
    opening: { id: string; title: string };
    /** The viewer's seat; null for the recruiter, the hiring manager and the admin, who read and never submit. */
    seat: Seat | null;
  };
  /** What each competency is judged on and what each point of the scale means, in the kit's order. */
  competencies: KitCompetency[];
  /** The ids of the competencies this round requires (its chosen questions'), in the kit's order; the rest are optional (E4 #30). */
  required: string[];
  /** The viewer's own latest scorecard with the versions before it; null before they submit (and for readers). */
  mine: ScorecardView | null;
  /** Whether the viewer may submit (or correct) now, and if not, why in one sentence. */
  canSubmit: boolean;
  refusal: string | null;
  /** True while the others' scorecards are hidden because the viewer's own is not in yet. */
  othersHidden: boolean;
  /** The others' scorecards on this candidate's application that the viewer may read, this round first. */
  others: OtherScorecard[];
  limits: typeof SCORECARD_LIMITS;
}

const READ_ONLY = 'Only the interviewers on this round fill in its scorecard.';

/** The page as `viewerId` reads it; null when the interview is outside their scope. */
function pageView(ix: WorldIndex, interviews: readonly Interview[], id: string): ScorecardPageView | null {
  const viewer = ix.viewer;
  const i = ix.world.interviews.find((x) => x.id === id);
  const app = i ? ix.applications.get(i.applicationId) : undefined;
  const opening = app ? ix.openings.get(app.openingId) : undefined;
  const candidate = app ? ix.candidates.get(app.candidateId) : undefined;
  if (!i || !app || !opening || !candidate) return null;
  const seat = seatOf(i, viewer.id);
  // An interviewer's scope is already their own seats; this keeps a reassigned-away interviewer out too.
  if (!seat && reachOf(viewer.role) === 'assigned') return null;
  const names = new Map(opening.kit.competencies.map((k) => [k.id, k.name]));
  const roundName = (iv: Interview) => opening.kit.rounds.find((r) => r.id === iv.roundId)?.name ?? 'Round';
  const mine = seat ? ix.scorecardViews(i.id, names).find((s) => s.interviewer.id === viewer.id) ?? null : null;
  // The world is scoped: an interviewer's holds the others' only once theirs is in (scope.ts othersRevealed).
  const othersHidden = reachOf(viewer.role) === 'assigned' && !othersRevealed(ix.world, viewer.id, app.id);
  const rounds = interviews.filter((x) => x.applicationId === app.id).sort((a, b) => (a.id === i.id ? -1 : b.id === i.id ? 1 : 0));
  const others = othersHidden ? [] : rounds.flatMap((iv) => ix.scorecardViews(iv.id, names)
    .filter((s) => s.interviewer.id !== viewer.id || iv.id !== i.id)
    .map((s) => ({ ...s, interviewId: iv.id, round: roundName(iv) })));
  const refusal = seat ? stateRefusal(i.state, mine !== null) : READ_ONLY;
  return {
    interview: {
      id: i.id, state: i.state, endedAt: i.endedAt, revision: i.revision,
      round: { id: i.roundId, name: roundName(i), type: i.type, minutes: i.minutes },
      candidate: { id: candidate.id, name: candidate.name },
      opening: { id: opening.id, title: opening.title },
      seat,
    },
    competencies: structuredClone(opening.kit.competencies),
    required: roundCompetencyIds(i, opening.kit),
    mine,
    canSubmit: refusal === null,
    refusal,
    othersHidden,
    others,
    limits: SCORECARD_LIMITS,
  };
}

async function readPage(req: Request, id: string): Promise<ScorecardPageView | null> {
  const [ix, interviews] = await Promise.all([indexFor(req), interviewsStore().listInterviews()]);
  return pageView(ix, interviews, id);
}

scorecardsRouter.get('/interviews/:id/scorecard', asyncHandler(async (req, res) => {
  const view = await readPage(req, param(req, 'id'));
  if (!view) throw new NotFoundError(NO_SCORECARD_HERE);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ scorecard: view });
}));

/** Move the interview to `scored` once every seat's scorecard is in; a race re-reads and tries once more. */
async function scoreIfComplete(id: string): Promise<void> {
  const store = interviewsStore();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const world = await loadWorld(store);
    const i = world.interviews.find((x) => x.id === id);
    if (!i || !isScoredNow(i, world.scorecards)) return;
    const out = await store.markScored(i.id, i.revision);
    if (out.ok || out.reason === 'not-found') return;
  }
}

scorecardsRouter.post('/interviews/:id/scorecard', conduct, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const id = param(req, 'id');
  const store = interviewsStore();
  const world = await loadWorld(store);
  const i = world.interviews.find((x) => x.id === id);
  if (!i || !seatOf(i, session.sub)) throw new NotFoundError(NO_SCORECARD_HERE);
  const app = world.applications.find((a) => a.id === i.applicationId);
  const opening = app ? world.openings.find((o) => o.id === app.openingId) : undefined;
  if (!opening) throw new NotFoundError(NO_SCORECARD_HERE);

  res.setHeader('Cache-Control', 'no-store');
  const checked = checkScorecard(req.body, opening.kit.competencies, roundCompetencyIds(i, opening.kit));
  if (!checked.ok) { res.status(400).json({ error: checked.fields[0]!.message, fields: checked.fields }); return; }
  const { reason, basedOn, ...input } = checked.value;

  const move = submitMove(i, session.sub, versionsOf(world.scorecards, i.id, session.sub), basedOn, reason !== null);
  if (!move.ok) {
    if (move.reason === 'no-seat') throw new NotFoundError(NO_SCORECARD_HERE);
    const status = move.reason === 'needs-reason' ? 400 : 409;
    res.status(status).json({ error: move.message, ...(move.reason === 'needs-reason' ? { fields: [{ field: 'reason', message: move.message }] } : {}), scorecard: await readPage(req, id) });
    return;
  }

  const row = newScorecardVersion({
    id: `sc-${randomUUID()}`, interviewId: i.id, authorId: session.sub, version: move.version, input, reason,
    at: interviewsNow().toISOString(),
    // RECAP STEP (row I5.2): the ratings as they stood when this person first opened the recap (E3), never the request's.
    ratingsAtRecap: await ratingsAtRecap(i.id, session.sub),
  });
  const out = await store.addScorecardVersion(row);
  if (!out.ok) {
    res.status(409).json({ error: 'Your scorecard was submitted from another window. The page now shows what was saved.', scorecard: await readPage(req, id) });
    return;
  }
  await scoreIfComplete(i.id);
  void scorecardSubmitted(i.id, session.sub, move.version); // the submitted / every-scorecard-in bells (I5.6)
  res.status(201).json({ scorecard: await readPage(req, id) });
}));
