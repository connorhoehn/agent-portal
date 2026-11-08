// The money decisions that sit beside the allocation and envelope brakes, pure
// (DE-54 user budgets, DE-36 hard caps, DE-55 maintenance reserve).
//
// lib/spend-holds.ts `reserveSpend` is the one chokepoint that reads budget
// state under the advisory locks and calls these; nothing here reads a
// database, the clock or a request. Each function is the whole rule for its
// limit so its unit test is the whole spec:
//
//   decideHardCap      a non-overridable ceiling (initiative, grant or user).
//                      Evaluated BEFORE the soft brakes; no confirm flag opens it.
//   decideUserBudget   the user's monthly allocation, a soft 409 like the
//                      initiative allocation (`confirmOverUserBudget`).
//   decideFloorFire    an essential bot's scheduled firing against its
//                      initiative's maintenance reserve, spilling into the
//                      discretionary remainder while the initiative allows it.
//   discretionary      the figures every human / job / box path is judged by.
//
// ── Config, with the defaults taken (docs/local-backlog-goal-2026-10-28.md) ──
//   BUDGET_FAIL_CLOSED          unreadable budget state answers 503. Default ON
//                               everywhere; `false` (or 0/off) proceeds unbraked.
//   BUDGET_HARD_CAP_FACTOR      a null hard_cap_usd means allocated x this. 1.25;
//                               `off` = only explicitly set caps apply.
//   UNBUDGETED_HARD_CAP_USD     the per-period cap on an initiative with no
//                               allocation row. $25 in production, none otherwise;
//                               `off` disables it everywhere.
//   MAINTENANCE_RESERVE         `off` = no reserve (the pre-DE-55 arithmetic).
//   MAINTENANCE_RESERVE_FACTOR  the auto reserve's headroom over the essential
//                               spend it is derived from. 1.1.

import type { AllocationForecast } from './bot-runner.js';
import type { ForecastConfidence } from './bot-estimate.js';

const money = (n: number): string => `$${n.toFixed(2)}`;
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

function envFlag(name: string): boolean | null {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return null;
}

