// /api/interviews assignment writes (docs/interviews-tenant-plan.md row I1.4; decisions 2, 16 and 20): assign a
// round, answer a seat, reassign. The reads (GET /interviews, /interviews/:id) are in routes/interviews.ts; this
// sub-router is mounted there with one line, after the router's ViewInterviews gate.
//
// The same six steps as the openings writes (routes/interviews/openings.ts), in the same order:
//
//   1. the mount        requireTenant('interviews'), the server flag, ViewInterviews (routes/interviews.ts)
//   2. the authority    assigning and reassigning: requireAction('AssignInterviews'), the recruiter's (and the
//                       cross-tenant admin's). Answering: requireAction('ConductInterview'), the interviewer's.
//                       Both are already registered (lib/authz.ts CAPABILITY_ACTIONS: "assign and schedule a
//                       round", "accept, prepare, run, score an assigned round"), so this row adds no action.
//                       Refused for everyone else on every id alike (403), so it confirms nothing.
//   3. the row          in the viewer's scope (lib/interviews/scope.ts via indexFor), else 404: an interviewer
//                       without a seat on the round never learns it exists.
//   4. the input        checked by lib/interviews/assign.ts: 400 with `{ error, fields }`, one plain sentence per field.
//                       Answering also needs the seat: the session's own, never one named in the body, so a
//                       recruiter cannot accept for anyone; a viewer who sees the round but holds no seat on it
//                       (the cross-tenant admin) is refused (403).
//   5. the write        a compare-and-set against the revision the page loaded (store.ts InterviewWrites): 409
//                       with the row as it now is when someone else wrote first.
//   6. the answer       the row as the read route shapes it, from a fresh read; then the bell (lib/social-notify.ts),
//                       never awaited by the answer and never carrying anything about the candidate.

import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import {
  answerSeat, applyReassignment, assignProblemsLine, checkAnswer, checkAssignment, checkReassignment, checkTime, interviewIdFor, newInterview, newlySeated, timeProblemsLine,
} from '../../lib/interviews/assign.js';
import type { FieldProblem } from '../../lib/interviews/kit.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import type { WriteResult } from '../../lib/interviews/store.js';
import { INTERVIEWS_TENANT, type Interview } from '../../lib/interviews/types.js';
import { UNKNOWN_ROUND, type WorldIndex } from '../../lib/interviews/views.js';
import { notifyInterviewDeclined, notifyInterviewSeated, notifyInterviewTimed } from '../../lib/social-notify.js';
import { listUsers } from '../../providers/identity.js';

export const assignmentsRouter = Router();
const assign = requireAction('AssignInterviews');
const conduct = requireAction('ConductInterview');

const NO_INTERVIEW = 'There is no interview here that you can open.';
const STALE = 'Someone else changed this round while you were looking at it. It now shows what was saved: check it, then make your change again.';
const OUT_OF_DATE = 'This page is out of date. Reload it and make the change again.';

/** The people who may sit on a round: holders of the interviewer role in this tenant. */
async function interviewers(): Promise<Array<{ id: string; name: string }>> {
  return (await listUsers())
    .filter((u) => (u.grants[INTERVIEWS_TENANT] ?? []).includes('interviewer'))
    .map((u) => ({ id: u.id, name: u.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The people a decline is told to: holders of the recruiter role in this tenant. */
async function recruiters(): Promise<string[]> {
  return (await listUsers()).filter((u) => (u.grants[INTERVIEWS_TENANT] ?? []).includes('recruiter')).map((u) => u.id);
}

function refuse(res: Response, what: 'assign' | 'reassign' | 'answer', fields: FieldProblem[]): void {
  res.status(400).json({ error: assignProblemsLine(what, fields.length), fields });
}

function revisionOf(req: Request): number | null {
  const r = (req.body as Record<string, unknown> | undefined)?.['revision'];
  return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null;
}

/** What a bell may say about a round: the opening's title and the round's name. Nothing about the candidate. */
function bellWords(ix: WorldIndex, i: Interview): { openingTitle: string; roundName: string } {
  const opening = ix.openings.get(ix.applications.get(i.applicationId)?.openingId ?? '');
  return { openingTitle: opening?.title ?? 'an opening', roundName: opening?.kit.rounds.find((r) => r.id === i.roundId)?.name ?? UNKNOWN_ROUND };
}

/** Steps 5 and 6: the row as the viewer now reads it (null when the write took it out of their scope). */
async function answerWrite(req: Request, res: Response, result: WriteResult<Interview>, status = 200): Promise<WorldIndex | null> {
  if (!result.ok && result.reason === 'not-found') throw new NotFoundError(NO_INTERVIEW);
  const ix = await indexFor(req);
  const now = ix.world.interviews.find((i) => i.id === result.row.id);
  const row = now ? ix.interviewRow(now) : null;
  res.setHeader('Cache-Control', 'no-store');
  if (!result.ok) { res.status(409).json({ error: STALE, interview: row }); return null; }
  res.status(status).json({ interview: row });
  return ix;
}

/** Who the assign form may seat. */
assignmentsRouter.get('/interviewers', assign, asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: await interviewers() });
}));

