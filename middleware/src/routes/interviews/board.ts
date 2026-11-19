// The whiteboard's checkpoints over REST (WHITEBOARD-PLAN step 1; lib/interviews/board/snapshots.ts).
//
//   POST /interviews/:id/board/snapshots   the lead's or a panel member's room posts the board's elements while the
//                                          round is live; a repeat of the last one, or one past the cap, is not stored.
//   GET  /interviews/:id/board/snapshots   the checkpoints, oldest first, for the record page: the same viewers and
//                                          states as the pad log's read (routes/interviews/pad.ts).
//
// The live board itself is the gateway's (lib/interviews/board/authority.ts); this route never touches it.
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { checkBoardScene, readBoardSnapshots, saveBoardSnapshot } from '../../lib/interviews/board/snapshots.js';
import { RECORD_STATES } from '../../lib/interviews/record/index.js';
import { technicalInScope } from './pad.js';

export const boardRouter = Router();

export const NO_BOARD_HERE = 'There is no whiteboard here that you can open.';
export const BAD_SCENE = 'The board could not be read.';

boardRouter.post('/interviews/:id/board/snapshots', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = resolveSession(req);
  if (!session || !(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NO_BOARD_HERE);
  const p = await technicalInScope(req);
  const seated = p && (p.interview.leadId === p.userId || p.interview.panelIds.includes(p.userId));
  if (!p || !seated || p.interview.state !== 'live') throw new NotFoundError(NO_BOARD_HERE);
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
