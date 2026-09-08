// Eval sets — intended mount: /api/library/evals (same tenant/session gates
// as libraryRouter in index.ts; not wired here — that mount is the library
// owner's, per the task boundary this file was built under).
//
// Reads are open — an eval set and its run history are exactly the kind of
// context a reviewer needs before trusting the pass rate shown in the
// drawer. Running the suite is gated: it writes eval_pass_rate, which is a
// release-gate input, so it carries the same authority as dispatching agent
// work (ManageCanary — the action every other prompt-quality mutation in
// this codebase already uses).

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { requireAction, resolveSession } from '../lib/authz.js';
import { listEvalSets, listRuns, getEvalRun, runEvals } from '../providers/prompt-evals.js';

export const promptEvalsRouter: Router = Router();

// GET /:assetId/cases
promptEvalsRouter.get('/:assetId/cases', asyncHandler(async (req, res) => {
  const assetId = String(req.params['assetId'] ?? '');
  res.json({ cases: await listEvalSets(assetId) });
}));

// GET /:assetId/runs
promptEvalsRouter.get('/:assetId/runs', asyncHandler(async (req, res) => {
  const assetId = String(req.params['assetId'] ?? '');
  res.json({ runs: await listRuns(assetId) });
}));

// POST /:assetId/run  { version: string }
// Runs the asset's eval set now and persists the resulting pass rate onto
// prompt_version_meta, best-effort — see runEvals for why that write can
// fail without failing the request.
// ManageBots, not ManageCanary: running an eval set is an AUTHORING act, not a
// rollout. Gating it on the canary capability meant an SME could create a
// library asset (they hold ManageBots and DispatchAgentRun) but never run the
// eval the release gate demands — authoring something you are structurally
// unable to make shippable. Rollout authority stays separate.
promptEvalsRouter.post('/:assetId/run', requireAction('ManageBots'), asyncHandler(async (req, res) => {
  const assetId = String(req.params['assetId'] ?? '');
  const { version } = (req.body ?? {}) as { version?: string };
  if (!String(version ?? '').trim()) throw new ValidationError('version is required');

  const session = resolveSession(req);
  const run = await runEvals(assetId, String(version).trim(), session?.name ?? session?.sub ?? 'someone');
  res.json(run);
}));

// GET /runs/:runId
promptEvalsRouter.get('/runs/:runId', asyncHandler(async (req, res) => {
  const run = await getEvalRun(String(req.params['runId'] ?? ''));
  if (!run) throw new NotFoundError('eval run not found');
  res.json(run);
}));
