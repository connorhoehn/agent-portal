// Spend holds — the one chokepoint (DE-34, docs/budget-system-analysis-2026-10-28.md §6 item 4).
//
// Every path that spends model money calls `reserveSpend` before its first
// side effect: the marketplace dispatch (routes/bots.ts, before dispatchWorkItem),
// a bot firing (lib/bot-runner.ts fireBot, before markBotRan), the job
// dispatcher (between claimNextJob and markRunning), an ad-hoc box task
// (routes/devbox.ts runTaskAndForward, before InvokeRuntime) and a governed run
// started directly (lib/sdlc-pipeline.ts dispatchGovernedRun, before startRun).
// It takes the initiative lock, then the grant lock, reads the allocation, the
// ledger spend, the unknown-cost count and the money already held, judges the
// forecast with the existing pure decisions, and writes the hold — one
// transaction, so the check and the hold cannot drift. The two soft brakes that
// used to live in the dispatch route live here now; their 409 shapes are the
// route's to render from the result.
//
// ── Decisions this encodes (recorded in the goal doc) ────────────────────────
// - Unattributed spend (no initiative) is judged only by its spender's user
//   budget (DE-54) and held against it; with no user budget it takes no hold
//   and is judged by nothing, as before. `SPEND_HOLDS_UNATTRIBUTED` picks what
//   happens when nobody at all is known (docs/next-steps.md §9 item 1):
//   `actor` (the default) charges the actor and refuses only spend with
//   neither an initiative nor an actor (a service call); `allow` lets that
//   through unjudged too (local mock profiles); `refuse` refuses every spend
//   with no initiative, the actor's included (a hardened deploy).
// - An unreadable hold store (table not yet applied) proceeds unheld and logs,
//   as before DE-34; `SPEND_HOLDS_FAIL_CLOSED=1` (or BUDGET_FAIL_CLOSED, on by
//   default in production) refuses with 503.
// - Unreadable budget state — allocation, envelope or user budget — answers
//   503 `budget-state` where BUDGET_FAIL_CLOSED is on (DE-36); elsewhere the
//   pre-DE-36 posture holds (missing table = unbraked, envelope errors logged).
// - `SPEND_HOLDS=off` keeps the brakes but writes no holds.
// - Hard caps (DE-36) are judged before every soft brake and no confirm flag
//   opens them: initiative (allocation-cap), grant (envelope-cap), user
//   (user-cap). A null cap is allocated x BUDGET_HARD_CAP_FACTOR.
// - An essential bot's scheduled firing (DE-55) is judged against the
//   initiative's maintenance reserve, spilling into discretionary money while
//   `allow_floor_spill`; never against an envelope or a user budget. Every
//   other path is judged against the discretionary remainder. A scheduled
//   firing refused by either records a skipped run (lib/bot-runner.ts).
// - The lock order is initiative → grant → user ('user:'||sub); unattributed
//   spend takes the user key alone.

import { randomUUID } from 'node:crypto';
import { clock } from '../mock/core/index.js';
import { readBudgetGate, unknownCostCountInPeriod, type BudgetRow } from '../providers/budgets.js';
import { budgetedAllocation } from './budget-periods.js';
import { readUserBudgetGate, type UserBudgetRow, type UserSpend } from '../providers/user-budgets.js';
import {
  budgetFailClosed, decideFloorFire, decideHardCap, decideUserBudget, discretionary, effectiveHardCap,
} from './budget-decisions.js';
import { runCostSamples } from '../providers/bots.js';
import {
  withSpendLock, openHeldSplit, openHeldUsdForActor, openHeldUsdForGrant, spendHoldsEnabled, spendHoldsFailClosed,
  missingHoldsTable, getHold, topUpSourceId, type HoldSource, type HoldBasis, type SpendLockTx,
} from '../providers/spend-holds.js';
import { RunMeter, runCutoffEnabled, type RunCutoff } from './run-meter.js';
import { pauseFor, pauseMessage } from './fleet-switches.js';
import { emitFleetMetric } from './fleet-metrics.js';
import { decideRunLimits, runLimitsEnabled, scopesFor, type LimitKind, type ScopeState } from './run-limits.js';
import { readRunLimits, scopeUsage, scopeKey, slotLockKey, type RunScope } from '../providers/run-limits.js';
import {
  decideAllocation, decideEnvelope, loadEnvelopeGate,
  type AllocationForecast, type ResolvedEnvelope,
} from './bot-runner.js';
import type { ForecastConfidence } from './bot-estimate.js';
import { selectDispatchForecast, type ForecastSamples } from './marketplace-estimate.js';

