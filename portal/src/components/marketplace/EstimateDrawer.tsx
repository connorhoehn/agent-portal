// Work estimates on runs — what is left of the retired estimate drawer.
//
// The drawer (estimate → authorize, with its four dispatch refusals) was the
// work item page's authorize step behind the Prepare job form. Since
// ui-components 2.444.0 that page asks in the docked composer instead
// (pages/project-detail/usePrepareJobDeck.ts): the same POST
// /api/bots/dispatch-work body, the same per-gate confirm flags, the same
// refusal words — now in lib/dispatchGates.ts, re-exported here for every
// existing importer. What stays here is the run-side reading of an estimate.

import { Inline } from '@connorhoehnslalom/ui-components/shared';
import { usd as money } from '../../lib/format';
import type { BotRun } from '../../pages/bots/BotsPage';
import type { WorkEstimate } from '../../lib/dispatchGates';

export {
  overAllocationBody,
  overEnvelopeBody,
  overRunBudgetBody,
  storedEstimateFor,
} from '../../lib/dispatchGates';
export type {
  EstimateItem,
  EstimateProvenance,
  ForecastConfidence,
  OverAllocation,
  OverEnvelope,
  OverRunBudget,
  WorkEstimate,
} from '../../lib/dispatchGates';

/** The estimate echoed at authorize time on a run's outcome, when present.
    BotRun.outcome doesn't declare it (the type lives in BotsPage), so read it
    through a narrow cast here — one place that knows the wire shape. */
export function runEstimate(run: Pick<BotRun, 'outcome'>): WorkEstimate | undefined {
  return (run.outcome as { estimate?: WorkEstimate } | undefined)?.estimate;
}

/** An actual cost against its authorize-time estimate: the actual tints danger
    when it ran over p75 and success when it came in under p25, with the range
    appended muted. Falls back to a plain actual (or —) without an estimate. */
export function CostVsEstimate({ costUsd, estimate }: { costUsd: number | null; estimate: WorkEstimate | undefined }) {
  if (costUsd == null) return <Inline as="span" gap="none" className="text-text-tertiary whitespace-nowrap">—</Inline>;
  const actual = `$${costUsd.toFixed(4)}`;
  if (!estimate) return <Inline as="span" gap="none" className="text-text-tertiary whitespace-nowrap">{actual}</Inline>;
  const over = costUsd > estimate.costUsdP75;
  const under = costUsd < estimate.costUsdP25;
  const range = `${money(estimate.costUsdP25)}–${money(estimate.costUsdP75)}`;
  const title = over
    ? `Actual ${actual} ran over the authorize-time estimate (${range}, p25–p75)`
    : under
      ? `Actual ${actual} came in under the authorize-time estimate (${range}, p25–p75)`
      : `Actual ${actual} landed inside the authorize-time estimate (${range}, p25–p75)`;
  return (
    // `gap="none"` throughout: the leading space in " est " is deliberate
    // spacing between the actual and its range, and a flex gap here would
    // double it.
    <Inline as="span" gap="none" className="whitespace-nowrap" title={title}>
      <Inline as="span" gap="none" className={over ? 'text-danger' : under ? 'text-success' : 'text-text-tertiary'}>{actual}</Inline>
      <Inline as="span" gap="none" className="text-text-tertiary opacity-70"> est {range}</Inline>
    </Inline>
  );
}

