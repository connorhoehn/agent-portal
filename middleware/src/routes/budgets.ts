// Budgets — /api/budgets
//
// The program-manager's surface: per-initiative monthly agent-spend
// allocations beside the actuals derived from bot_runs. The list includes
// initiatives spending with no allocation — those are the blind spots this
// page exists to surface.
//
// Gated in two tiers:
//   reads  — operational visibility (the ledger + org summary): org-leader +
//            hr-admin, like the other read-wide surfaces.
//   writes — allocating agent spend is program management: ManageBudgets.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction } from '../lib/authz.js';
import {
  listBudgets, orgSummary, upsertAllocation, deleteAllocation, initiativeExists,
  listGrants,
} from '../providers/budgets.js';

export const budgetsRouter: Router = Router();

const readGate = readForRolesElseAction(['org-leader', 'hr-admin', 'program-owner'], 'ManageBudgets');
const manageGate = requireAction('ManageBudgets');

budgetsRouter.get('/', readGate, asyncHandler(async (_req, res) => {
  const [budgets, summary] = await Promise.all([listBudgets(), orgSummary()]);
  res.json({ budgets, summary });
}));

// A silent clamp, applied to the RESPONSE only — never inside listGrants()
// itself. lib/bot-runner.ts's envelope brake calls listGrants() unscoped
// (no orgProjectId) to find one person's grants across every initiative, and
// capping that read would make the brake miss a real grant past the cut. The
// route is the only caller that ships the whole list to a client, so the
// bound belongs here.
function clampGrantsLimit(raw: unknown): number {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2000) : 500;
}

// Sprint envelopes: which SME holds how much, on which sprint. Declared
// before '/:orgProjectId' so "grants" is never read as an initiative id.
budgetsRouter.get('/grants', readGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.query['orgProjectId'] ?? '').trim();
  const limit = clampGrantsLimit(req.query['limit']);
  const grants = await listGrants(orgProjectId || undefined);
  res.json({ grants: grants.slice(0, limit) });
}));

budgetsRouter.put('/:orgProjectId', manageGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.params['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');

  const raw = (req.body as { allocatedUsd?: unknown } ?? {}).allocatedUsd;
  // Strictly a finite non-negative number — a string that would coerce, NaN,
  // or Infinity must not become the ceiling every spend read is judged against.
  const allocatedUsd = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(allocatedUsd) || allocatedUsd < 0) {
    throw new ValidationError('allocatedUsd must be a finite number >= 0');
  }

  if (!await initiativeExists(orgProjectId)) throw new NotFoundError('No such initiative');

  const updatedBy = req.session?.sub ?? null;
  const budget = await upsertAllocation(orgProjectId, allocatedUsd, updatedBy);
  if (!budget) { res.status(503).json({ error: 'budgets require Aurora' }); return; }
  res.json({ budget });
}));

budgetsRouter.delete('/:orgProjectId', manageGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.params['orgProjectId'] ?? '').trim();
  const ok = await deleteAllocation(orgProjectId);
  if (!ok) throw new NotFoundError('No allocation for that initiative');
  res.json({ ok: true });
}));
