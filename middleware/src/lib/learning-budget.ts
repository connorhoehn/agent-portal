// The learning line (docs/learning-loop-design.md "Budgets"): what server-side
// distillation may spend, per calendar month, for the whole organisation.
//
// The distiller (lane C) calls three functions and nothing else:
//
//   const r = await reserveLearningSpend({ runRef, estimate });
//   if (!r.ok) → record `skipped: learning-budget` (or the reason) and stop
//   ... call the model ...
//   await settleLearningSpend({ runRef, costUsd, model, inputTokens, outputTokens });
//   // or, if the call never happened: await releaseLearningSpend(r.holdId);
//
// It is built ON `reserveSpend` (lib/spend-holds.ts), not beside it: the same
// kill switch (a paused fleet distils nothing), the same hold table, the same
// settle-by-ledger-entry. reserveSpend judges a `learning` source against the
// monthly cap (providers/budget-lines.ts: LEARNING_BUDGET_USD, default $5,
// until an org leader sets one on the Budgets page) and nothing else.
//
// Local work (job kinds `local:*`) does NOT call this: it bills nothing and
// draws nothing from the line.

import { reserveSpend, HOLD_GRACE_MS, type ReserveSpendResult } from './spend-holds.js';
import { releaseHold } from '../providers/spend-holds.js';
import { openLearningHold } from '../providers/budget-lines.js';
import { recordSpend } from '../providers/spend-ledger.js';

/** How long a distillation's hold may stay open: a model call, generously. */
export const LEARNING_HOLD_MS = 10 * 60_000;

/** Why a reservation was refused. `learning-budget` is the line's own cap; the rest are reserveSpend's kinds. */
export type LearningRefusal = 'learning-budget' | 'paused' | 'unavailable' | 'refused' | 'limited';

export type LearningReservation =
  | { ok: true; holdId: string | null }
  | { ok: false; reason: LearningRefusal; message: string };

/** The ledger and hold key of one run's distillation. */
export function learningSourceId(runRef: string): string {
  return `learning:${runRef}`;
}

function refusalOf(r: Exclude<ReserveSpendResult, { kind: 'held' }>): LearningRefusal {
  if (r.kind === 'capped') return 'learning-budget';
  if (r.kind === 'confirm') return 'learning-budget';
  return r.kind;
}

/**
 * Hold `estimate` dollars of this month's learning line for the distillation
 * of `runRef`. Idempotent on runRef: a reservation already in flight for the
 * same run is returned, never doubled.
 */
export async function reserveLearningSpend(input: { runRef: string; estimate: number }): Promise<LearningReservation> {
  const runRef = String(input.runRef ?? '').trim();
  if (!runRef) return { ok: false, reason: 'refused', message: 'a learning reservation needs the run it distils' };
  const estimate = Number.isFinite(input.estimate) && input.estimate > 0 ? input.estimate : 0;
  const sourceId = learningSourceId(runRef);
  try {
    const open = await openLearningHold(sourceId);
    if (open) return { ok: true, holdId: open.id };
  } catch { /* reserveSpend reads the same store and answers for it */ }
  const r = await reserveSpend({
    initiativeId: null,
    actorId: null,
    source: 'learning',
    sourceId,
    forecast: { costUsdP75: estimate },
    expiresInMs: LEARNING_HOLD_MS + HOLD_GRACE_MS,
  });
  if (r.kind === 'held') return { ok: true, holdId: r.holdId };
  return { ok: false, reason: refusalOf(r), message: r.reason };
}

/**
 * Book what the distillation cost: one `learning` ledger entry, which settles
 * its hold in the same write. A null cost is recorded as unknown (the hold then
 * stays until it expires, as on every other line).
 */
export async function settleLearningSpend(input: {
  runRef: string; costUsd: number | null; model?: string | null; inputTokens?: number | null; outputTokens?: number | null;
}): Promise<void> {
  await recordSpend({
    source: 'learning',
    sourceId: learningSourceId(input.runRef),
    initiativeId: null,
    boxId: null,
    actorId: null,
    trigger: 'distill',
    model: input.model ?? null,
    costUsd: input.costUsd,
    costBasis: input.costUsd == null ? 'unknown' : 'estimated',
    estimatedCostUsd: input.costUsd,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    provider: 'bedrock',
  });
}

/** Give the money back when the model was never called. */
export async function releaseLearningSpend(holdId: string | null | undefined): Promise<void> {
  await releaseHold(holdId);
}
