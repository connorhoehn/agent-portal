import { StatStrip } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';

interface Props {
  peopleScored: number;
  avgComposite: number;
  topScore: number;
  departmentCount: number;
  mostRecentScoredAt: string | null;
}

// A single-row StatStrip, not a 4-tile grid plus its own freshness caption —
// that used to be two stacked blocks above the table (see DEFECTS.md #3).
// Freshness folds into the strip as one more item instead of a line of its
// own.
export function StatCards({ peopleScored, avgComposite, topScore, departmentCount, mostRecentScoredAt }: Props) {
  return (
    <StatStrip
      aria-label="Scoring summary"
      items={[
        { label: 'People Scored', value: String(peopleScored) },
        { label: 'Avg Composite', value: String(avgComposite) },
        { label: 'Top Score', value: String(topScore) },
        { label: 'Departments', value: String(departmentCount) },
        {
          label: 'Updated',
          value: relativeTime(mostRecentScoredAt),
          hint: mostRecentScoredAt === null ? 'run the scoring agent' : undefined,
        },
      ]}
    />
  );
}
