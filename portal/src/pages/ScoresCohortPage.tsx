import { CatalogGrid, EmptyState, ErrorState, LoadingState, PageSection, VisuallyHidden } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { useCapabilities } from '../lib/capabilities';
import { CohortCard, type CohortStats } from '../components/scores/CohortCard';
import { LeaderboardAccessNeeded, isLeaderboardForbiddenError } from '../components/scores/LeaderboardAccessNeeded';

function ScoresCohortPage() {
  // Same guard as ScoresPage.tsx: ask the capability before asking the
  // server, so a role without the grant never fires the request (and never
  // sees the request's raw denial) — docs/orgiq-journeys/sme/DEFECTS.md #6.
  const { can, ready: capsReady } = useCapabilities();
  const mayViewLeaderboard = capsReady && can('ViewLeaderboard');
  const { data, isLoading, error } = useFetch<CohortStats[]>(mayViewLeaderboard ? '/api/scores/cohorts' : null);

  // Capabilities not resolved yet is LOADING, not denied — see ScoresPage.tsx.
  if (!capsReady || isLoading) {
    return <LoadingState label="Loading cohort data…" />;
  }

  if (!mayViewLeaderboard) {
    return <LeaderboardAccessNeeded />;
  }

  if (error) {
    if (isLeaderboardForbiddenError(error)) return <LeaderboardAccessNeeded />;
    return <ErrorState title="Failed to load cohorts" body={error} />;
  }

  if (!data || data.length === 0) {
    return (
      <>
        <VisuallyHidden as="h1">Score Cohorts</VisuallyHidden>
        <EmptyState
          title="No department data yet"
          description="Once people have been scored, each department's median, spread and brokers appear here automatically."
        />
      </>
    );
  }

  return (
    <PageSection title="Score Cohorts">
      <CatalogGrid columns={3}>
        {data.map((cohort) => (
          <CohortCard key={cohort.department} cohort={cohort} />
        ))}
      </CatalogGrid>
    </PageSection>
  );
}

export default ScoresCohortPage;
