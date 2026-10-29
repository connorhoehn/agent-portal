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
// - Unattributed spend (no initiative) takes no hold and is judged by nothing,
//   as before; `SPEND_HOLDS_UNATTRIBUTED=refuse` refuses it instead.
// - An unreadable hold store (table not yet applied) proceeds unheld and logs,
//   as before DE-34; `SPEND_HOLDS_FAIL_CLOSED=1` refuses with 503.
// - `SPEND_HOLDS=off` keeps the brakes but writes no holds.
// - A cron firing takes a hold (so its in-flight money is visible to everyone
//   else's brakes) but is judged only when the bot opted in
//   (`bots.enforce_allocation`), the existing default: the maintenance floor
//   is not braked until the reserve exists (goal row "maintenance reserve").
// - The lock order is initiative → grant; a per-user lock slots in third.

import { randomUUID } from 'node:crypto';
import { clock } from '../mock/core/index.js';
import { getBudget, unknownCostCountInPeriod } from '../providers/budgets.js';
import { runCostSamples } from '../providers/bots.js';
import {
  withSpendLock, openHeldUsd, openHeldUsdForGrant, spendHoldsEnabled, spendHoldsFailClosed,
  missingHoldsTable, type HoldSource, type HoldBasis, type SpendLockTx,
} from '../providers/spend-holds.js';
import {
  decideAllocation, decideEnvelope, loadEnvelope,
  type AllocationForecast, type ResolvedEnvelope,
} from './bot-runner.js';
import type { ForecastConfidence } from './bot-estimate.js';
import { selectDispatchForecast, type ForecastSamples } from './marketplace-estimate.js';

export interface ReserveSpendInput {
  /** The initiative charged. Null = unattributed: no hold, no brake (unless refused by config). */
  initiativeId: string | null;
  /** Who is spending: the session subject or principal.requestedBy. Null for a cron firing. */
  actorId: string | null;
  source: HoldSource;
  /** The ledger key of the attempt, when it is known before the side effect
   *  (box tasks, jobs). Bot runs and governed runs bind it after their row exists. */
  sourceId?: string | null;
  forecast: AllocationForecast;
  /** The route's confirm flags. Absent = nothing confirmed. */
  confirmed?: { allocation?: boolean; envelope?: boolean };
  /** false = hold for visibility only, never refuse (an un-opted-in cron firing). Default true. */
  judge?: boolean;
  /** true = an unknown-cost run in the window trips a brake on its own (DE-33).
   *  Default FALSE: only POST /api/bots/dispatch-work, whose deck renders the
   *  gate, opts in. Box tasks, bot firings, the job dispatcher and governed
   *  runs cannot confirm it, so for them only a real overrun refuses. */
  unknownCostTrips?: boolean;
  /** How long the hold may stay open: the path's run ceiling plus grace. */
  expiresInMs: number;
}

export interface AllocationGateBody {
  orgProjectId: string;
  allocatedUsd: number;
  spentUsd: number;
  heldUsd: number;
  remainingUsd: number;
  unknownCostCount: number;
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
}

export type ReserveSpendResult =
  /** The money is held (or holds are off / the spend is unattributed: holdId null). */
  | { kind: 'held'; holdId: string | null; initiativeId: string | null; grantId: string | null; amountUsd: number }
  /** A soft brake: the route answers 409 with the gate, flag and figures. */
  | {
    kind: 'confirm'; gate: 'allocation' | 'envelope'; confirmFlag: 'confirmOverAllocation' | 'confirmOverEnvelope';
    reason: string; confidence: ForecastConfidence; allocation?: AllocationGateBody; envelope?: EnvelopeGateBody;
  }
  /** Not allowed to spend here at all (unattributed, refused by config): 403. */
  | { kind: 'refused'; reason: string }
  /** The hold store could not be read and the deployment fails closed: 503. */
  | { kind: 'unavailable'; reason: string };

/** Five minutes of grace past a path's run ceiling before a hold expires. */
export const HOLD_GRACE_MS = 5 * 60_000;

