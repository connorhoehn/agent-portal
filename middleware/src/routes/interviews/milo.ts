// /api/interviews — Milo for you and the live transcript (docs/interviews-tenant-plan.md rows I3.6 and I3.7; decisions 4,
// 6, 8, 20; contract E5). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET  /interviews/:id/transcript?after=<seq>   the panel side of that interview (its seats, the recruiter, the
//                                                  opening's hiring manager) while it is `live` → { transcript }
//   GET  /interviews/:id/milo-notes               the seats of that interview while it is `live` → { notes }
//   POST /interviews/:id/milo-ask                 the lead only, ConductInterview, body { question } → { answer, refused,
//                                                  line, paused, retryAfterMs }
//
// Everyone outside gets the tenant's one not-found, whatever the reason: a guest (who also holds no ViewInterviews and is
// refused at the router's gate first), another round's interviewer, the admin (no exception, as the record), and every
// state but `live` on the two reads. A panel member, the recruiter and the hiring manager get not-found on the ask, so
// nobody outside the lead's seat learns it exists. Another tenant's role is refused at the tenant's mount. The ask is 409
// while the interview is not live, 400 for a missing or over-long question. Nothing here invites Milo; only the ask can
// cost money.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { isGuestId } from '../../lib/interviews/milo-policy.js';
import { askMilo, checkQuestion, notesFor, transcriptFor, type MiloRef } from '../../lib/interviews/milo-notes/index.js';
import { MAX_QUESTION_CHARS } from '../../lib/interviews/milo-notes/prompt.js';
import { indexFor, param } from '../../lib/interviews/request.js';

export const miloRouter = Router();

const NOTHING_HERE = 'There is nothing of Milo’s here for you.';
const BAD_QUESTION = `Type a question of at most ${MAX_QUESTION_CHARS} characters.`;

/** The interview in the viewer's scope (the panel side: seats, the recruiter, the opening's hiring manager), never the admin or a guest. */
async function panelSide(req: Request): Promise<{ ref: MiloRef; userId: string } | null> {
  const session = resolveSession(req)!;
  if (!session.role || session.role === 'admin' || isGuestId(session.sub)) return null;
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!interview) return null;
  if (session.role === 'interviewer' && !seatOf(interview, session.sub)) return null;
  const app = ix.applications.get(interview.applicationId);
  const opening = app ? ix.openings.get(app.openingId) : undefined;
  const candidate = app ? ix.candidates.get(app.candidateId) : undefined;
  if (!opening || !candidate) return null;
  return { ref: { interview, opening, candidateName: candidate.name, nameOf: (id) => ix.people(id).name }, userId: session.sub };
}

miloRouter.get('/interviews/:id/transcript', asyncHandler(async (req, res) => {
  const p = await panelSide(req);
  if (!p || p.ref.interview.state !== 'live') throw new NotFoundError(NOTHING_HERE);
  const after = Number.parseInt(String(req.query['after'] ?? '0'), 10);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await transcriptFor(p.ref, Number.isFinite(after) ? after : 0));
}));

miloRouter.get('/interviews/:id/milo-notes', asyncHandler(async (req, res) => {
  const p = await panelSide(req);
  if (!p || p.ref.interview.state !== 'live' || !seatOf(p.ref.interview, p.userId)) throw new NotFoundError(NOTHING_HERE);
  res.setHeader('Cache-Control', 'no-store');
  res.json(await notesFor(p.ref));
}));

miloRouter.post('/interviews/:id/milo-ask', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (!(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NOTHING_HERE);
  const p = await panelSide(req);
  if (!p || p.ref.interview.leadId !== p.userId) throw new NotFoundError(NOTHING_HERE);
  res.setHeader('Cache-Control', 'no-store');
  const question = checkQuestion(req.body);
  if (question === null) { res.status(400).json({ error: BAD_QUESTION }); return; }
  const out = await askMilo(p.ref, { userId: p.userId }, question);
  if (out.kind === 'not-found') throw new NotFoundError(NOTHING_HERE);
  if (out.kind === 'not-live') { res.status(409).json({ error: out.body.line, ...out.body }); return; }
  res.json(out.body);
}));
