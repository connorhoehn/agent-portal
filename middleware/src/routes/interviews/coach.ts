// /api/interviews — Milo's suggestion for the lead (docs/interviews-tenant-plan.md decisions 8 and 20, row I3.3; contract
// D7). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET  /interviews/:id/suggestion                          → { suggestion, paused, retryAfterMs }
//   POST /interviews/:id/suggestion/:suggestionId/answer     body { answer: 'ask' | 'milo-ask' | 'skip' } → { suggestion: null }
//
// Who: the interview's lead, holding ConductInterview. Everyone else gets the one not-found, whatever the reason: the panel,
// another round's interviewer, the recruiter and the hiring manager (who hold no ConductInterview: answered 404 here, not
// the action gate's 403, so nobody outside the lead's seat learns that a suggestion exists), and the cross-tenant admin.
// Another tenant's role is refused at the tenant's mount before these routes run. The read marks the suggestion shown.
// An answer is 409 when the suggestion was already answered or the interview is not live; 400 for an answer not in the list.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { answerSuggestion, suggestionFor, SUGGESTION_ANSWERS, type CoachRef, type SuggestionAnswer } from '../../lib/interviews/coach/index.js';
import { indexFor, param } from '../../lib/interviews/request.js';

export const coachRouter = Router();

const NO_SUGGESTION = 'There is no suggestion here for you.';
const ANSWERED = 'This suggestion was already answered.';
const NOT_LIVE = 'The interview is not running, so this suggestion can no longer be answered.';
const BAD_ANSWER = 'Choose I will ask it, Have Milo ask, or Skip.';

/** The interview and its opening, when the viewer leads it and holds ConductInterview; null for anyone else. */
async function leadsIt(req: Request): Promise<{ ref: CoachRef; userId: string } | null> {
  const session = resolveSession(req)!;
  if (!(await isAllowed(session, 'ConductInterview'))) return null;
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!interview || interview.leadId !== session.sub) return null;
  const app = ix.applications.get(interview.applicationId);
  const opening = app ? ix.openings.get(app.openingId) : undefined;
  return opening ? { ref: { interview, opening }, userId: session.sub } : null;
}

coachRouter.get('/interviews/:id/suggestion', asyncHandler(async (req, res) => {
  const lead = await leadsIt(req);
  if (!lead) throw new NotFoundError(NO_SUGGESTION);
  const out = await suggestionFor(lead.ref, { userId: lead.userId });
  if (out.kind === 'not-found') throw new NotFoundError(NO_SUGGESTION);
  res.setHeader('Cache-Control', 'no-store');
  res.json(out.body);
}));

coachRouter.post('/interviews/:id/suggestion/:suggestionId/answer', asyncHandler(async (req, res) => {
  const lead = await leadsIt(req);
  if (!lead) throw new NotFoundError(NO_SUGGESTION);
  const answer = (req.body as Record<string, unknown> | undefined)?.['answer'];
  res.setHeader('Cache-Control', 'no-store');
  if (typeof answer !== 'string' || !SUGGESTION_ANSWERS.includes(answer as SuggestionAnswer)) { res.status(400).json({ error: BAD_ANSWER }); return; }
  const out = await answerSuggestion(lead.ref, { userId: lead.userId }, param(req, 'suggestionId'), answer as SuggestionAnswer);
  if (out.kind === 'not-found') throw new NotFoundError(NO_SUGGESTION);
  if (out.kind === 'answered') { res.status(409).json({ error: ANSWERED }); return; }
  if (out.kind === 'not-live') { res.status(409).json({ error: NOT_LIVE }); return; }
  res.json({ suggestion: null });
}));
