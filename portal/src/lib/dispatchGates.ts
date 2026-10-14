// The governed dispatch's contract, without React: the estimate types the
// /api/bots/estimate route answers, the stored-estimate rule, and the words for
// the three confirmable 409s (run cap, allocation, sprint envelope). The
// estimate drawer and the composer's Prepare job deck both read these, so the
// same refusal reads the same way in either place. Moved out of
// EstimateDrawer.tsx (which re-exports them) so node tests can import them.

import { usd as money } from './format.ts';

// ─── Types (the /api/bots/estimate contract) ─────────────────────────────────

/** How much a forecast is entitled to claim. 'scaled' is per-point history ×
    points; 'run-history' is real runs but not sized to this item; 'prior' is a
    static per-tier bracket. Optional because estimates echoed onto older runs
    predate the field. */
export type ForecastConfidence = 'scaled' | 'run-history' | 'prior';

export interface WorkEstimate {
  basis: 'repo' | 'model' | 'prior';
  sampleCount: number;
  costUsdP25: number;
  costUsdP75: number;
  minutesP25: number;
  minutesP75: number;
  points: number | null;
  /** true → the range is per-point history × points; false → run-level history. */
  scaled: boolean;
  confidence?: ForecastConfidence;
}

/** The provenance fields the save route echoes back, and all the row reads. */
export interface EstimateProvenance {
  estimatedBy?: string | null;
  estimatedByName?: string | null;
  estimatedAt?: string | null;
  estimateModel?: string | null;
  estimateForecast?: Record<string, unknown> | null;
  estimatedCostUsd?: number | null;
  // The review route echoes the same item shape, so these ride along and a
  // sign-off updates the row without a refetch.
  estimateReviewedBy?: string | null;
  estimateReviewedByName?: string | null;
  estimateReviewedAt?: string | null;
}

export interface EstimateItem {
  id: string;
  title: string;
  type: string;
  storyPoints: number | null;
  /**
   * The estimate somebody already stood behind, if any
   * (schema/work_item_estimate_schema.sql). Null on every item that predates
   * that migration and on any item nobody has dispatched — which is the
   * ordinary case, not a warning.
   *
   * `estimateModel` is what makes the stored forecast usable: it is only valid
   * for the model it was computed against. Haiku and Opus were measured 20x
   * apart on identical points, so a stored Haiku figure shown while Opus is
   * selected would be worse than showing none.
   */
  estimatedBy?: string | null;
  estimatedByName?: string | null;
  estimatedAt?: string | null;
  estimateModel?: string | null;
  estimateForecast?: Record<string, unknown> | null;
  estimateReviewedBy?: string | null;
  estimateReviewedByName?: string | null;
  estimateReviewedAt?: string | null;
}

/**
 * Is the stored estimate usable for the model currently selected?
 *
 * The model check is the load-bearing half. Without it this would happily show
 * a Haiku forecast above an Opus run and call it "estimated by Nora" — a wrong
 * number with somebody's name lending it authority, which is worse than the
 * unattributed recompute this replaces.
 */
export function storedEstimateFor(item: EstimateItem | null, model: string): WorkEstimate | null {
  if (!item?.estimateForecast || !item.estimatedAt) return null;
  if (item.estimateModel !== model) return null;
  const f = item.estimateForecast as Partial<WorkEstimate>;
  return typeof f.costUsdP25 === 'number' && typeof f.costUsdP75 === 'number'
    ? (f as WorkEstimate)
    : null;
}

export interface OverAllocation {
  reason: string;
  confidence?: ForecastConfidence;
  estimate?: WorkEstimate;
  allocatedUsd: number;
  spentUsd: number;
  remainingUsd: number;
}

/** What the allocation brake stopped, in the operator's terms: the money
    first, because that is the decision — then how much the forecast behind the
    refusal is actually worth. The brake now fires on weak forecasts too (it
    could not fire at all before, on any initiative without sized run history),
    so a refusal built on a wide prior must not be dressed as a measurement.
    Say "wide prior" and the next refusal still gets read. */
