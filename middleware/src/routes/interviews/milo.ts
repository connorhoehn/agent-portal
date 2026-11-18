// /api/interviews — Milo for you and the live transcript (docs/interviews-tenant-plan.md rows I3.6 and I3.7; decisions 4,
// 6, 8, 20; contract E5). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   GET  /interviews/:id/transcript?after=<seq>   the panel side of that interview (its seats, the recruiter, the
//                                                  opening's hiring manager) while it is `live` → { transcript }
//   GET  /interviews/:id/milo-notes               the seats of that interview while it is `live` → { notes }
//   POST /interviews/:id/milo-ask                 the lead only, ConductInterview, body { question } → { answer, refused,
//                                                  line, paused, retryAfterMs }
//   POST /interviews/:id/say                      row I3.5, contract U10: the lead only, ConductInterview, while `live`, body
//                                                  { questionId } → { said: 'spoken' | 'chat', line }. Milo asks one of the
//                                                  round's kit questions in the call: the words are the question's prompt READ
//                                                  FROM THE STORE (never from the body), logged, posted with the approved mark,
//                                                  then said aloud as approved words (lib/interviews/speak). 400 for a missing
//                                                  question id, 404 for a question not in this round, 409 with a sentence when
//                                                  Milo is not in the call.
//   POST /interviews/:id/milo-intro               the lead only, ConductInterview, while `live` → { said, line }. Milo says its
//                                                  fixed introduction (lib/interviews/speak/intro.ts) on the same path, once an
//                                                  interview: 409 { error } once it has, or while Milo is not in the call.
//   GET  /interviews/:id/milo-settings            the seats of that interview → { settings: { testCases }, introduced }
//   PUT  /interviews/:id/milo-settings            the lead only, ConductInterview, before the round ends, body { testCases }
//                                                  → { settings }: whether the candidate may ask Milo for test cases
//                                                  (lib/interviews/milo-settings.ts; off by default).
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
import { sayApproved, saidStore } from '../../lib/interviews/speak/index.js';
import { ALREADY_INTRODUCED, introduceMilo, introduced } from '../../lib/interviews/speak/intro.js';
import { miloSettingsStore } from '../../lib/interviews/milo-settings.js';
import { interviewsNowMs } from '../../lib/interviews/clock.js';
import { NOT_SAID_ALOUD } from '../../lib/meeting-assistant/approved-speech.js';

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

/** The lead reads one of these after "Have Milo ask" on a kit question. */
export const SAID_ALOUD = 'Milo asked it aloud. The question is in the call chat too.';
export const MILO_NOT_IN_CALL = 'Milo is not in this call. Invite Milo from the call bar, then try again.';
const BAD_QUESTION_ID = 'Choose a question from this round.';

miloRouter.post('/interviews/:id/say', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (!(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NOTHING_HERE);
  const p = await panelSide(req);
  if (!p || p.ref.interview.leadId !== p.userId || p.ref.interview.state !== 'live') throw new NotFoundError(NOTHING_HERE);
  res.setHeader('Cache-Control', 'no-store');
  const questionId = (req.body as Record<string, unknown> | undefined)?.['questionId'];
  if (typeof questionId !== 'string' || !/^[\w.:-]{1,120}$/.test(questionId)) { res.status(400).json({ error: BAD_QUESTION_ID }); return; }
  const { interview, opening } = p.ref;
  const chosen = interview.questionIds.length === 0 || interview.questionIds.includes(questionId);
  const question = chosen ? opening.kit.questions.find((q) => q.id === questionId) : undefined;
  if (!question || !question.prompt.trim()) throw new NotFoundError(BAD_QUESTION_ID);
  const { said } = await sayApproved(interview, { kind: 'question', source: 'kit', text: question.prompt.trim(), askedBy: p.userId, questionId: question.id });
  if (said === 'none') { res.status(409).json({ error: MILO_NOT_IN_CALL }); return; }
  res.json({ said, line: said === 'spoken' ? SAID_ALOUD : NOT_SAID_ALOUD });
}));

/** The lead reads one of these after "Introduce Milo". */
export const INTRODUCED_ALOUD = 'Milo introduced itself aloud. The words are in the call chat too.';

miloRouter.post('/interviews/:id/milo-intro', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (!(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NOTHING_HERE);
  const p = await panelSide(req);
  if (!p || p.ref.interview.leadId !== p.userId || p.ref.interview.state !== 'live') throw new NotFoundError(NOTHING_HERE);
  res.setHeader('Cache-Control', 'no-store');
  const out = await introduceMilo(p.ref.interview, p.userId);
  if (out === 'already') { res.status(409).json({ error: ALREADY_INTRODUCED }); return; }
  if (out.said === 'none') { res.status(409).json({ error: MILO_NOT_IN_CALL }); return; }
  res.json({ said: out.said, line: out.said === 'spoken' ? INTRODUCED_ALOUD : NOT_SAID_ALOUD });
}));

/** The states after the call: nothing of Milo's is set any more. */
const CLOSED = new Set(['ended', 'scored', 'reviewed', 'declined', 'cancelled']);
const BAD_SETTINGS = 'Send { "testCases": true } or { "testCases": false }.';

miloRouter.get('/interviews/:id/milo-settings', asyncHandler(async (req, res) => {
  const p = await panelSide(req);
  if (!p || !seatOf(p.ref.interview, p.userId)) throw new NotFoundError(NOTHING_HERE);
  res.setHeader('Cache-Control', 'no-store');
  const [settings, rows] = await Promise.all([miloSettingsStore().get(p.ref.interview.id), saidStore().list(p.ref.interview.id)]);
  res.json({ settings: { testCases: settings.testCases }, introduced: introduced(rows, interviewsNowMs(), false) });
}));

miloRouter.put('/interviews/:id/milo-settings', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (!(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NOTHING_HERE);
  const p = await panelSide(req);
  if (!p || p.ref.interview.leadId !== p.userId || CLOSED.has(p.ref.interview.state)) throw new NotFoundError(NOTHING_HERE);
  res.setHeader('Cache-Control', 'no-store');
  const testCases = (req.body as Record<string, unknown> | undefined)?.['testCases'];
  if (typeof testCases !== 'boolean') { res.status(400).json({ error: BAD_SETTINGS }); return; }
  const settings = await miloSettingsStore().setTestCases(p.ref.interview.id, testCases, p.userId, new Date(interviewsNowMs()).toISOString());
  res.json({ settings: { testCases: settings.testCases } });
}));
