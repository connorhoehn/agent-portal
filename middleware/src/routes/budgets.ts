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
import type { RunLimitPatch } from '../providers/run-limits.js';
// Loaded on first use (DE-37): the route's tests mock providers/budgets, not this.
const runLimits = () => import('../providers/run-limits.js');
import {
  listBudgets, orgSummary, upsertAllocation, deleteAllocation, initiativeExists,
  listGrants, getBudget, type AllocationExtras,
} from '../providers/budgets.js';

/** A money field that may be absent (leave alone), null (back to the default) or a finite number >= 0. */
function optionalMoney(raw: unknown, name: string): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) throw new ValidationError(`${name} must be a finite number >= 0, or null`);
  return raw;
}

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

// ── Run limits (DE-37) ─────────────────────────────────────────────────────
// Per-initiative concurrency, runs per day and dollars per hour, judged inside
// every spend hold (lib/spend-holds.ts reserveSpend). Absent = no limit beyond
// the global bot-run ceiling. Declared before '/:orgProjectId'.

/** A limit field: absent (leave alone), null (clear) or a finite number >= 0 (integers for counts). */
function optionalLimit(raw: unknown, name: string, integer: boolean): number | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || (integer && !Number.isInteger(raw))) {
    throw new ValidationError(`${name} must be a${integer ? 'n integer' : ' finite number'} >= 0, or null`);
  }
  return raw;
}

async function limitsBody(orgProjectId: string) {
  const { getRunLimit, scopeUsage } = await runLimits();
  const [limit, usage] = await Promise.all([
    getRunLimit('initiative', orgProjectId),
    scopeUsage({ kind: 'initiative', id: orgProjectId }),
  ]);
  return {
    orgProjectId,
    maxConcurrent: limit?.maxConcurrent ?? null,
    maxRunsPerDay: limit?.maxRunsPerDay ?? null,
    maxUsdPerHour: limit?.maxUsdPerHour ?? null,
    updatedBy: limit?.updatedBy ?? null,
    updatedAt: limit?.updatedAt ?? null,
    usage: { liveSlots: usage.liveSlots, runsToday: usage.runsToday, usdLastHour: usage.usdLastHour },
  };
}

budgetsRouter.get('/:orgProjectId/limits', readGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.params['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');
  res.json({ limits: await limitsBody(orgProjectId) });
}));

budgetsRouter.put('/:orgProjectId/limits', manageGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.params['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: RunLimitPatch = {};
  const mc = optionalLimit(body['maxConcurrent'], 'maxConcurrent', true);
  if (mc !== undefined) patch.maxConcurrent = mc;
  const rpd = optionalLimit(body['maxRunsPerDay'], 'maxRunsPerDay', true);
  if (rpd !== undefined) patch.maxRunsPerDay = rpd;
  const uph = optionalLimit(body['maxUsdPerHour'], 'maxUsdPerHour', false);
  if (uph !== undefined) patch.maxUsdPerHour = uph;
  if (Object.keys(patch).length === 0) throw new ValidationError('send at least one of maxConcurrent, maxRunsPerDay, maxUsdPerHour');
  if (!await initiativeExists(orgProjectId)) throw new NotFoundError('No such initiative');
  await (await runLimits()).upsertRunLimit('initiative', orgProjectId, patch, req.session?.sub ?? null);
  res.json({ limits: await limitsBody(orgProjectId) });
}));

budgetsRouter.put('/:orgProjectId', manageGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.params['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');

  const reqBody = (req.body ?? {}) as { allocatedUsd?: unknown; hardCapUsd?: unknown; maintenanceReserveUsd?: unknown; allowFloorSpill?: unknown };
  const raw = reqBody.allocatedUsd;
  // Strictly a finite non-negative number — a string that would coerce, NaN,
  // or Infinity must not become the ceiling every spend read is judged against.
  const allocatedUsd = typeof raw === 'number' ? raw : NaN;
  if (!Number.isFinite(allocatedUsd) || allocatedUsd < 0) {
    throw new ValidationError('allocatedUsd must be a finite number >= 0');
  }

  // DE-36 hard cap and DE-55 reserve: each optional; null puts it back to the
  // deployment default (allocated x factor / the auto reserve).
  const extras: AllocationExtras = {};
  const hardCapUsd = optionalMoney(reqBody.hardCapUsd, 'hardCapUsd');
  if (hardCapUsd !== undefined) extras.hardCapUsd = hardCapUsd;
  const reserve = optionalMoney(reqBody.maintenanceReserveUsd, 'maintenanceReserveUsd');
  if (reserve !== undefined) extras.maintenanceReserveUsd = reserve;
  if (reqBody.allowFloorSpill !== undefined) {
    if (typeof reqBody.allowFloorSpill !== 'boolean') throw new ValidationError('allowFloorSpill must be a boolean');
    extras.allowFloorSpill = reqBody.allowFloorSpill;
  }

  if (!await initiativeExists(orgProjectId)) throw new NotFoundError('No such initiative');

  // A cap never sits below its allocation (the column CHECK agrees); an omitted
  // cap keeps the stored one, so it must still clear the new allocation.
  const capAfter = hardCapUsd === undefined ? (await getBudget(orgProjectId))?.hardCapUsd ?? null : hardCapUsd;
  if (capAfter != null && capAfter < allocatedUsd) {
    throw new ValidationError(`hardCapUsd ($${capAfter}) must be at least allocatedUsd ($${allocatedUsd}); raise or clear it`);
  }

  const updatedBy = req.session?.sub ?? null;
  const budget = await upsertAllocation(orgProjectId, allocatedUsd, updatedBy, extras);
  if (!budget) { res.status(503).json({ error: 'budgets require Aurora' }); return; }
  res.json({ budget });
}));

budgetsRouter.delete('/:orgProjectId', manageGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.params['orgProjectId'] ?? '').trim();
  const ok = await deleteAllocation(orgProjectId);
  if (!ok) throw new NotFoundError('No allocation for that initiative');
  res.json({ ok: true });
}));
