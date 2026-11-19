// /api/interviews — the pad log, the panel's side (docs/interviews-tenant-plan.md decision 12, row I4.3; decisions 4,
// 17; contract U3). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate.
//
//   POST /interviews/:id/pad/events   a seat (the lead or a panel member) holding ConductInterview, on a technical round
//                                     that is `live`; body { events: PadEventIn[] } (1 to 50) → { accepted }
//   GET  /interviews/:id/pad/log?after=<seq>
//                                     whoever may read that interview's record (its seats, a recruiter, the opening's
//                                     hiring manager, by the tenant's one scope rule; no admin exception, no guest), on
//                                     a technical round that is `live` or has ended → { events, lastSeq, more }
//
// Who wrote an event is the session's person with side `panel`, never the body; the server stamps `at`. Everyone
// outside gets the tenant's one not-found, whatever the reason (a behavioural round, another round's interviewer,
// another opening's hiring manager, a guest, a round not live for a write), so a URL confirms nothing. A post the
// rules refuse is 400 and nothing of it is stored; a post past the interview's caps is 200 with the extra not counted
// in `accepted`. The read is the panel's only (decision 4): the candidate has no read of the pad log.
import { Router, type Request } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { seatOf } from '../../lib/interviews/assign.js';
import { isGuestId } from '../../lib/interviews/milo-policy.js';
import { BAD_POST, appendPadEvents, checkPadPost, readPadLog } from '../../lib/interviews/pad/log/index.js';
import { RECORD_STATES } from '../../lib/interviews/record/index.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { reachOf } from '../../lib/interviews/scope.js';
import { INTERVIEWS_TENANT, type Interview } from '../../lib/interviews/types.js';
import type { WorldIndex } from '../../lib/interviews/views.js';
import { runWithDbTenant } from '../../providers/db-tenant.js';

export const padRouter = Router();

export const NO_PAD_HERE = 'There is no code pad here that you can open.';

/** The technical interview in this staff viewer's scope (never the admin, never a guest), with the index it was read from. */
export async function technicalInScope(req: Request): Promise<{ interview: Interview; ix: WorldIndex; userId: string; role: string } | null> {
  const session = resolveSession(req);
  if (!session || session.tenant !== INTERVIEWS_TENANT || !session.role || session.role === 'admin' || isGuestId(session.sub)) return null;
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!interview || interview.type !== 'technical') return null;
  // An interviewer's scope is already their own seats; this keeps a reassigned-away interviewer out too.
  if (reachOf(session.role) === 'nothing' || (reachOf(session.role) === 'assigned' && !seatOf(interview, session.sub))) return null;
  return { interview, ix, userId: session.sub, role: session.role };
}

padRouter.post('/interviews/:id/pad/events', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const session = resolveSession(req);
  if (!session || !(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NO_PAD_HERE);
  const p = await technicalInScope(req);
  const seated = p && (p.interview.leadId === p.userId || p.interview.panelIds.includes(p.userId));
  if (!p || !seated || p.interview.state !== 'live') throw new NotFoundError(NO_PAD_HERE);
  const events = checkPadPost(req.body);
  if (!events) { res.status(400).json({ error: BAD_POST }); return; }
  const accepted = await runWithDbTenant(INTERVIEWS_TENANT, () => appendPadEvents(p.interview.id, { id: p.userId, side: 'panel' }, events));
  res.json({ accepted });
}));

padRouter.get('/interviews/:id/pad/log', asyncHandler(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const p = await technicalInScope(req);
  if (!p || (p.interview.state !== 'live' && !RECORD_STATES.includes(p.interview.state))) throw new NotFoundError(NO_PAD_HERE);
  const raw = Number.parseInt(String(req.query['after'] ?? '0'), 10);
  const after = Number.isFinite(raw) && raw > 0 ? raw : 0;
  res.json(await runWithDbTenant(INTERVIEWS_TENANT, () => readPadLog(p.interview.id, after, (id) => p.ix.people(id).name)));
}));