function unattributedRule(): 'allow' | 'refuse' {
  return (process.env['SPEND_HOLDS_UNATTRIBUTED'] ?? '').trim().toLowerCase() === 'refuse' ? 'refuse' : 'allow';
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

function allocationBody(orgProjectId: string, allocatedUsd: number, spentUsd: number, heldUsd: number, unknownCostCount: number): AllocationGateBody {
  return { orgProjectId, allocatedUsd, spentUsd, heldUsd, remainingUsd: allocatedUsd - spentUsd - heldUsd, unknownCostCount };
}

function envelopeBody(orgProjectId: string, e: ResolvedEnvelope, heldUsd: number): EnvelopeGateBody {
  return {
    orgProjectId, grantId: e.grantId, sprintId: e.sprintId, sprintName: e.sprintName ?? null,
    allocatedUsd: e.allocatedUsd, attributedSpentUsd: e.attributedSpentUsd, heldUsd,
    remainingUsd: e.allocatedUsd - e.attributedSpentUsd - heldUsd,
    attributionAvailable: e.attributionAvailable, unknownCostCount: e.attributedUnknownCount ?? 0,
  };
}

/**
 * Judge and hold. See the module header for where it is called and why the
 * reads happen after the lock: each sees every hold committed by the dispatch
 * it waited on, which is the whole point.
 */
export async function reserveSpend(input: ReserveSpendInput): Promise<ReserveSpendResult> {
  const judge = input.judge !== false;
  const unknownOpts = { unknownCostTrips: input.unknownCostTrips === true };
  const confirmed = { allocation: input.confirmed?.allocation === true, envelope: input.confirmed?.envelope === true };
  const amountUsd = Math.max(0, input.forecast.costUsdP75);

  if (!input.initiativeId) {
    if (unattributedRule() === 'refuse') {
      return { kind: 'refused', reason: 'this spend is charged to no initiative, and unattributed spend is refused here' };
    }
    return { kind: 'held', holdId: null, initiativeId: null, grantId: null, amountUsd };
  }
  const pid = input.initiativeId;

  const body = async (tx: SpendLockTx | null): Promise<ReserveSpendResult> => {
    // ── The initiative's allocation, as a brake ─────────────────────────────
    // Still skipped for an initiative with NO allocation row: unbudgeted is not
    // zero-budget (it is the Budgets page's blind spot), and freezing an
    // unfunded initiative here is DE-36's call, not this one's.
    // A hold that may not refuse (judge: false) reads no allocation at all:
    // it only has to be written, so the firing it covers costs no budget read.
    const budgetRow = judge ? await getBudget(pid) : null;
    const heldUsd = tx && judge ? await openHeldUsd(pid) : 0;
    let allocation: AllocationGateBody | null = null;
    let basis: HoldBasis = 'p75';
    if (budgetRow?.allocatedUsd != null) {
      const unknownCostCount = await unknownCostCountInPeriod(pid);
      allocation = allocationBody(pid, budgetRow.allocatedUsd, budgetRow.spentThisPeriodUsd, heldUsd, unknownCostCount);
      const state = { allocatedUsd: budgetRow.allocatedUsd, spentUsd: budgetRow.spentThisPeriodUsd, heldUsd, unknownCostCount };
      if (judge) {
        const unconfirmed = decideAllocation(state, input.forecast, false, unknownOpts);
        if (unconfirmed.kind === 'confirm') {
          if (!confirmed.allocation) {
            return { kind: 'confirm', gate: 'allocation', confirmFlag: 'confirmOverAllocation', reason: unconfirmed.reason, confidence: unconfirmed.confidence, allocation };
          }
          basis = 'confirmed_over';
        }
      }
    }

    // ── The caller's own sprint envelope ────────────────────────────────────
    // No grant → no brake: a release manager dispatching without an envelope
    // is the allocation brake's business. The grant lock is taken AFTER the
    // initiative lock, always, so two dispatches cannot deadlock.
    let envelope: ResolvedEnvelope | null = null;
    let grantHeld = 0;
    if (input.actorId) {
      envelope = await loadEnvelope(pid, input.actorId);
      if (envelope) {
        if (tx) await tx.lock(`grant:${envelope.grantId}`);
        grantHeld = tx && judge ? await openHeldUsdForGrant(envelope.grantId) : 0;
        if (judge) {
          const unconfirmed = decideEnvelope({ ...envelope, heldUsd: grantHeld }, input.forecast, false, unknownOpts);
          if (unconfirmed.kind === 'confirm') {
            if (!confirmed.envelope) {
              return {
                kind: 'confirm', gate: 'envelope', confirmFlag: 'confirmOverEnvelope', reason: unconfirmed.reason,
                confidence: unconfirmed.confidence, envelope: envelopeBody(pid, envelope, grantHeld),
              };
            }
            basis = 'confirmed_over';
          }
        }
      }
    }

    if (!tx) return { kind: 'held', holdId: null, initiativeId: pid, grantId: envelope?.grantId ?? null, amountUsd };
    const hold = await tx.insertHold({
      initiativeId: pid, grantId: envelope?.grantId ?? null, actorId: input.actorId, source: input.source,
      sourceId: input.sourceId ?? null, amountUsd, basis,
      expiresAt: new Date(clock.now().getTime() + input.expiresInMs).toISOString(),
    });
    return { kind: 'held', holdId: hold.id, initiativeId: pid, grantId: envelope?.grantId ?? null, amountUsd };
  };

  if (!spendHoldsEnabled()) return body(null);
  try {
    return await withSpendLock([`spend:${pid}`], body);
  } catch (err) {
    if (missingHoldsTable(err)) {
      if (spendHoldsFailClosed()) {
        return { kind: 'unavailable', reason: 'Spend holds could not be recorded, so nothing was started. Apply schema/spend_holds_schema.sql or set SPEND_HOLDS=off.' };
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

/** A fresh ledger key for an ad-hoc box task, minted before the hold so the settle matches. */
export function newTaskSourceId(boxId: string): string {
  return `${boxId}:${randomUUID()}`;
}
