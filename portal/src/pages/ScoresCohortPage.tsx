
import { PageSection } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../hooks/useFetch';
import { CohortCard, type CohortStats } from '../components/scores/CohortCard';

function ScoresCohortPage() {
  const { data, isLoading, error } = useFetch<CohortStats[]>('/api/scores/cohorts');

  if (isLoading) {
    return (
      <div style={{ padding: 24, color: 'var(--color-text-tertiary, #9ca3af)' }}>
        Loading cohort data...
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 24, color: 'var(--color-error, #dc2626)' }}>
        Failed to load cohorts: {error}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div style={{ padding: 40, maxWidth: 560 }}>
        <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 8 }}>No department data yet</h2>
        <p style={{ fontSize: 14, color: 'var(--color-text-secondary, #6b7280)', lineHeight: 1.6 }}>
          Run <code>python schema/seed.py</code> to populate Aurora with people and scores,
          then this page will show per-department analytics automatically.
        </p>
      </div>
    );
  }

  return (
    <PageSection title="Score Cohorts">
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))',
          gap: 20,
        }}
      >
        {data.map((cohort) => (
          <CohortCard key={cohort.department} cohort={cohort} />
        ))}
      </div>
    </PageSection>
  );
}

export default ScoresCohortPage;
