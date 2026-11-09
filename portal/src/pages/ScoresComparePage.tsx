import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader, Stack } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useCapabilities } from '../lib/capabilities';
import { DEPT_COLORS } from '../components/scores/types';
import { OverlayRadar } from '../components/scores/OverlayRadar';
import { CompareDeltaTable } from '../components/scores/CompareDeltaTable';
import { LeaderboardAccessNeeded, isLeaderboardForbiddenError } from '../components/scores/LeaderboardAccessNeeded';
import type { RadarBatchEntry } from '../components/scores/OverlayRadar';

function ScoresComparePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const idsParam = searchParams.get('ids') ?? '';

  const ids = useMemo(() => {
    if (!idsParam) return [];
    return idsParam.split(',').map(s => s.trim()).filter(Boolean);
  }, [idsParam]);

  const isValid = ids.length >= 2 && ids.length <= 4;

  // Same guard as ScoresPage.tsx / ScoresCohortPage.tsx — ask the
  // capability before asking the server, and never render a raw denial —
  // docs/orgiq-journeys/sme/DEFECTS.md #6.
  const { can, ready: capsReady } = useCapabilities();
  const mayViewLeaderboard = capsReady && can('ViewLeaderboard');

  const fetchUrl = isValid && mayViewLeaderboard
    ? `/api/scores/radar?ids=${ids.map(encodeURIComponent).join(',')}`
    : '';
  const { data, isLoading, error } = useFetch<RadarBatchEntry[]>(fetchUrl);

  // Capabilities not resolved yet is LOADING, not denied — see ScoresPage.tsx.
  if (!capsReady) {
    return <LoadingState label="Loading…" />;
  }
  if (!mayViewLeaderboard) {
    return <LeaderboardAccessNeeded />;
  }

  // Opened with no pair (the rail, the palette, voice `open score-compare`): say what the page needs and
  // where to pick it, instead of the old silent bounce to the leaderboard (UX walk, 9 November 2026).
  if (!isValid) {
    return (
      <EmptyState
        title="Pick two to four people to compare"
        body={ids.length > 4 ? `Compare takes at most four people; ${ids.length} were named.` : 'Tick two to four people on the Scores leaderboard and choose Compare: their radars are overlaid here, with the score deltas between them.'}
        actionLabel="Choose people on the leaderboard"
        onAction={() => navigate('/iq/scores')}
        testId="scores-compare-empty"
      />
    );
  }

  const backUrl = searchParams.get('w') ? `/iq/scores?w=${searchParams.get('w')}` : '/iq/scores';

  return (
    <Stack gap="lg">
      <PageHeader
        title={`Compare ${ids.length} ${ids.length === 1 ? 'person' : 'people'}`}
        back={{ label: '← Back to Scores', to: backUrl }}
      />

      {isLoading && <LoadingState label="Loading radar data…" />}

      {error && (isLeaderboardForbiddenError(error)
        ? <LeaderboardAccessNeeded />
        : <ErrorState title="Failed to load" body={error} />)}

      {data && data.length > 0 && (
        <Stack gap="lg">
          <OverlayRadar entries={data} deptColors={DEPT_COLORS} />
          <Card padding="none">
            <CompareDeltaTable entries={data} />
          </Card>
        </Stack>
      )}

      {data && data.length === 0 && (
        <EmptyState
          title="No radar data"
          body="No radar data found for the selected people. Scores may not have been computed yet."
        />
      )}
    </Stack>
  );
}

export default ScoresComparePage;
