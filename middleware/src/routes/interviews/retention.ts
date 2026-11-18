// /api/interviews/candidates/:id/deletion(s) (docs/interviews-tenant-plan.md decision 17, row I6.3): a candidate's
// deletion request and the candidate's deletion log. Mounted in routes/interviews.ts with one line, after the router's
// ViewInterviews gate.
//
//   POST /candidates/:id/deletion    the recruiter (ManageCandidates, 403 for everyone else on every id alike), the
//                                    candidate in scope (404), body `{ confirm: true, scope?: 'recordings' | 'personal' }` (400 otherwise;
//                                    no scope means both, as before the two were separate). Runs the
//                                    deletion (lib/interviews/retention/service.ts) and answers `{ deletion, created }`:
//                                    a repeat answers the earlier row with `created: false`.
//   GET  /candidates/:id/deletions   the recruiter and the hiring manager of the candidate's opening: `{ items, periods }`,
//                                    newest first, with this deployment's periods (the profile's prompt states them). Everyone else, and a candidate outside scope: not-found.
//                                    Each row says whether it is late: `overdue` (not done by `dueBy`, now) and `doneLate` (finished after it).
// The admin is answered not-found on both: the log is the hiring side's record, as the consents are.
//
// The candidate cannot ask here: the notice tells them to ask the person who sent their link.

import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { interviewsAction } from '../../lib/interviews/gate.js';
import { indexFor, param, peopleLookup } from '../../lib/interviews/request.js';
import { deleteCandidateMedia, deletionsOf, scopeOfRow, type DeletionScope } from '../../lib/interviews/retention/service.js';
import { retentionPeriods } from '../../lib/interviews/retention/periods.js';
import type { DeletionRow } from '../../lib/interviews/retention/store.js';
import { doneLate, isOverdue } from '../../lib/interviews/retention/overdue.js';
import { interviewsNowMs } from '../../lib/interviews/clock.js';

export const retentionRouter = Router();

const NO_CANDIDATE = 'There is no candidate here that you can open.';
// A member without ManageCandidates reads the same not-found (lib/interviews/gate.ts), never a 403.
const manage = interviewsAction('ManageCandidates', NO_CANDIDATE);

/** What the profile reads of a row: no interview ids, no candidate id beyond the path's, no content. */
export interface DeletionView {
  id: string;
  reason: DeletionRow['reason'];
  requestedAt: string;
  requestedBy: { id: string; name: string } | null;
  dueBy: string;
  doneAt: string | null;
  interviews: number;
  removed: DeletionRow['removed'];
  left: DeletionRow['left'];
  /** Not done, and its `dueBy` has passed. */
  overdue: boolean;
  /** Done, but after its `dueBy`. */
  doneLate: boolean;
  /** What a request covered: the recordings, the personal data, or both (a request made before the two were separate). */
  scope: DeletionScope;
}

async function viewOf(rows: DeletionRow[], nowMs: number = interviewsNowMs()): Promise<DeletionView[]> {
  const people = await peopleLookup();
  return rows.map((r) => ({
    id: r.id, reason: r.reason, requestedAt: r.requestedAt, requestedBy: r.requestedBy ? people(r.requestedBy) : null,
    dueBy: r.dueBy, doneAt: r.doneAt, interviews: r.interviewIds.length, removed: r.removed, left: r.left,
    overdue: isOverdue(r, nowMs), doneLate: doneLate(r), scope: scopeOfRow(r),
  }));
}

/** The candidate's id when the viewer may open them and holds one of `roles`; otherwise not-found. */
async function candidateFor(req: Parameters<typeof indexFor>[0], roles: readonly string[]): Promise<string> {
  const session = resolveSession(req)!;
  const ix = await indexFor(req);
  const c = ix.candidates.get(param(req, 'id'));
  if (!c || !roles.includes(session.role)) throw new NotFoundError(NO_CANDIDATE);
  return c.id;
}

retentionRouter.post('/candidates/:id/deletion', manage, asyncHandler(async (req, res) => {
  const candidateId = await candidateFor(req, ['recruiter']);
  if ((req.body as { confirm?: unknown } | undefined)?.confirm !== true) {
    res.status(400).json({ error: 'Confirm the deletion to go ahead. Nothing was removed.' });
    return;
  }
  const asked = (req.body as { scope?: unknown }).scope;
  if (asked !== undefined && asked !== 'recordings' && asked !== 'personal') {
    res.status(400).json({ error: 'Say what to delete: the recordings, or the personal data. Nothing was removed.' });
    return;
  }
  const scope = asked ?? 'all';
  const { row, created } = await deleteCandidateMedia(candidateId, resolveSession(req)!.sub, {}, scope);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ deletion: (await viewOf([row]))[0], created });
}));

retentionRouter.get('/candidates/:id/deletions', asyncHandler(async (req, res) => {
  const candidateId = await candidateFor(req, ['recruiter', 'hiring-manager']);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: await viewOf(await deletionsOf(candidateId)), periods: retentionPeriods() });
}));