export interface ReserveSpendInput {
  /** The initiative charged. Null = unattributed: no initiative brake; held
   *  only against the actor's user budget when they have one (DE-54), else
   *  no hold at all. With no actor either it is refused unless
   *  SPEND_HOLDS_UNATTRIBUTED=allow; `refuse` refuses it even with an actor. */
  initiativeId: string | null;
  /** Who is spending: the session subject or principal.requestedBy. Null for a cron firing. */
  actorId: string | null;
  source: HoldSource;
  /** The ledger key of the attempt, when it is known before the side effect
   *  (box tasks, jobs). Bot runs and governed runs bind it after their row exists. */
  sourceId?: string | null;
  forecast: AllocationForecast;
  /** The route's confirm flags. Absent = nothing confirmed. No flag opens a hard cap. */
  confirmed?: { allocation?: boolean; envelope?: boolean; userBudget?: boolean };
  /** false = hold for visibility only, never refuse (a reply inside a governed run). Default true. */
  judge?: boolean;
  /** An essential bot's scheduled firing (DE-55): judged against the
   *  initiative's maintenance reserve (spilling into discretionary money while
   *  allowed) instead of the allocation brake, never against an envelope or a
   *  user budget — cron spend never charges a user. */
  essential?: boolean;
  /** true = an unknown-cost run in the window trips a brake on its own (DE-33).
   *  Default FALSE: only POST /api/bots/dispatch-work, whose deck renders the
   *  gate, opts in. Box tasks, bot firings, the job dispatcher and governed
   *  runs cannot confirm it, so for them only a real overrun refuses. */
  unknownCostTrips?: boolean;
  /** How long the hold may stay open: the path's run ceiling plus grace. */
  expiresInMs: number;
  /** 'topup' = one more p75 asked for mid-run by the run meter (DE-35): judged
   *  exactly like the start, with nothing confirmed, and recorded as a top-up. */
  basis?: 'topup';
  /** The tenant charged for run limits (DE-37). Default 'orgiq', the only tenant that dispatches devbox work. */
  tenant?: string;
}

export interface AllocationGateBody {
  orgProjectId: string;
  /** DE-38: the EFFECTIVE allocation (stored allocation + carry in). */
  allocatedUsd: number;
  /** DE-38: the carry the current period started with, and its window key. */
  carryInUsd?: number;
  periodKey?: string | null;
  /** Everything spent this period (floor + discretionary). */
  spentUsd: number;
  /** Everything held on the initiative (floor + discretionary). */
  heldUsd: number;
  /** What the brake judged: the discretionary remainder (DE-55). Equals
   *  allocated - spent - held whenever the floor has spent past its reserve. */
  remainingUsd: number;
  unknownCostCount: number;
  /** DE-36: the cap enforced (stored, else allocated x the factor). */
  hardCapUsd: number | null;
  /** DE-55. */
  reserveUsd: number;
  floorSpentUsd: number;
  floorHeldUsd: number;
  discretionarySpentUsd: number;
  discretionaryHeldUsd: number;
  discretionaryRemainingUsd: number;
}

export interface EnvelopeGateBody {
  orgProjectId: string;
  grantId: string;
  sprintId: string | null;
  sprintName: string | null;
  allocatedUsd: number;
  attributedSpentUsd: number;
  heldUsd: number;
  remainingUsd: number;
  attributionAvailable: boolean;
  unknownCostCount: number;
  /** DE-36: the cap enforced. */
  hardCapUsd: number | null;
}

/** DE-54: the user's own monthly budget, in the 409 / 403 bodies as `userBudget`. */
export interface UserBudgetGateBody {
  userId: string;
  period: 'monthly';
  allocatedUsd: number;
  /** The cap enforced (stored, else allocated x the factor). */
  hardCapUsd: number | null;
  spentUsd: number;
  heldUsd: number;
  remainingUsd: number;
  unknownCostCount: number;
}

