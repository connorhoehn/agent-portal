// Budgets — /api/budgets
//
// The program-manager's surface: per-initiative agent-spend allocations (per
// period: monthly by default, or quarterly / sprint / rolling with optional
// carry-over — DE-38) beside the actuals derived from bot_runs. The list includes
// initiatives spending with no allocation — those are the blind spots this
// page exists to surface.
//
// Gated in two tiers:
//   reads  — operational visibility (the ledger + org summary): org-leader +
//            hr-admin, like the other read-wide surfaces.
//   writes — allocating agent spend is program management: ManageBudgets.
//            A program-owner only on initiatives they own (lib/budget-scope.ts,
//            docs/next-steps.md §9 item 8a).
//
// Every row carries `threshold` ({ percent, reached }: spent + held against the
// budget, and the highest of BUDGET_THRESHOLDS reached; lib/budget-thresholds.ts),
// and the list carries the configured `thresholds`, so the page marks a row near
// or at its cap by the same rule the bell announces it.
//
// The organisation's lines (docs/learning-loop-design.md "Budgets"):
//   GET /api/budgets/lines      the learning line (spent and held of its monthly
//                               cap) and local compute (reported, not billed)
//   PUT /api/budgets/learning   { monthlyCapUsd: number | null } — the learning
//                               cap; ManageBudgets AND an org-wide role, since
//                               it is the whole organisation's money

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import { readForRolesElseAction, requireAction, resolveSession } from '../lib/authz.js';
import { requireBudgetScope } from '../lib/budget-scope.js';
import type { RunLimitPatch } from '../providers/run-limits.js';
// Loaded on first use (DE-37): the route's tests mock providers/budgets, not this.
const runLimits = () => import('../providers/run-limits.js');
import {
  listBudgets, orgSummary, upsertAllocation, deleteAllocation, initiativeExists,
  listGrants, getBudget, periodsSupported, type AllocationExtras,
} from '../providers/budgets.js';
import {
  BUDGET_PERIODS, CARRY_OVER_POLICIES, MAX_ROLLING_DAYS, MIN_ROLLING_DAYS, budgetedAllocation, isBudgetPeriod, isCarryOver,
} from '../lib/budget-periods.js';
import { configuredThresholds, thresholdState } from '../lib/budget-threshold-rules.js';
// Loaded on first use, like run limits: each reads config, which this route's
// CommonJS test build (budgets.test.ts mocks providers/budgets only) must not load.
const budgetLines = () => import('../providers/budget-lines.js');
/** The roles that act for the whole organisation (lib/initiative-scope.ts ORG_WIDE_INITIATIVE_ROLES). */
const ORG_WIDE_ROLES = ['org-leader', 'hr-admin', 'admin'];

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
  const thresholds = configuredThresholds();
  res.json({
    budgets: budgets.map((b) => ({
      ...b,
      threshold: thresholdState(b.spentThisPeriodUsd + (b.floorHeldUsd ?? 0) + (b.discretionaryHeldUsd ?? 0), budgetedAllocation(b), thresholds),
    })),
    summary,
    thresholds,
  });
}));

// The organisation's lines this calendar month. Declared before '/:orgProjectId'.
budgetsRouter.get('/lines', readGate, asyncHandler(async (_req, res) => {
  const { getLearningCap, learningHeldUsd, learningSpentThisMonth, lineMonth, localReportedThisMonth } = await budgetLines();
  const [cap, spent, held, local] = await Promise.all([
    getLearningCap(), learningSpentThisMonth(), learningHeldUsd(), localReportedThisMonth(),
  ]);
  res.set('Cache-Control', 'no-store');
  res.json({
    month: lineMonth().key,
    learning: {
      capUsd: cap.capUsd,
      capSource: cap.source,
      spentUsd: spent.spentUsd,
      entries: spent.entries,
      heldUsd: held,
      remainingUsd: Math.round((cap.capUsd - spent.spentUsd - held) * 10_000) / 10_000,
      threshold: thresholdState(spent.spentUsd + held, cap.capUsd),
      updatedBy: cap.updatedBy,
      updatedAt: cap.updatedAt,
    },
    local,
  });
}));

