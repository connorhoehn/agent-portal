// POST /api/interviews/interviews/:id/plan-draft (docs/interviews-tenant-plan.md row I3.10; contract E6): Milo drafts which
// of the kit's questions to ask in this round. Mounted in routes/interviews.ts after the ViewInterviews gate.
//
// The lead only (ConductInterview plus the lead's seat), while the round is `accepted` or `ready` (409 with one plain line
// otherwise). A panel member, the recruiter, the hiring manager, another round's interviewer, the admin and a guest get the
// tenant's one not-found; another tenant's role is refused at the tenant's mount. The draft is advisory: nothing is saved
// here, the lead's own save is PUT /interviews/:id/questions. → { plan, paused, line }.
import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../../lib/async-handler.js';
import { isAllowed, resolveSession } from '../../lib/authz.js';
import { isGuestId } from '../../lib/interviews/milo-policy.js';
import { draftPlan } from '../../lib/interviews/plan/index.js';
import { indexFor, param } from '../../lib/interviews/request.js';

export const planRouter = Router();

const NO_INTERVIEW = 'There is no interview here that you can open.';

planRouter.post('/interviews/:id/plan-draft', asyncHandler(async (req, res) => {
  const session = resolveSession(req)!;
  if (!session.role || session.role === 'admin' || isGuestId(session.sub) || !(await isAllowed(session, 'ConductInterview'))) throw new NotFoundError(NO_INTERVIEW);
  const ix = await indexFor(req);
  const interview = ix.world.interviews.find((x) => x.id === param(req, 'id'));
  if (!interview || interview.leadId !== session.sub) throw new NotFoundError(NO_INTERVIEW);
  const opening = ix.openings.get(ix.applications.get(interview.applicationId)?.openingId ?? '');
  if (!opening) throw new NotFoundError(NO_INTERVIEW);
  res.setHeader('Cache-Control', 'no-store');
  const out = await draftPlan({ interview, opening }, { userId: session.sub });
  if (out.kind === 'not-found') throw new NotFoundError(NO_INTERVIEW);
  if (out.kind === 'not-preparable') { res.status(409).json({ error: out.body.line, ...out.body }); return; }
  res.json(out.body);
}));