/** Assign a round. Body: `{ applicationId, roundId, leadId, panelIds }`. The new round has no time (row I1.5 sets it). */
assignmentsRouter.post('/interviews', assign, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const checked = checkAssignment(req.body, ix.world, new Set((await interviewers()).map((p) => p.id)));
  if (!checked.ok) { refuse(res, 'assign', checked.problems); return; }
  const store = interviewsStore();
  const app = ix.applications.get(checked.value.applicationId)!;
  const opening = ix.openings.get(app.openingId)!;
  const id = interviewIdFor(new Set((await store.listInterviews()).map((i) => i.id)));
  const created = await store.createInterview(newInterview(checked.value, opening, id, session.sub, new Date().toISOString()));
  if (!created) { res.status(409).json({ error: 'Another round was assigned at the same moment. Try again.' }); return; }
  const after = await answerWrite(req, res, { ok: true, row: created }, 201);
  if (after) void notifyInterviewSeated({ interviewId: created.id, ...bellWords(after, created), userIds: [created.leadId, ...created.panelIds], actorId: session.sub, reassigned: false });
}));

/** Answer the seat the session holds. Body: `{ revision, answer: 'accept' | 'decline', reason? }`. */
assignmentsRouter.post('/interviews/:id/answer', conduct, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!i) throw new NotFoundError(NO_INTERVIEW);
  const revision = revisionOf(req);
  if (revision === null) { res.status(400).json({ error: OUT_OF_DATE, fields: [] }); return; }
  const checked = checkAnswer(req.body);
  if (!checked.ok) { refuse(res, 'answer', checked.problems); return; }
  // Answered against the row as the page saw it: a page older than the row is told so before anything else.
  if (i.revision !== revision) { await answerWrite(req, res, { ok: false, reason: 'stale', row: i }); return; }
  const out = answerSeat(i, session.sub, checked.value, new Date().toISOString());
  if (!out.ok) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(out.reason === 'no-seat' ? 403 : 409).json({ error: out.message, interview: ix.interviewRow(i) });
    return;
  }
  const words = bellWords(ix, i);
  const written = await interviewsStore().answerSeat(i.id, out.change, revision);
  await answerWrite(req, res, written);
  if (written.ok && checked.value.answer === 'decline') {
    void recruiters().then((ids) => notifyInterviewDeclined({ interviewId: i.id, ...words, recruiterIds: ids, declinerId: session.sub, seat: out.seat }));
  }
}));

/** Change who sits on a round. Body: `{ revision, leadId, panelIds }`. */
assignmentsRouter.put('/interviews/:id/panel', assign, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!i) throw new NotFoundError(NO_INTERVIEW);
  const revision = revisionOf(req);
  if (revision === null) { res.status(400).json({ error: OUT_OF_DATE, fields: [] }); return; }
  if (i.revision !== revision) { await answerWrite(req, res, { ok: false, reason: 'stale', row: i }); return; }
  const checked = checkReassignment(req.body, i, new Set((await interviewers()).map((p) => p.id)));
  if (!checked.ok) { refuse(res, 'reassign', checked.problems); return; }
  const written = await interviewsStore().reassign(i.id, applyReassignment(i, checked.value), revision);
  const after = await answerWrite(req, res, written);
  if (after && written.ok) {
    void notifyInterviewSeated({ interviewId: i.id, ...bellWords(after, i), userIds: newlySeated(i, checked.value), actorId: session.sub, reassigned: true });
  }
}));

/** Set, change or clear a round's time (row I1.5). Body: `{ revision, scheduledAt: ISO instant | null }`. Does not move the state. */
assignmentsRouter.put('/interviews/:id/time', assign, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!i) throw new NotFoundError(NO_INTERVIEW);
  const revision = revisionOf(req);
  if (revision === null) { res.status(400).json({ error: OUT_OF_DATE, fields: [] }); return; }
  if (i.revision !== revision) { await answerWrite(req, res, { ok: false, reason: 'stale', row: i }); return; }
  const checked = checkTime(req.body, i);
  if (!checked.ok) { res.status(400).json({ error: timeProblemsLine(checked.problems.length), fields: checked.problems }); return; }
  const written = await interviewsStore().setTime(i.id, checked.value.scheduledAt, revision);
  const after = await answerWrite(req, res, written);
  if (after && written.ok && checked.value.scheduledAt !== null && checked.value.scheduledAt !== i.scheduledAt) {
    void notifyInterviewTimed({ interviewId: i.id, ...bellWords(after, i), userIds: [i.leadId, ...i.panelIds], actorId: session.sub, changed: i.scheduledAt !== null });
  }
}));