// The learning cap: the whole organisation's money, so a program-owner (who
// holds ManageBudgets only within their own initiatives) may not set it.
budgetsRouter.put('/learning', manageGate, asyncHandler(async (req, res) => {
  const session = resolveSession(req);
  if (!session || !ORG_WIDE_ROLES.includes(session.role)) {
    res.status(403).json({
      error: 'the learning budget is the whole organisation\'s: only an org leader sets it',
      code: 'NOT_ORG_WIDE', action: 'ManageBudgets', role: session?.role ?? null,
    });
    return;
  }
  const raw = ((req.body ?? {}) as { monthlyCapUsd?: unknown }).monthlyCapUsd;
  if (raw === undefined) throw new ValidationError('monthlyCapUsd is required: a finite number >= 0, or null for the default');
  const cap = optionalMoney(raw, 'monthlyCapUsd');
  const after = await (await budgetLines()).setLearningCap(cap ?? null, session.sub ?? null);
  res.json({ learning: { capUsd: after.capUsd, capSource: after.source, updatedBy: after.updatedBy, updatedAt: after.updatedAt } });
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
  const grants = (await listGrants(orgProjectId || undefined)).slice(0, limit);
  // The row's mark is the spend in the sprint window against the grant. The bell
  // (lib/budget-thresholds.ts) also counts the envelope's money in flight, so a
  // row can read one step under the item that announced it while runs are open.
  const thresholds = configuredThresholds();
  res.json({
    grants: grants.map((g) => ({ ...g, threshold: thresholdState(g.initiativeSpendInWindowUsd, g.allocatedUsd, thresholds) })),
  });
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
  if (!await requireBudgetScope(req, res, orgProjectId)) return;
  await (await runLimits()).upsertRunLimit('initiative', orgProjectId, patch, req.session?.sub ?? null);
  res.json({ limits: await limitsBody(orgProjectId) });
}));

budgetsRouter.put('/:orgProjectId', manageGate, asyncHandler(async (req, res) => {
  const orgProjectId = String(req.params['orgProjectId'] ?? '').trim();
  if (!orgProjectId) throw new ValidationError('orgProjectId is required');

  const reqBody = (req.body ?? {}) as {
    allocatedUsd?: unknown; hardCapUsd?: unknown; maintenanceReserveUsd?: unknown; allowFloorSpill?: unknown;
    period?: unknown; rollingDays?: unknown; carryOver?: unknown; carryOverCapUsd?: unknown;
  };
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

  // DE-38 period policy, each optional (absent = leave alone).
  const policyFields = reqBody.period !== undefined || reqBody.rollingDays !== undefined
    || reqBody.carryOver !== undefined || reqBody.carryOverCapUsd !== undefined;
  if (reqBody.period !== undefined) {
    if (!isBudgetPeriod(reqBody.period)) throw new ValidationError(`period must be one of: ${BUDGET_PERIODS.join(', ')}`);
    extras.period = reqBody.period;
  }
  if (reqBody.rollingDays !== undefined) {
    const d = reqBody.rollingDays;
    if (d !== null && (typeof d !== 'number' || !Number.isInteger(d) || d < MIN_ROLLING_DAYS || d > MAX_ROLLING_DAYS)) {
      throw new ValidationError(`rollingDays must be an integer from ${MIN_ROLLING_DAYS} to ${MAX_ROLLING_DAYS}, or null`);
    }
    extras.rollingDays = d as number | null;
  }
  if (reqBody.carryOver !== undefined) {
    if (!isCarryOver(reqBody.carryOver)) throw new ValidationError(`carryOver must be one of: ${CARRY_OVER_POLICIES.join(', ')}`);
    extras.carryOver = reqBody.carryOver;
  }
  const carryCap = optionalMoney(reqBody.carryOverCapUsd, 'carryOverCapUsd');
  if (carryCap !== undefined) extras.carryOverCapUsd = carryCap;

  if (!await initiativeExists(orgProjectId)) throw new NotFoundError('No such initiative');
  if (!await requireBudgetScope(req, res, orgProjectId)) return;

  const needsBefore = hardCapUsd === undefined || policyFields;
  const before = needsBefore ? await getBudget(orgProjectId) : null;

  if (policyFields) {
    if (!await periodsSupported()) {
      res.status(503).json({ error: 'budget periods require schema/budget_periods_schema.sql on this cluster' });
      return;
    }
    // The combination the stored row will hold (the period_shape CHECK agrees).
    const stored = before?.allocatedUsd != null ? before : null;
    const period = extras.period ?? (stored?.period as typeof extras.period) ?? 'monthly';
    const rolling = extras.rollingDays !== undefined ? extras.rollingDays : stored?.rollingDays ?? null;
    const carry = extras.carryOver ?? stored?.carryOver ?? 'none';
    if (period === 'rolling' && rolling == null) throw new ValidationError('a rolling period needs rollingDays');
    if (period !== 'rolling' && extras.rollingDays != null) throw new ValidationError('rollingDays applies only to period "rolling"');
    if (period === 'rolling' && carry !== 'none') {
      throw new ValidationError('a rolling period never ends, so nothing carries over; set carryOver to "none"');
    }
  }

  // A cap never sits below its allocation (the column CHECK agrees); an omitted
  // cap keeps the stored one, so it must still clear the new allocation.
  const capAfter = hardCapUsd === undefined ? before?.hardCapUsd ?? null : hardCapUsd;
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
  if (!await requireBudgetScope(req, res, orgProjectId)) return;
  const ok = await deleteAllocation(orgProjectId);
  if (!ok) throw new NotFoundError('No allocation for that initiative');
  res.json({ ok: true });
}));
