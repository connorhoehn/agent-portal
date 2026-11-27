// /api/interviews — cancelling a round, "did not take place", and withdrawing an application (gap audit 2026-11-20,
// section 1). Mounted in routes/interviews.ts with one line, after the router's ViewInterviews gate. The rules are
// lib/interviews/cancel.ts; the recruiter's End on an abandoned live round is the room's End (routes/interviews/room.ts).
//
//   POST /interviews/:id/cancel        the recruiter (AssignInterviews): a round not yet live → cancelled.
//                                      Body `{ revision, reason, note? }`.
//   POST /interviews/:id/not-held      the lead (ConductInterview, the lead's seat) or the recruiter (AssignInterviews):
//                                      a live round, or a not-yet-live round past its start → cancelled with reason
//                                      `no_show` or `did_not_take_place`. A live round's room closes as End closes it.
//                                      Body `{ revision, reason, note? }`.
//   POST /applications/:id/withdraw    the recruiter (ManageCandidates): the application → withdrawn; each of its
//                                      not-yet-live rounds → cancelled, reason `candidate_withdrew`. Body `{ basedOn, note? }`
//                                      (basedOn: the history length the page read, as the stage decision names it).
//
// No new action: cancelling and ending a round are arranging it (AssignInterviews, "assign and schedule a round"),
// withdrawing is the application's (ManageCandidates, "openings, candidates, applications"), and the lead's not-held
// is conducting it (ConductInterview). Anyone holding none of them, and anyone outside the tenant (the mount's
// requireTenant), reads the not-found (lib/interviews/gate.ts). Outside the viewer's scope the row is not found (404);
// a panel member is refused (403) because they know the round exists. Wrong state: 409 with the row. Writes are
// compare-and-set: 409 with the row as it now is. Each cancel rings the seats (lib/interviews/result-bells.ts).

import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { cancellationOf, cancelMove, checkCancel, checkNotHeld, checkWithdraw, isNotYetLive, notHeldMove, withdrawMove } from '../../lib/interviews/cancel.js';
import { interviewsAction, interviewsAnyAction } from '../../lib/interviews/gate.js';
import type { FieldProblem } from '../../lib/interviews/kit.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { interviewCancelled } from '../../lib/interviews/result-bells.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import type { WriteResult } from '../../lib/interviews/store.js';
import type { Interview } from '../../lib/interviews/types.js';
import { interviewsNow } from '../../lib/interviews/clock.js';
import { closeRoom } from './room.js';

export const cancelRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';
const NO_APPLICATION = 'There is no candidate here that you can open.';
const STALE = 'Someone else changed this round while you were looking at it. It now shows what was saved: check it, then try again.';
const OUT_OF_DATE = 'This page is out of date. Reload it and try again.';

const assign = interviewsAction('AssignInterviews', NO_INTERVIEW);
const conductOrAssign = interviewsAnyAction(['ConductInterview', 'AssignInterviews'], NO_INTERVIEW);
const manage = interviewsAction('ManageCandidates', NO_APPLICATION);

function revisionOf(req: Request): number | null {
  const r = (req.body as Record<string, unknown> | undefined)?.['revision'];
  return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null;
}

function refuse(res: Response, fields: FieldProblem[]): void {
  res.status(400).json({ error: fields.length === 1 ? fields[0]!.message : 'Some answers need another look.', fields });
}

async function answerWrite(req: Request, res: Response, result: WriteResult<Interview>): Promise<boolean> {
  if (!result.ok && result.reason === 'not-found') throw new NotFoundError(NO_INTERVIEW);
  const ix = await indexFor(req);
  const now = ix.world.interviews.find((i) => i.id === result.row.id);
  const row = now ? ix.interviewRow(now) : null;
  res.setHeader('Cache-Control', 'no-store');
  if (!result.ok) { res.status(409).json({ error: STALE, interview: row }); return false; }
  res.json({ interview: row });
  return true;
}

function cancelWrite(kind: 'cancel' | 'not-held') {
  return asyncHandler(async (req, res) => {
    const session = resolveSession(req)!;
    const ix = await indexFor(req);
    const i = ix.world.interviews.find((x) => x.id === param(req, 'id'));
    if (!i) throw new NotFoundError(NO_INTERVIEW);
    const now = interviewsNow();
    const asRecruiter = kind === 'cancel' || await isAllowed({ sub: session.sub, role: session.role, tenant: session.tenant }, 'AssignInterviews');
    const out = kind === 'cancel' ? cancelMove(i) : notHeldMove(i, session.sub, asRecruiter, now);
    if (!out.ok && out.reason === 'no-seat') throw new NotFoundError(NO_INTERVIEW);
    const revision = revisionOf(req);
    if (revision === null) { res.status(400).json({ error: OUT_OF_DATE, fields: [] }); return; }
    const checked = kind === 'cancel' ? checkCancel(req.body) : checkNotHeld(req.body);
    if (!checked.ok) { refuse(res, checked.problems); return; }
    if (!out.ok) {
      res.setHeader('Cache-Control', 'no-store');
      res.status(out.reason === 'not-lead' ? 403 : 409).json({ error: out.message, interview: ix.interviewRow(i) });
      return;
    }
    if (i.revision !== revision) { await answerWrite(req, res, { ok: false, reason: 'stale', row: i }); return; }
    const written = await interviewsStore().cancelInterview(i.id, cancellationOf(checked.value, session.sub, now.toISOString()), revision);
    // Every cancel closes the room, live or not: a candidate already waiting at the door holds a subscription and a
    // cached yes at the gateway, and both must go with the link.
    if (written.ok) await closeRoom(i.id);
    if (await answerWrite(req, res, written)) void interviewCancelled(i.id, session.sub);
  });
}

cancelRouter.post('/interviews/:id/cancel', assign, cancelWrite('cancel'));
cancelRouter.post('/interviews/:id/not-held', conductOrAssign, cancelWrite('not-held'));

cancelRouter.post('/applications/:id/withdraw', manage, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const app = ix.applications.get(param(req, 'id'));
  if (!app) throw new NotFoundError(NO_APPLICATION);
  const checked = checkWithdraw(req.body);
  if (!checked.ok) { refuse(res, checked.problems); return; }
  res.setHeader('Cache-Control', 'no-store');
  const move = withdrawMove(app, ix.world.interviews);
  if (!move.ok) { res.status(409).json({ error: move.message }); return; }
  const store = interviewsStore();
  const at = interviewsNow().toISOString();
  const decided = await store.decideStage(app.id, { stage: 'withdrawn', at, by: session.sub, reason: checked.value.note ?? 'The candidate withdrew.' }, checked.value.basedOn);
  if (!decided.ok) {
    if (decided.reason === 'not-found') throw new NotFoundError(NO_APPLICATION);
    res.status(409).json({ error: 'Someone else changed this candidate while you were looking at it. Reload and try again.' });
    return;
  }
  // Each not-yet-live round is cancelled against the revision just read; a round someone changed meanwhile is read again once.
  const cancelled: string[] = [];
  for (const i of move.toCancel) {
    const cancellation = { reason: 'candidate_withdrew' as const, note: null, by: session.sub, at };
    let r = await store.cancelInterview(i.id, cancellation, i.revision);
    if (!r.ok && r.reason === 'stale' && isNotYetLive(r.row.state)) {
      r = await store.cancelInterview(i.id, cancellation, r.row.revision);
    }
    if (r.ok) { cancelled.push(i.id); await closeRoom(i.id); }
  }
  res.json({ application: { id: app.id, stage: decided.row.stage }, cancelled });
  for (const id of cancelled) void interviewCancelled(id, session.sub);
}));