export type CapGate = 'allocation-cap' | 'envelope-cap' | 'user-cap' | 'maintenance-reserve';

export type ReserveSpendResult =
  /** The money is held (or holds are off / the spend is unattributed and unbudgeted: holdId null). */
  | { kind: 'held'; holdId: string | null; initiativeId: string | null; grantId: string | null; amountUsd: number; spill?: boolean }
  /** A soft brake: the route answers 409 with the gate, flag and figures. */
  | {
    kind: 'confirm'; gate: 'allocation' | 'envelope' | 'user-budget';
    confirmFlag: 'confirmOverAllocation' | 'confirmOverEnvelope' | 'confirmOverUserBudget';
    reason: string; confidence: ForecastConfidence;
    allocation?: AllocationGateBody; envelope?: EnvelopeGateBody; userBudget?: UserBudgetGateBody;
  }
  /** A hard cap (DE-36), or an essential firing the reserve cannot fund
   *  (DE-55): 403, no confirm flag. A scheduled firing records it as a skip. */
  | {
    kind: 'capped'; gate: CapGate; reason: string;
    capUsd: number; spentUsd: number; heldUsd: number; amountUsd: number;
    allocation?: AllocationGateBody; envelope?: EnvelopeGateBody; userBudget?: UserBudgetGateBody;
  }
  /** Not allowed to spend here at all (unattributed, refused by config): 403. */
  | { kind: 'refused'; reason: string }
  /** A run limit (DE-37): concurrency, runs per day or dollars per hour. 429 + Retry-After, no confirm flag. */
  | { kind: 'limited'; reason: string; scope: RunScope; limitKind: LimitKind; limit: number; current: number; retryAfterS: number }
  /** A kill switch (DE-50): the fleet or this initiative is paused. 423. */
  | { kind: 'paused'; reason: string; scope: string }
  /** The hold store (`spend-hold`) or the budget state (`budget-state`, DE-36)
   *  could not be read and the deployment fails closed: 503. */
  | { kind: 'unavailable'; reason: string; gate?: 'spend-hold' | 'budget-state' };

class SlotTakenError extends Error {
  constructor(readonly key: string) { super(`run slot at ${key} was taken concurrently`); }
}

function parseScopeKey(key: string): RunScope {
  const at = key.indexOf(':');
  return { kind: key.slice(0, at) as RunScope['kind'], id: key.slice(at + 1) };
}

/** Five minutes of grace past a path's run ceiling before a hold expires. */
export const HOLD_GRACE_MS = 5 * 60_000;

export type UnattributedRule = 'actor' | 'allow' | 'refuse';

/** SPEND_HOLDS_UNATTRIBUTED: `actor` (default, and for any unknown value), `allow` or `refuse`. */
export function unattributedRule(): UnattributedRule {
  const v = (process.env['SPEND_HOLDS_UNATTRIBUTED'] ?? '').trim().toLowerCase();
  return v === 'refuse' || v === 'allow' ? v : 'actor';
}

let warnedMissing = false;

/**
 * The p75 a path holds for a model, through the same forecast chain the
 * marketplace and bot fires use (selectDispatchForecast): the repo's run
 * history when there is one, the model's, else the static prior. Box tasks
 * and queued jobs carry no story points, so this is the run-level figure.
 */
