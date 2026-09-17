import { StatStrip } from '@connorhoehnslalom/ui-components/shared';
import { relativeTime } from '../../lib/relativeTime';
import { useCapabilities } from '../../lib/capabilities';

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
  const { can, ready } = useCapabilities();
  /**
   * "run the scoring agent" is only an instruction if you can run it.
   *
   * Scores is visible to org-leader AND hr-admin, but `ManageIngest` — which
   * `POST /api/agents/:id/invoke` requires for the scoring agent — is held by
   * hr-admin alone. So half this surface's audience was being handed a chore
   * it cannot do, with no hint of who can. `TrendLine.tsx` already names this
   * exact trap in its own props doc ("the scoring agent is ManageIngest-gated,
   * so for most readers it is a chore they cannot even do") and handles it;
   * this sibling never got the same treatment.
   */
  const staleHint = !ready
    ? undefined
    : can('ManageIngest')
      ? 'run the scoring agent'
      : 'no scoring run yet — an HR admin can start one';
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
          hint: mostRecentScoredAt === null ? staleHint : undefined,
        },
      ]}
    />
  );
}
