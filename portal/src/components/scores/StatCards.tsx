import { StatStrip } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';

interface Props {
  /** Pre-formatted by ScoresPage.tsx's `showingLabel` — "56 people" when
   *  nothing is hidden, "Showing the first 14 of 56 people" once a filter or
   *  the page cap narrows what's shown, so this card never claims an
   *  org-wide count it isn't actually looking at. */
  peopleScoredLabel: string;
  avgComposite: number;
  topScore: number;
  departmentCount: number;
  mostRecentScoredAt: string | null;
}

// A single-row StatStrip, not a 4-tile grid plus its own freshness caption —
// that used to be two stacked blocks above the table (see DEFECTS.md #3).
// Freshness folds into the strip as one more item instead of a line of its
// own.
export function StatCards({ peopleScoredLabel, avgComposite, topScore, departmentCount, mostRecentScoredAt }: Props) {
  return (
    <StatStrip
      aria-label="Scoring summary"
      items={[
        { label: 'People Scored', value: peopleScoredLabel },
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
