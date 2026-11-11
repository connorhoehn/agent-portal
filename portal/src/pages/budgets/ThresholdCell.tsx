// A budget row's threshold mark (learning loop, lane B): the library's status
// pill — "under 50%", "50%", "80%", "at cap" — with the exact share spent or
// held in its tooltip. A dash when there is no budget to measure.
//
// The exact share is not a visible "· 82% spent or held" clause: on Budgets'
// initiative table (three rails beside it at 1440) that clause made the row
// too wide and the library dropped the whole table into its card form.

import { StatusPill, T } from '@connorhoehn/ui-components/shared';
import { thresholdView } from './thresholdModel';
import type { ThresholdMark } from './types';

export function ThresholdCell({ mark, thresholds, what = 'budget' }: {
  mark: ThresholdMark | null | undefined;
  thresholds?: readonly number[];
  /** Names the budget in the tooltip ("allocation", "envelope", "monthly budget"). */
  what?: string;
}) {
  const v = thresholdView(mark, thresholds);
  if (!v.label) return <T tone="tertiary" title={`No ${what} to measure against`}>—</T>;
  return (
    <T title={v.meta ? `${v.meta} of the ${what}` : undefined}>
      <StatusPill
        size="sm"
        variant="text"
        tone={v.tone}
        label={v.label}
        data-testid={`threshold-${v.atCap ? 'cap' : v.near ? 'near' : 'under'}`}
      />
    </T>
  );
}
