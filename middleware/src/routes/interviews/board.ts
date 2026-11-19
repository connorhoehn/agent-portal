// The whiteboard's checkpoints over REST (WHITEBOARD-PLAN step 1; lib/interviews/board/snapshots.ts).
//
//   POST /interviews/:id/board/snapshots   the lead's or a panel member's room posts the board's elements while the
//                                          round is live, and the lead's for a short grace after the end (its closing
//                                          checkpoint, mayCheckpoint); a repeat of the last one is not stored.
//   GET  /interviews/:id/board/snapshots   the checkpoints, oldest first, for the record page: the same viewers and
//                                          states as the pad log's read (routes/interviews/pad.ts).
//   POST /interviews/:id/board/reveal      the lead, while the round is live: the chosen question's provided design (its
//                                          answer key's board, lib/interviews/answer-key.ts) for the lead's room to put on
//                                          the shared board; the reveal is logged in the interview's pad log (kind `reveal`).
//
// The live board itself is the gateway's (lib/interviews/board/authority.ts); these routes never touch it.
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { checkBoardScene, mayCheckpoint, readBoardSnapshots, saveBoardSnapshot } from '../../lib/interviews/board/snapshots.js';
import { interviewsNowMs } from '../../lib/interviews/clock.js';
import { RECORD_STATES } from '../../lib/interviews/record/index.js';
import { NOTHING_TO_REVEAL, revealable } from '../../lib/interviews/answer-key.js';
import { appendPadEvents } from '../../lib/interviews/pad/log/service.js';
import { runWithDbTenant } from '../../providers/db-tenant.js';
import { INTERVIEWS_TENANT } from '../../lib/interviews/types.js';
import { technicalInScope } from './pad.js';

export const boardRouter = Router();

export const NO_BOARD_HERE = 'There is no whiteboard here that you can open.';
export const BAD_SCENE = 'The board could not be read.';

boardRouter.post('/interviews/:id/board/snapshots', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = resolveSession(req);
  if (!session || !(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NO_BOARD_HERE);
  const p = await technicalInScope(req);
  if (!p || !mayCheckpoint(p.interview, p.userId, interviewsNowMs())) throw new NotFoundError(NO_BOARD_HERE);
  const checked = checkBoardScene((req.body as { elements?: unknown } | undefined)?.elements);
  if (!checked) { res.status(400).json({ error: BAD_SCENE }); return; }
  res.json({ stored: await saveBoardSnapshot(p.interview.id, { id: p.userId, side: 'panel' }, checked) });
}));

boardRouter.get('/interviews/:id/board/snapshots', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const p = await technicalInScope(req);
  if (!p || (p.interview.state !== 'live' && !RECORD_STATES.includes(p.interview.state))) throw new NotFoundError(NO_BOARD_HERE);
  res.json({ snapshots: await readBoardSnapshots(p.interview.id, (id) => p.ix.people(id).name) });
}));

boardRouter.post('/interviews/:id/board/reveal', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = resolveSession(req);
  if (!session || !(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NO_BOARD_HERE);
  const p = await technicalInScope(req);
  if (!p) throw new NotFoundError(NO_BOARD_HERE);
  const app = p.ix.world.applications.find((a) => a.id === p.interview.applicationId);
  const opening = app ? p.ix.world.openings.find((o) => o.id === app.openingId) ?? null : null;
  const questionId = (req.body as { questionId?: unknown } | undefined)?.questionId;
  const board = revealable(p.interview, opening, p.userId, questionId);
  if (!board) throw new NotFoundError(NOTHING_TO_REVEAL);
  await runWithDbTenant(INTERVIEWS_TENANT, () => appendPadEvents(p.interview.id, { id: p.userId, side: 'panel' },
    [{ kind: 'reveal', clientAt: new Date(interviewsNowMs()).toISOString(), questionId: questionId as string }]));
  res.json({ board });
}));
