// Promotions inbox — /api/promotions. The curation step between raw
// lab_experiences and the library: cluster → pattern → runbook/insight →
// (human + dry run) → skill.
//
// Reads are open — a candidate awaiting review is exactly the kind of thing
// the whole team should be able to see coming. The two writes graduate a
// candidate up the ladder or take it out of the queue, which is the same
// authority that stands up a standing mission from the fleet: ManageBots.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import { listCandidates, getCandidate, promoteCandidate, dismissCandidate } from '../providers/promotions.js';

export const promotionsRouter: Router = Router();

const manageGate = requireAction('ManageBots');

// GET /api/promotions?status=
promotionsRouter.get('/', asyncHandler(async (req, res) => {
  const status = String(req.query['status'] ?? '').trim();
  res.json({ candidates: await listCandidates(status ? { status } : {}) });
}));

// GET /api/promotions/:id
promotionsRouter.get('/:id', asyncHandler(async (req, res) => {
  const candidate = await getCandidate(String(req.params['id'] ?? ''));
  if (!candidate) throw new NotFoundError('promotion candidate not found');
  res.json(candidate);
}));

// POST /api/promotions/:id/promote {dryRunRunId?}
// Approval is implicit in who is calling — the session's own name, same rule
// as design-review sign-off. A skill is judged on a RECORDED dry-run: the run
// named by `dryRunRunId`, else the newest dry-run of its runbook definition
// (pipelines tenant, rule 1). `dryRunPassed` is no longer evidence — a client
// cannot assert that a run passed — so it is ignored when sent. A skill refused
// only for its dry-run still records the approval (see promoteCandidate) rather
// than making the reviewer re-approve on every retry.
promotionsRouter.post('/:id/promote', manageGate, asyncHandler(async (req, res) => {
  const { dryRunRunId } = (req.body ?? {}) as { dryRunRunId?: unknown };
  if (dryRunRunId !== undefined && dryRunRunId !== null && (typeof dryRunRunId !== 'string' || !dryRunRunId.trim())) {
    throw new ValidationError('dryRunRunId must be a run id string when provided');
  }
  const session = resolveSession(req);
  const result = await promoteCandidate(String(req.params['id'] ?? ''), {
    approvedBy: session?.name ?? session?.sub ?? 'someone',
    ...(typeof dryRunRunId === 'string' ? { dryRunRunId: dryRunRunId.trim() } : {}),
  });
  if (!result) throw new NotFoundError('promotion candidate not found');
  if ('error' in result && result.error) {
    res.status(409).json({ error: result.error });
    return;
  }
  res.json(result.candidate);
}));

// POST /api/promotions/:id/dismiss {reason}
promotionsRouter.post('/:id/dismiss', manageGate, asyncHandler(async (req, res) => {
  const { reason } = (req.body ?? {}) as { reason?: string };
  if (!String(reason ?? '').trim()) throw new ValidationError('reason is required');
  const candidate = await dismissCandidate(String(req.params['id'] ?? ''), String(reason).trim());
  if (!candidate) throw new NotFoundError('promotion candidate not found');
  res.json(candidate);
}));