export async function forecastP75ForModel(model: string | null | undefined, agentProjectId: string | null = null): Promise<AllocationForecast> {
  // The runtime's default model is Haiku (lib/devbox-runner.ts DevboxRunOptions).
  const m = model && model.trim() ? model : 'haiku';
  let samples: ForecastSamples = { perPointRepo: null, perPointModel: null, runRepo: null, runModel: null };
  try {
    samples = {
      perPointRepo: null, perPointModel: null,
      runRepo: agentProjectId ? await runCostSamples(m, agentProjectId) : null,
      runModel: await runCostSamples(m, null),
    };
  } catch (err) {
    console.warn(`[spend-holds] no run history for ${m}: ${(err as Error).message}`);
  }
  const f = selectDispatchForecast(m, null, samples);
  return { costUsdP75: f.estimate.costUsdP75, costUsdP25: f.estimate.costUsdP25, confidence: f.confidence };
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function allocationBody(orgProjectId: string, row: BudgetRow, held: { floorUsd: number; discretionaryUsd: number }, unknownCostCount: number): AllocationGateBody {
  // DE-38: the effective allocation (allocation + carry in), what every brake judges.
  const allocatedUsd = budgetedAllocation(row) ?? 0;
  const reserveUsd = row.reserveUsd ?? 0;
  const floorSpentUsd = row.floorSpentUsd ?? 0;
  const discretionarySpentUsd = row.discretionarySpentUsd ?? row.spentThisPeriodUsd;
  const { discretionaryRemainingUsd } = discretionary({
    allocatedUsd, reserveUsd, floorSpentUsd, floorHeldUsd: held.floorUsd,
    discretionarySpentUsd, discretionaryHeldUsd: held.discretionaryUsd,
  });
  return {
    orgProjectId, allocatedUsd, spentUsd: row.spentThisPeriodUsd, heldUsd: round4(held.floorUsd + held.discretionaryUsd),
    remainingUsd: discretionaryRemainingUsd, unknownCostCount,
    hardCapUsd: effectiveHardCap(budgetedAllocation(row), row.hardCapUsd ?? null, { unbudgeted: true })?.capUsd ?? null,
    reserveUsd, floorSpentUsd, floorHeldUsd: held.floorUsd, discretionarySpentUsd, discretionaryHeldUsd: held.discretionaryUsd,
    discretionaryRemainingUsd,
    ...(row.carryInUsd !== undefined ? { carryInUsd: row.carryInUsd, periodKey: row.periodKey ?? null } : {}),
  };
}

function envelopeBody(orgProjectId: string, e: ResolvedEnvelope, heldUsd: number): EnvelopeGateBody {
  return {
    orgProjectId, grantId: e.grantId, sprintId: e.sprintId, sprintName: e.sprintName ?? null,
    allocatedUsd: e.allocatedUsd, attributedSpentUsd: e.attributedSpentUsd, heldUsd,
    remainingUsd: e.allocatedUsd - e.attributedSpentUsd - heldUsd,
    attributionAvailable: e.attributionAvailable, unknownCostCount: e.attributedUnknownCount ?? 0,
    hardCapUsd: effectiveHardCap(e.allocatedUsd, e.hardCapUsd ?? null)?.capUsd ?? null,
  };
}

function userBudgetBody(userId: string, row: UserBudgetRow, spend: UserSpend, heldUsd: number): UserBudgetGateBody {
  return {
    userId, period: 'monthly', allocatedUsd: row.allocatedUsd,
    hardCapUsd: effectiveHardCap(row.allocatedUsd, row.hardCapUsd)?.capUsd ?? null,
    spentUsd: spend.spentUsd, heldUsd, remainingUsd: round4(row.allocatedUsd - spend.spentUsd - heldUsd),
    unknownCostCount: spend.unknownCount,
  };
}

const BUDGET_STATE_REASON = 'Budget state could not be read. No work was started.';

function missingTable(err: unknown): boolean {
  return /does not exist|relation/i.test((err as Error)?.message ?? '');
}

/**
 * Judge and hold. See the module header for where it is called and why the
 * reads happen after the lock: each sees every hold committed by the dispatch
 * it waited on, which is the whole point.
 *
 * Order (DE-36): gather every limit's state under its lock (initiative →
 * grant → user), then the HARD caps (initiative, grant, user — no flag opens
 * them), then the soft brakes (allocation or, for an essential firing, the
 * maintenance reserve; envelope; user budget), then the hold.
 */
export async function reserveSpend(input: ReserveSpendInput): Promise<ReserveSpendResult> {
  const judge = input.judge !== false;
  const essential = input.essential === true;
  const unknownOpts = { unknownCostTrips: input.unknownCostTrips === true };
  const confirmed = {
    allocation: input.confirmed?.allocation === true,
    envelope: input.confirmed?.envelope === true,
    userBudget: input.confirmed?.userBudget === true,
  };
  const amountUsd = Math.max(0, input.forecast.costUsdP75);
  const failClosed = budgetFailClosed();
  // Cron spend never charges a user (DE-54): an essential firing carries no
  // actor for budgeting even if one were passed.
  const actor = essential ? null : input.actorId;
  const judgeUser = judge && actor != null;
  const pid = input.initiativeId;

  // ── 0. Kill switches (DE-50): before anything else, every path ────────────
  try {
    const paused = await pauseFor(pid);
    if (paused) return { kind: 'paused', scope: paused.scope, reason: pauseMessage(paused) };
  } catch (err) {
    if (failClosed) return { kind: 'unavailable', gate: 'budget-state', reason: BUDGET_STATE_REASON };
    console.warn(`[spend-holds] could not read the kill switches: ${(err as Error).message}`);
  }

  if (!pid) {
    const rule = unattributedRule();
    if (rule === 'refuse') {
      return { kind: 'refused', reason: 'this spend is charged to no initiative, and unattributed spend is refused here' };
    }
    if (rule === 'actor' && !actor) {
      return { kind: 'refused', reason: 'this spend is charged to no initiative and to no user, and spend nobody answers for is refused here' };
    }
    // Unattributed spend answers only to its spender's user budget.
    if (!judgeUser) return { kind: 'held', holdId: null, initiativeId: null, grantId: null, amountUsd };
  }

  const body = async (tx: SpendLockTx | null): Promise<ReserveSpendResult> => {
    // ── 1. The initiative: allocation, cap, reserve, and the money in flight ─
    // An initiative with NO allocation row is still unbraked by the soft brake
    // (unbudgeted is not zero-budget); DE-36's unbudgeted cap is its only limit.
    // A hold that may not refuse (judge: false) reads no budget at all.
    let row: BudgetRow | null = null;
    let held = { floorUsd: 0, discretionaryUsd: 0 };
    if (pid && judge) {
      const g = await readBudgetGate(pid);
      if (g.kind === 'unavailable') {
        if (failClosed) return { kind: 'unavailable', gate: 'budget-state', reason: BUDGET_STATE_REASON };
        // Pre-DE-36 posture: a missing table reads as no allocation; any other error is loud.
        if (!missingTable(g.error)) throw g.error;
      } else if (g.kind === 'ok') row = g.row;
      if (tx) held = await openHeldSplit(pid);
    }

    // ── 2. The caller's own sprint envelope (human paths only) ──────────────
    // The grant lock is taken AFTER the initiative lock, always.
    let envelope: ResolvedEnvelope | null = null;
    let grantHeld = 0;
    if (pid && actor) {
      const eg = await loadEnvelopeGate(pid, actor);
      if (eg.kind === 'unavailable') {
        if (judge && failClosed) return { kind: 'unavailable', gate: 'budget-state', reason: BUDGET_STATE_REASON };
        console.warn(`[spend-holds] could not resolve the sprint envelope for ${pid}: ${eg.reason}`);
      } else if (eg.kind === 'ok') {
        envelope = eg.envelope;
        if (tx) await tx.lock(`grant:${envelope.grantId}`);
        grantHeld = tx && judge ? await openHeldUsdForGrant(envelope.grantId) : 0;
      }
    }

    // ── 3. The spender's user budget (DE-54), third lock ────────────────────
    let ub: { row: UserBudgetRow; spend: UserSpend } | null = null;
    let userHeld = 0;
    if (judgeUser) {
      // Unattributed spend took this key as its first (and only) lock.
      if (tx && pid) await tx.lock(`user:${actor}`);
      const u = await readUserBudgetGate(actor);
      if (u.kind === 'unavailable') {
        if (failClosed) return { kind: 'unavailable', gate: 'budget-state', reason: BUDGET_STATE_REASON };
        if (!missingTable(u.error)) console.warn(`[spend-holds] could not read the user budget for ${actor}: ${u.reason}`);
      } else if (u.kind === 'ok') {
        ub = { row: u.row, spend: u.spend };
        userHeld = tx ? await openHeldUsdForActor(actor) : 0;
      }
    }
    if (!pid && !ub) return { kind: 'held', holdId: null, initiativeId: null, grantId: null, amountUsd };

    const initiativeHeld = round4(held.floorUsd + held.discretionaryUsd);
    let unknownCostCount = 0;
    // DE-38: null between sprints (the allocation is not in force) — unbudgeted, no soft brake.
    const allocated = row ? budgetedAllocation(row) : null;
    if (pid && allocated != null && judge && !essential) unknownCostCount = await unknownCostCountInPeriod(pid);
    const allocation = pid && row && allocated != null ? allocationBody(pid, row, held, unknownCostCount) : null;
    const envBody = envelope ? envelopeBody(pid!, envelope, grantHeld) : null;
    const userBody = ub ? userBudgetBody(actor!, ub.row, ub.spend, userHeld) : null;
    // Each refusal carries the figures of the limit it names, and only those:
    // the 409s stay distinguishable by body as well as by gate.
    const forAllocation = allocation ? { allocation } : {};
    const forEnvelope = envBody ? { envelope: envBody } : {};
    const forUser = userBody ? { userBudget: userBody } : {};

    // ── 3b. Run limits (DE-37): hard, before every money gate ──────────────
    // Slot locks come after the money locks, narrowest scope first, so the
    // order is total: initiative → grant → user → slots.
    const slotted: string[] = [];
    if (judge && input.basis !== 'topup' && runLimitsEnabled()) {
      const plan = scopesFor({
        initiativeId: pid, tenant: input.tenant ?? 'orgiq',
        boxTask: input.source === 'box_task' || input.source === 'agent_loop',
      });
      const limits = await readRunLimits(plan.map((p) => p.scope));
      if (limits.length > 0) {
        const states: ScopeState[] = [];
        for (const p of plan) {
          const limit = limits.find((l) => l.scopeKind === p.scope.kind && l.scopeId === p.scope.id);
          if (!limit) continue;
          const key = scopeKey(p.scope);
          const holdsSlot = p.takesSlot && limit.maxConcurrent != null;
          if (holdsSlot && tx) { await tx.lock(slotLockKey(key)); slotted.push(key); }
          states.push({ scope: p.scope, limit, usage: await scopeUsage(p.scope), takesSlot: holdsSlot });
        }
        const v = decideRunLimits(states, amountUsd);
        if (v.kind === 'refuse') {
          return { kind: 'limited', reason: v.reason, scope: v.scope, limitKind: v.limitKind, limit: v.limit, current: v.current, retryAfterS: v.retryAfterS };
        }
      }
    }

    let basis: HoldBasis = input.basis === 'topup' ? 'topup' : 'p75';
    let spill = false;
    if (judge) {
      // ── 4. Hard caps (DE-36): before the soft brakes, no confirm flag ─────
      if (pid) {
        const cap = effectiveHardCap(allocated, row?.hardCapUsd ?? null, { unbudgeted: true });
        if (cap) {
          const spentUsd = row?.spentThisPeriodUsd ?? 0;
          const d = decideHardCap({ capUsd: cap.capUsd, spentUsd, heldUsd: initiativeHeld, amountUsd }, 'this initiative');
          if (d.kind === 'refuse') {
            return { kind: 'capped', gate: 'allocation-cap', reason: d.reason, capUsd: cap.capUsd, spentUsd, heldUsd: initiativeHeld, amountUsd, ...forAllocation };
          }
        }
      }
      if (envelope) {
        const cap = effectiveHardCap(envelope.allocatedUsd, envelope.hardCapUsd ?? null);
        if (cap) {
          const d = decideHardCap({ capUsd: cap.capUsd, spentUsd: envelope.attributedSpentUsd, heldUsd: grantHeld, amountUsd }, 'your sprint envelope');
          if (d.kind === 'refuse') {
            return { kind: 'capped', gate: 'envelope-cap', reason: d.reason, capUsd: cap.capUsd, spentUsd: envelope.attributedSpentUsd, heldUsd: grantHeld, amountUsd, ...forEnvelope };
          }
        }
      }
      if (ub) {
        const cap = effectiveHardCap(ub.row.allocatedUsd, ub.row.hardCapUsd);
        if (cap) {
          const d = decideHardCap({ capUsd: cap.capUsd, spentUsd: ub.spend.spentUsd, heldUsd: userHeld, amountUsd }, 'your user budget');
          if (d.kind === 'refuse') {
            return { kind: 'capped', gate: 'user-cap', reason: d.reason, capUsd: cap.capUsd, spentUsd: ub.spend.spentUsd, heldUsd: userHeld, amountUsd, ...forUser };
          }
        }
      }

      // ── 5. The initiative: reserve for the floor, discretionary for the rest
      if (row && allocated != null && allocation) {
        const figures = {
          allocatedUsd: allocated, reserveUsd: allocation.reserveUsd,
          floorSpentUsd: allocation.floorSpentUsd, floorHeldUsd: held.floorUsd,
          discretionarySpentUsd: allocation.discretionarySpentUsd, discretionaryHeldUsd: held.discretionaryUsd,
        };
        if (essential) {
          const f = decideFloorFire({ ...figures, allowSpill: row.allowFloorSpill !== false, amountUsd });
          if (f.kind === 'skip') {
            return {
              kind: 'capped', gate: 'maintenance-reserve', reason: f.reason, capUsd: allocation.reserveUsd,
              spentUsd: allocation.floorSpentUsd, heldUsd: held.floorUsd, amountUsd, ...forAllocation,
            };
          }
          spill = f.spill;
        } else {
          const state = {
            allocatedUsd: allocated, spentUsd: allocation.discretionarySpentUsd, heldUsd: held.discretionaryUsd,
            unknownCostCount, floorUsd: discretionary(figures).floorUsd,
          };
          const unconfirmed = decideAllocation(state, input.forecast, false, unknownOpts);
          if (unconfirmed.kind === 'confirm') {
            if (!confirmed.allocation) {
              return { kind: 'confirm', gate: 'allocation', confirmFlag: 'confirmOverAllocation', reason: unconfirmed.reason, confidence: unconfirmed.confidence, ...forAllocation };
            }
            basis = 'confirmed_over';
          }
        }
      }

      // ── 6. The envelope ────────────────────────────────────────────────────
      if (envelope && envBody) {
        const unconfirmed = decideEnvelope({ ...envelope, heldUsd: grantHeld }, input.forecast, false, unknownOpts);
        if (unconfirmed.kind === 'confirm') {
          if (!confirmed.envelope) {
            return { kind: 'confirm', gate: 'envelope', confirmFlag: 'confirmOverEnvelope', reason: unconfirmed.reason, confidence: unconfirmed.confidence, ...forEnvelope };
          }
          basis = 'confirmed_over';
        }
      }

      // ── 7. The user budget (across every initiative) ─────────────────────
      if (ub && userBody) {
        const unconfirmed = decideUserBudget(
          { allocatedUsd: ub.row.allocatedUsd, spentUsd: ub.spend.spentUsd, heldUsd: userHeld, unknownCount: ub.spend.unknownCount },
          input.forecast, false, unknownOpts,
        );
        if (unconfirmed.kind === 'confirm') {
          if (!confirmed.userBudget) {
            return { kind: 'confirm', gate: 'user-budget', confirmFlag: 'confirmOverUserBudget', reason: unconfirmed.reason, confidence: unconfirmed.confidence, ...forUser };
          }
          basis = 'confirmed_over';
        }
      }
    }

    const grantId = envelope?.grantId ?? null;
    if (!tx) return { kind: 'held', holdId: null, initiativeId: pid, grantId, amountUsd, ...(spill ? { spill } : {}) };
    const expiresAt = new Date(clock.now().getTime() + input.expiresInMs).toISOString();
    const hold = await tx.insertHold({
      initiativeId: pid, grantId, actorId: input.actorId, source: input.source,
      sourceId: input.sourceId ?? null, amountUsd, basis, essential, expiresAt,
    });
    // The concurrency leases (DE-37), held by the hold: they free when the run
    // releases them, when the hold closes, or at the hold's expiry.
    for (const key of slotted) {
      if (!await tx.insertSlot(key, hold.id, expiresAt)) throw new SlotTakenError(key);
    }
    return { kind: 'held', holdId: hold.id, initiativeId: pid, grantId, amountUsd, ...(spill ? { spill } : {}) };
  };

  if (!spendHoldsEnabled()) return body(null);
  try {
    return await withSpendLock([pid ? `spend:${pid}` : `user:${actor}`], body);
  } catch (err) {
    // The slot's primary key refused us despite the lock (a writer that did
    // not take it): the whole hold rolled back; say so as the limit it is.
    if (err instanceof SlotTakenError) {
      return { kind: 'limited', reason: `a concurrent run took the last slot at ${err.key}; try again`, scope: parseScopeKey(err.key), limitKind: 'concurrency', limit: 0, current: 0, retryAfterS: 30 };
    }
    if (missingHoldsTable(err)) {
      if (spendHoldsFailClosed()) {
        return { kind: 'unavailable', gate: 'spend-hold', reason: 'Spend holds could not be recorded, so nothing was started. Apply schema/spend_holds_schema.sql or set SPEND_HOLDS=off.' };
      }
      if (!warnedMissing) {
        warnedMissing = true;
        console.warn('[spend-holds] spend_holds is not applied here; brakes judge settled spend only until it is');
      }
      return body(null);
    }
    throw err;
  }
}

export { spendRefusalResponse } from './spend-refusal.js';

/**
 * The mid-run meter for a run that holds money (DE-35): the hold is the
 * ceiling, and a top-up is one more p75 through `reserveSpend` under the same
 * lock order and brakes, keyed `<attempt>#topup-<n>` so the attempt's ledger
 * entry settles it with the parent. Null — unmetered — when the run holds
 * nothing (holds off, unattributed and unbudgeted, `judge: false`), the hold
 * is gone, or `RUN_CUTOFF=off`.
 */
export async function meterForHold(input: {
  holdId: string | null;
  /** The hold's amount when the caller has it; else read from the hold. */
  amountUsd?: number;
  initiativeId: string | null;
  actorId: string | null;
  source: HoldSource;
  /** The attempt's ledger key, when known now; else the parent's binding at top-up time. */
  sourceId?: string | null;
  model: string | null;
  agentProjectId?: string | null;
  essential?: boolean;
  expiresInMs: number;
  onCut?: (cutoff: RunCutoff) => void;
}): Promise<RunMeter | null> {
  if (!runCutoffEnabled() || !input.holdId) return null;
  let amount = input.amountUsd;
  let essential = input.essential === true;
  if (amount === undefined) {
    try {
      const parent = await getHold(input.holdId);
      if (!parent || parent.status !== 'held') return null;
      amount = parent.amountUsd;
      essential = input.essential ?? parent.essential;
    } catch (err) {
      console.warn(`[spend-holds] run meter: hold ${input.holdId} unreadable: ${(err as Error).message}`);
      return null;
    }
  }
  if (!(amount > 0)) return null;
  const holdId = input.holdId;
  return new RunMeter({
    ceilingUsd: amount,
    holdIds: [holdId],
    model: input.model,
    onCut: (c) => {
      // DE-50: a cut is an alert as well as a record.
      emitFleetMetric('devbox-run-cutoff', {
        InitiativeId: input.initiativeId ?? 'unattributed', ActorId: input.actorId ?? 'none',
        source: input.source, ceilingUsd: c.ceilingUsd, meteredUsd: c.meteredUsd,
      });
      input.onCut?.(c);
    },
    topUp: async (n) => {
      // The parent's binding NOW: a bot run binds its hold once its row exists.
      const parent = await getHold(holdId).catch(() => null);
      const sid = parent?.sourceId ?? input.sourceId ?? null;
      const held = await reserveSpend({
        initiativeId: input.initiativeId,
        actorId: input.actorId,
        source: parent?.source ?? input.source,
        sourceId: sid ? topUpSourceId(sid, n) : topUpSourceId(`hold:${holdId}`, n),
        forecast: await forecastP75ForModel(input.model, input.agentProjectId ?? null),
        ...(essential ? { essential: true } : {}),
        basis: 'topup',
        expiresInMs: input.expiresInMs,
      });
      if (held.kind !== 'held') {
        console.log(`[spend-holds] top-up ${n} for hold ${holdId} refused: ${held.reason}`);
        return null;
      }
      return { holdId: held.holdId, amountUsd: held.amountUsd };
    },
  });
}

/** A fresh ledger key for an ad-hoc box task, minted before the hold so the settle matches. */
export function newTaskSourceId(boxId: string): string {
  return `${boxId}:${randomUUID()}`;
}
