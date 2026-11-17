// /api/interviews openings writes (docs/interviews-tenant-plan.md, row I1.3; decision 2): create an
// opening, edit its details, replace its kit. The reads (GET /openings, /openings/:id) are in
// routes/interviews.ts. Mounted there with one line, after the router's ViewInterviews gate.
//
// The tenant's first write path, and the pattern later writes copy. Every write runs the same checks
// in the same order, and stops at the first that fails:
//
//   1. the mount        requireTenant('interviews'), the server flag, ViewInterviews (routes/interviews.ts)
//   2. the authority    requireAction('ManageCandidates'): the recruiter's (and the cross-tenant admin's).
//                       Refused for everyone else on every id alike (403), so it confirms nothing.
//   3. the row          in the viewer's scope (lib/interviews/scope.ts via indexFor), else 404
//   4. the input        checked and cleaned by lib/interviews/kit.ts: 400 with `{ error, fields }`,
//                       one plain sentence per field, keyed by the path the editor maps to its field
//   5. the write        a compare-and-set against the revision the editor loaded (store.ts "Writes"):
//                       409 with the revision now saved when someone else saved first
//   6. the answer       the record as the read route shapes it, from a fresh read
//
// The opening's money (row I0.6): GET /openings/:id/spend answers its caps and what is held, spent and left
// (lib/interviews/spend.ts) to the recruiter, the opening's hiring manager and the admin. Every other reader of the
// opening, an interviewer included, gets the not-found: the money is not theirs to see, and the answer confirms nothing.
// The caps are edited with the details (PUT /openings/:id/details: `budgetCapUsd` and `interviewCapUsd`).
//
// The opening's authority is ManageCandidates rather than an action of its own: the registration
// (lib/authz.ts CAPABILITY_ACTIONS) already names openings under it, and decision 2 gives openings and
// candidates to the same one role.

import { Router, type Request, type Response } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { requireAction, resolveSession } from '../../lib/authz.js';
import { INTERVIEWS_TENANT } from '../../lib/interviews/types.js';
import { EMPTY_KIT, checkKit, checkOpeningDetails, kitInUse, openingIdFor, problemsLine, type FieldProblem } from '../../lib/interviews/kit.js';
import { indexFor, param } from '../../lib/interviews/request.js';
import { openingMoney } from '../../lib/interviews/spend.js';
import { interviewsStore } from '../../lib/interviews/store-select.js';
import type { WriteResult } from '../../lib/interviews/store.js';
import type { Opening } from '../../lib/interviews/types.js';
import { listUsers } from '../../providers/identity.js';

export const openingsRouter = Router();
const manage = requireAction('ManageCandidates');

const NO_OPENING = 'There is no opening here that you can open.';
const STALE = 'Someone else saved this opening while you were editing. Your changes are still on the page: reload to see theirs, then make yours again.';
const OUT_OF_DATE = 'This page is out of date. Reload it and make the change again.';

/** The people who may be named an opening's hiring manager: holders of the role in this tenant. */
async function hiringManagers(): Promise<Array<{ id: string; name: string }>> {
  return (await listUsers())
    .filter((u) => (u.grants[INTERVIEWS_TENANT] ?? []).includes('hiring-manager'))
    .map((u) => ({ id: u.id, name: u.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function refuse(res: Response, what: 'kit' | 'details' | 'opening', fields: FieldProblem[]): void {
  res.status(400).json({ error: problemsLine(what, fields.length), fields });
}

/** The revision the editor loaded: a whole number, or the page is too old to write from. */
function revisionOf(req: Request): number | null {
  const r = (req.body as Record<string, unknown> | undefined)?.['revision'];
  return typeof r === 'number' && Number.isInteger(r) && r >= 1 ? r : null;
}

/** Steps 5 and 6: what the compare-and-set did, answered as the read route would shape the row. */
async function answerWrite(req: Request, res: Response, result: WriteResult<Opening>): Promise<void> {
  if (!result.ok && result.reason === 'not-found') throw new NotFoundError(NO_OPENING);
  if (!result.ok) { res.status(409).json({ error: STALE, revision: result.row.revision }); return; }
  const ix = await indexFor(req);
  const o = ix.openings.get(result.row.id);
  if (!o) throw new NotFoundError(NO_OPENING);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ opening: ix.openingRecord(o) });
}

/** Who the details form may name as hiring manager. */
openingsRouter.get('/hiring-managers', manage, asyncHandler(async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ items: await hiringManagers() });
}));

/** Create an opening with an empty kit; the recruiter fills the kit next. */
openingsRouter.post('/openings', manage, asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  const checked = checkOpeningDetails(req.body, new Set((await hiringManagers()).map((p) => p.id)));
  if (!checked.ok) { refuse(res, 'opening', checked.problems); return; }
  const store = interviewsStore();
  const taken = new Set((await store.listOpenings()).map((o) => o.id));
  const id = openingIdFor(checked.value.title, taken);
  const created = await store.createOpening({ ...checked.value, id, recruiterId: session.sub, openedAt: new Date().toISOString(), kit: EMPTY_KIT });
  if (!created) { res.status(409).json({ error: 'Another opening with this title was created at the same moment. Try again.' }); return; }
  const ix = await indexFor(req);
  const o = ix.openings.get(created.id);
  if (!o) throw new NotFoundError(NO_OPENING);
  res.setHeader('Cache-Control', 'no-store');
  res.status(201).json({ opening: ix.openingRecord(o) });
}));

/** Who reads an opening's money: its recruiters, its hiring manager (scope already narrows them to their own openings) and the admin. */
const MONEY_READERS = new Set(['recruiter', 'hiring-manager', 'admin']);

/** The opening's caps and what is held, spent and left. Not found for anyone who may not read its money. */
openingsRouter.get('/openings/:id/spend', asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const o = ix.openings.get(param(req, 'id'));
  if (!o || !MONEY_READERS.has(resolveSession(req)!.role)) throw new NotFoundError(NO_OPENING);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ spend: await openingMoney(o) });
}));

/** Replace an opening's details (everything but the kit). Body: `{ revision, title, level, team, location, hiringManagerId, state, budgetCapUsd, interviewCapUsd }`. */
openingsRouter.put('/openings/:id/details', manage, asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const o = ix.openings.get(param(req, 'id'));
  if (!o) throw new NotFoundError(NO_OPENING);
  const revision = revisionOf(req);
  if (revision === null) { res.status(400).json({ error: OUT_OF_DATE, fields: [] }); return; }
  const checked = checkOpeningDetails(req.body, new Set((await hiringManagers()).map((p) => p.id)));
  if (!checked.ok) { refuse(res, 'details', checked.problems); return; }
  await answerWrite(req, res, await interviewsStore().updateOpeningDetails(o.id, checked.value, revision));
}));

/** Replace an opening's kit as a whole. Body: `{ revision, kit: { rounds, competencies, questions } }`. */
openingsRouter.put('/openings/:id/kit', manage, asyncHandler(async (req, res) => {
  const ix = await indexFor(req);
  const o = ix.openings.get(param(req, 'id'));
  if (!o) throw new NotFoundError(NO_OPENING);
  const revision = revisionOf(req);
  if (revision === null) { res.status(400).json({ error: OUT_OF_DATE, fields: [] }); return; }
  const checked = checkKit((req.body as Record<string, unknown>)['kit'], o.kit, kitInUse(ix.world, o.id));
  if (!checked.ok) { refuse(res, 'kit', checked.problems); return; }
  await answerWrite(req, res, await interviewsStore().replaceOpeningKit(o.id, checked.value, revision));
}));
