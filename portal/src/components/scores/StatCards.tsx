import { Card } from '@connorhoehnslalom/ui-components/shared';
import { formatRelativeTime } from './types';

interface Props {
  peopleScored: number;
  avgComposite: number;
  topScore: number;
  departmentCount: number;
  mostRecentScoredAt: string | null;
  weight?: number;
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card padding="md">
      <div style={{ fontSize: 12, color: 'var(--color-text-tertiary)' }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </Card>
  );
}

export function StatCards({ peopleScored, avgComposite, topScore, departmentCount, mostRecentScoredAt, weight: _weight = 0.55 }: Props) {
  const freshnessLabel = mostRecentScoredAt === null
    ? 'Scores updated never — run the scoring agent'
    : `Scores updated ${formatRelativeTime(mostRecentScoredAt)}`;

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 8, textAlign: 'right' }}>
        {freshnessLabel}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16 }}>
        <StatCard label="People Scored" value={String(peopleScored)} />
        <StatCard label="Avg Composite" value={String(avgComposite)} />
        <StatCard label="Top Score" value={String(topScore)} />
        <StatCard label="Departments" value={String(departmentCount)} />
      </div>
    </div>
  );
}
