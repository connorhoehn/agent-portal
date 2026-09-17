import {
  EmptyState, EntityCell, ErrorState, Inline, MetaLine, Sparkline, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';

export interface HistorySample {
  ts: string;
  score: number;
}

export interface HistoryResponse {
  personId: string;
  samples: HistorySample[];
  deltaVs7d: number | null;
}

export interface TrendLineProps {
  history: HistoryResponse | null | undefined;
  /**
   * The server's error line when `GET /api/scores/:id/history` answered 200
   * with `{ samples: [], degraded, error }`. "No trend data — run the scoring
   * agent" is a chore handed to someone whose query merely failed, and the
   * scoring agent is `ManageIngest`-gated, so for most readers it is a chore
   * they cannot even do.
   */
  degraded?: string | null;
}

export function TrendLine({ history, degraded }: TrendLineProps) {
  const { can, ready } = useCapabilities();
  const canRunScoring = ready && can('ManageIngest');
  if (degraded) {
    return (
      <ErrorState
        title="Could not load the score trend"
        description={`${degraded.replace(/\.\s*$/, '')}. Score history lives in Aurora, so this is unknown rather than empty — the trend may be perfectly healthy.`}
      />
    );
  }

  if (history === undefined) {
    return <MetaLine size="xs" className="py-2" items={['Loading trend...']} />;
  }

  if (history === null || history.samples.length === 0) {
    // The props doc above diagnoses this exact trap — "the scoring agent is
    // ManageIngest-gated, so for most readers it is a chore they cannot even
    // do" — but only the `degraded` branch was ever fixed for it. This is the
    // genuinely-empty branch, and it was still handing out the chore. Scores is
    // visible to org-leader and hr-admin; ManageIngest is hr-admin's alone.
    return (
      <EmptyState
        title="No trend data"
        description={canRunScoring
          ? 'Run the scoring agent to start tracking scores over time.'
          : 'Nothing has been scored yet, so there is no history to plot. An HR admin can run the scoring agent to start it.'}
      />
    );
  }

  const { samples, deltaVs7d } = history;
  const series = samples.map((s) => s.score);

  const deltaClass =
    deltaVs7d === null
      ? 'text-text-tertiary'
      : deltaVs7d >= 0
      ? 'text-success'
      : 'text-danger';

  const deltaLabel =
    deltaVs7d === null
      ? '—'
      : `${deltaVs7d >= 0 ? '↑' : '↓'} ${Math.abs(Math.round(deltaVs7d))}`;

  return (
    <Inline align="center" gap="md">
      <Stack gap="none" className="flex-[0_0_200px] h-[60px]">
        <Sparkline data={series} width={200} height={60} color="var(--color-primary, #6366f1)" />
      </Stack>

      <Stack gap="none" align="start">
        <EntityCell label={deltaLabel} labelClassName={`text-sm ${deltaClass}`} />
        <MetaLine size="xs" items={['vs 7d ago']} />
      </Stack>
    </Inline>
  );
}
