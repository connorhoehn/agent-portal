// A budget row's threshold mark (learning loop, lane B): the library's status
// pill — "under 50%", "50%", "80%", "at cap" — with the percentage spent or
// held as its quieter clause. A dash when there is no budget to measure.

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
    <StatusPill
      size="sm"
      variant="text"
      tone={v.tone}
      label={v.label}
      {...(v.meta ? { meta: v.meta } : {})}
      data-testid={`threshold-${v.atCap ? 'cap' : v.near ? 'near' : 'under'}`}
    />
  );
}