function production(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/** Whether an unreadable budget read refuses (503 `budget-state`) instead of proceeding unbraked. On unless set false. */
export function budgetFailClosed(): boolean {
  return envFlag('BUDGET_FAIL_CLOSED') ?? true;
}

/** The multiplier a null hard cap takes over its allocation; null = derived caps off. */
export function hardCapFactor(): number | null {
  const raw = (process.env['BUDGET_HARD_CAP_FACTOR'] ?? '').trim().toLowerCase();
  if (raw === 'off') return null;
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 1 ? n : 1.25;
}

/** The cap on an initiative with no allocation row, per period; null = none. */
export function unbudgetedHardCapUsd(): number | null {
  const raw = (process.env['UNBUDGETED_HARD_CAP_USD'] ?? '').trim().toLowerCase();
  if (raw === 'off') return null;
  const n = Number(raw);
  if (raw && Number.isFinite(n) && n >= 0) return n;
  return production() ? 25 : null;
}

export function maintenanceReserveEnabled(): boolean {
  return (process.env['MAINTENANCE_RESERVE'] ?? '').trim().toLowerCase() !== 'off';
}

export function maintenanceReserveFactor(): number {
  const n = Number(process.env['MAINTENANCE_RESERVE_FACTOR']);
  return Number.isFinite(n) && n >= 1 ? n : 1.1;
}

export type CapSource = 'set' | 'factor' | 'unbudgeted';

/**
 * The cap a limit is held to. An explicit column wins; else the allocation x
 * the factor; else (no allocation at all) the unbudgeted cap, which only an
 * initiative has. Null = no cap.
 */
export function effectiveHardCap(
  allocatedUsd: number | null, hardCapUsd: number | null | undefined, opts: { unbudgeted?: boolean } = {},
): { capUsd: number; source: CapSource } | null {
  if (hardCapUsd != null) return { capUsd: hardCapUsd, source: 'set' };
  if (allocatedUsd != null) {
    const f = hardCapFactor();
    return f == null ? null : { capUsd: round4(allocatedUsd * f), source: 'factor' };
  }
  if (opts.unbudgeted) {
    const u = unbudgetedHardCapUsd();
    return u == null ? null : { capUsd: u, source: 'unbudgeted' };
  }
  return null;
}

// ─── Hard cap ─────────────────────────────────────────────────────────────────

export interface HardCapInput {
  capUsd: number;
  spentUsd: number;
  heldUsd: number;
  amountUsd: number;
}

export type HardCapDecision = { kind: 'proceed' } | { kind: 'refuse'; reason: string };

/**
 * Whether this spend stays at or under a hard cap. At the cap is allowed; one
 * cent over is not. Takes no `confirmed` argument on purpose: a hard cap is the
 * line a confirmation cannot cross.
 */
export function decideHardCap(i: HardCapInput, what = 'this budget'): HardCapDecision {
  const after = round4(i.spentUsd + i.heldUsd + i.amountUsd);
  if (after <= i.capUsd + 1e-9) return { kind: 'proceed' };
  const held = i.heldUsd > 0 ? ` and ${money(i.heldUsd)} held by runs in flight` : '';
  return {
    kind: 'refuse',
    reason: `${what} has a ${money(i.capUsd)} hard cap (${money(i.spentUsd)} spent${held}); ${money(i.amountUsd)} more would cross it, and a hard cap cannot be confirmed past. No work was started.`,
  };
}

// ─── User budget ──────────────────────────────────────────────────────────────

export interface UserBudgetState {
  allocatedUsd: number;
  /** This period's known spend where the user is the actor (cron excluded). */
  spentUsd: number;
  /** The user's open holds. */
  heldUsd: number;
  /** This period's entries of theirs with no recorded cost (DE-33). */
  unknownCount?: number;
}

export type UserBudgetDecision =
  | { kind: 'proceed' }
  | { kind: 'confirm'; reason: string; confidence: ForecastConfidence };

/**
 * Whether a spend fits the user's own monthly budget. The same soft shape as
 * the allocation brake: p75 against the remainder, a confirmation (never a
 * refusal) when it does not fit, because the hard cap is the refusal. An
 * unknown-cost entry trips it on its own only where the caller can confirm
 * (`unknownCostTrips`, dispatch-work).
 */
export function decideUserBudget(
  state: UserBudgetState,
  forecast: number | AllocationForecast,
  confirmed: boolean,
  opts: { unknownCostTrips?: boolean } = {},
): UserBudgetDecision {
  if (confirmed) return { kind: 'proceed' };
  const f: AllocationForecast = typeof forecast === 'number' ? { costUsdP75: forecast } : forecast;
  const confidence = f.confidence ?? 'scaled';
  const named = `your ${money(state.allocatedUsd)} monthly budget`;
  const unknown = state.unknownCount ?? 0;
  if (unknown > 0 && opts.unknownCostTrips === true) {
    return {
      kind: 'confirm',
      reason: `${unknown} of your runs this month ${unknown === 1 ? 'has' : 'have'} no recorded cost, so ${named} may be further spent than the ${money(state.spentUsd)} recorded — pass confirmOverUserBudget to proceed`,
      confidence,
    };
  }
  const remaining = round4(state.allocatedUsd - state.spentUsd - state.heldUsd);
  if (f.costUsdP75 <= remaining) return { kind: 'proceed' };
  const held = state.heldUsd > 0 ? ` and ${money(state.heldUsd)} held by your runs in flight` : '';
  if (remaining <= 0) {
    return {
      kind: 'confirm',
      reason: `${named} is spent out (${money(state.spentUsd)} spent${held}) — ask a budget holder to raise it or pass confirmOverUserBudget`,
      confidence,
    };
  }
  return {
    kind: 'confirm',
    reason: `estimated ${money(f.costUsdP75)} exceeds the ${money(remaining)} left of ${named} — ask a budget holder to raise it, pick a cheaper model, or pass confirmOverUserBudget`,
    confidence,
  };
}

// ─── Maintenance reserve ──────────────────────────────────────────────────────

export interface DiscretionaryInput {
  allocatedUsd: number;
  /** The effective reserve (0 when the reserve is off). */
  reserveUsd: number;
  /** Essential bots' scheduled spend this period. */
  floorSpentUsd: number;
  /** Open holds of essential firings. */
  floorHeldUsd?: number;
  /** Everything else spent this period. */
  discretionarySpentUsd: number;
  /** Everything else held. */
  discretionaryHeldUsd?: number;
}

export interface DiscretionaryFigures {
  /** What the floor takes off the top: the reserve, or more when the floor already spent past it. */
  floorUsd: number;
  discretionaryRemainingUsd: number;
}

/**
 * allocated - max(reserve, floor spent + floor held) - discretionary spent - discretionary held.
 * The floor's in-flight money counts toward the floor, so an essential firing
 * running past the reserve shrinks the discretionary remainder by exactly what
 * it spills.
 */
export function discretionary(i: DiscretionaryInput): DiscretionaryFigures {
  const floorUsd = round4(Math.max(i.reserveUsd, i.floorSpentUsd + (i.floorHeldUsd ?? 0)));
  return {
    floorUsd,
    discretionaryRemainingUsd: round4(i.allocatedUsd - floorUsd - i.discretionarySpentUsd - (i.discretionaryHeldUsd ?? 0)),
  };
}

/** The auto reserve: last closed period's essential spend x factor, else the trailing 30 days x factor. */
export function autoReserveUsd(lastPeriodFloorUsd: number, trailing30dFloorUsd: number, factor = maintenanceReserveFactor()): number {
  return round4((lastPeriodFloorUsd > 0 ? lastPeriodFloorUsd : trailing30dFloorUsd) * factor);
}

export interface FloorFireInput extends DiscretionaryInput {
  allowSpill: boolean;
  amountUsd: number;
}

export type FloorFireDecision =
  | { kind: 'proceed'; spill: boolean }
  | { kind: 'skip'; reason: string };

/**
 * Whether an essential bot's scheduled firing is funded. First from the
 * reserve; past it, from the discretionary remainder while the initiative
 * allows spill (the default, so maintenance never stops while any money is
 * left). A refusal is a recorded skip, never a pause: the next firing
 * re-judges once the period rolls or money frees.
 */
export function decideFloorFire(i: FloorFireInput): FloorFireDecision {
  const floorAfter = i.floorSpentUsd + (i.floorHeldUsd ?? 0) + i.amountUsd;
  if (floorAfter <= i.reserveUsd + 1e-9) return { kind: 'proceed', spill: false };
  // What this firing would take past the reserve.
  const spill = round4(floorAfter - Math.max(i.reserveUsd, i.floorSpentUsd + (i.floorHeldUsd ?? 0)));
  const { discretionaryRemainingUsd } = discretionary(i);
  const reserveLine = `the ${money(i.reserveUsd)} maintenance reserve (${money(i.floorSpentUsd)} spent by essential bots${(i.floorHeldUsd ?? 0) > 0 ? `, ${money(i.floorHeldUsd ?? 0)} in flight` : ''})`;
  if (!i.allowSpill) {
    return { kind: 'skip', reason: `projected ${money(i.amountUsd)} would exceed ${reserveLine}, and this initiative does not let maintenance spill into discretionary money` };
  }
  if (spill <= discretionaryRemainingUsd + 1e-9) return { kind: 'proceed', spill: true };
  return {
    kind: 'skip',
    reason: `projected ${money(i.amountUsd)} would exceed ${reserveLine} and the ${money(Math.max(0, discretionaryRemainingUsd))} of discretionary money left`,
  };
}