export function overAllocationBody(over: OverAllocation): string {
  const ledger = `${money(over.spentUsd)} of ${money(over.allocatedUsd)} is already spent this month, leaving ${money(over.remainingUsd)}.`;
  const est = over.estimate;
  if (!est) {
    // No forecast on the wire: use the server's claim, minus the remedy half,
    // which names an API flag rather than anything reachable from here.
    return `${ledger} ${over.reason.split(' — ')[0]}. Dispatching anyway spends over the allocation.`;
  }
  const range = `${money(est.costUsdP25)}–${money(est.costUsdP75)}`;
  const forecast =
    over.confidence === 'prior'
      ? `This run is forecast at ${range}, but nothing has run on this model here yet — that range is a deliberately wide prior, not a measurement.`
      : over.confidence === 'run-history'
        ? `This run is forecast at ${range} from ${est.sampleCount} run${est.sampleCount === 1 ? '' : 's'} of run-level history — a bracket, not a figure scaled to this item's size.`
        : `This run is forecast at ${range}${est.points != null ? ` for ${est.points} points` : ''}, from ${est.sampleCount} comparable pointed runs.`;
  return `${ledger} ${forecast} Dispatching anyway spends over the allocation.`;
}

export interface OverRunBudget {
  reason: string;
  budgetPerRunUsd: number;
  costUsdP25?: number;
  costUsdP75?: number;
}

/** The per-run cap refused this dispatch. Deliberately says whose limit it is:
    this one is the operator's own, set two fields up in this very drawer, and
    confusing it with the initiative's allocation would make "dispatch anyway"
    look like overspending someone else's money. */
export function overRunBudgetBody(over: OverRunBudget): string {
  const forecast = over.costUsdP25 != null && over.costUsdP75 != null
    ? `This run is forecast at ${money(over.costUsdP25)}–${money(over.costUsdP75)}`
    : over.reason.split(' — ')[0];
  return `${forecast}, over the ${money(over.budgetPerRunUsd)} cap you set for it. `
    + 'The cap is yours alone — nothing about the initiative\'s allocation or your sprint '
    + 'envelope is being waived here.';
}

export interface OverEnvelope {
  reason: string;
  confidence?: ForecastConfidence;
  estimate?: WorkEstimate;
  allocatedUsd: number;
  attributedSpentUsd: number;
  remainingUsd: number;
  attributionAvailable: boolean;
  sprintName?: string | null;
}

/** The sprint envelope refused this dispatch — and the honest part is what the
    burn is NOT. Only runs recorded as dispatched by this person count, and
    nothing counted before attribution was turned on, so the figure is small by
    construction. Saying "$2 of your $30" without that caveat would read as
    "you have barely spent", which is not something this data supports. */
export function overEnvelopeBody(over: OverEnvelope): string {
  const envelope = over.sprintName
    ? `your ${money(over.allocatedUsd)} envelope on ${over.sprintName}`
    : `your ${money(over.allocatedUsd)} sprint envelope`;
  if (!over.attributionAvailable) {
    return `This run's forecast does not fit ${envelope} at all. No run here is recorded as `
      + 'dispatched by anyone yet, so nothing has been counted against the envelope — the '
      + 'only thing being compared is the forecast against the envelope\'s full size.';
  }
  const ledger = `${money(over.attributedSpentUsd)} of ${envelope} is recorded as spent by you, `
    + `leaving ${money(over.remainingUsd)}.`;
  const caveat = 'That counts only runs recorded as dispatched by you — runs from before '
    + 'attribution was turned on, and everyone else\'s, count against nobody.';
  const est = over.estimate;
  if (!est) return `${ledger} ${caveat}`;
  const range = `${money(est.costUsdP25)}–${money(est.costUsdP75)}`;
  const forecast = over.confidence === 'prior'
    ? `This run is forecast at ${range}, from a deliberately wide prior — nothing has run on this model here yet.`
    : `This run is forecast at ${range}.`;
  return `${ledger} ${forecast} ${caveat}`;
}
