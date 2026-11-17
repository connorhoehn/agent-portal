// PUT /api/interviews/:id/questions (docs/interviews-tenant-plan.md row I1.7; contract C6): the lead chooses a
// round's questions, in order. Mounted in routes/interviews.ts after the ViewInterviews gate.
//
// The same steps as the assignment writes (routes/interviews/assignments.ts): the authority (ConductInterview,
// the interviewer's action), the row in the viewer's scope (else 404), the seat (a panel member or anyone else
// who can see the round but does not lead it: 403), the input (lib/interviews/prepare.ts: 400 with plain
// sentences), the compare-and-set (409 with the row as it now is), and the answer (the interview record).
// The state it leaves is `ready` or `accepted` by prepare.ts readyState.

import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { checkQuestions, mayChoose, questionsProblemsLine, readyState } from '../../lib/interviews/prepare.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';

export const prepareRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';
const NOT_LEAD = 'Only the lead of this round chooses its questions.';
const STALE = 'Someone else changed this round while you were looking at it. It now shows what was saved: check it, then make your change again.';
const OUT_OF_DATE = 'This page is out of date. Reload it and make the change again.';

function revisionOf(req: Request): number | null {
  const r = (req.body as Record<string, unknown> | undefined)?.['revision'];
  return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null;
}

prepareRouter.put('/interviews/:id/questions', requireAction('ConductInterview'), asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!i) throw new NotFoundError(NO_INTERVIEW);
  res.setHeader('Cache-Control', 'no-store');
  if (!mayChoose(i, session.sub)) { res.status(403).json({ error: NOT_LEAD }); return; }
  const revision = revisionOf(req);
  if (revision === null) { res.status(400).json({ error: OUT_OF_DATE, fields: [] }); return; }
  const kit = ix.openings.get(ix.applications.get(i.applicationId)?.openingId ?? '')?.kit;
  if (!kit) throw new NotFoundError(NO_INTERVIEW);
  const record = async (): Promise<unknown> => {
    const now = (await indexFor(req));
    const row = now.world.interviews.find((x) => x.id === i.id);
    return row ? now.interviewRecord(row) : null;
  };
  if (i.revision !== revision) { res.status(409).json({ error: STALE, interview: ix.interviewRecord(i) }); return; }
  const checked = checkQuestions(req.body, i, kit);
  if (!checked.ok) { res.status(400).json({ error: questionsProblemsLine(checked.problems.length), fields: checked.problems }); return; }
  const state = readyState({ state: i.state, scheduledAt: i.scheduledAt, questionIds: checked.value.questionIds });
  const written = await interviewsStore().setQuestions(i.id, checked.value.questionIds, state, revision);
  if (!written.ok && written.reason === 'not-found') throw new NotFoundError(NO_INTERVIEW);
  if (!written.ok) { res.status(409).json({ error: STALE, interview: await record() }); return; }
  res.json({ interview: await record() });
}));
