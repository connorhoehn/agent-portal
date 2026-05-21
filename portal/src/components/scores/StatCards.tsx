import { StatCard } from '@connorhoehnslalom/ui-components/shared';
import { formatRelativeTime } from './types';

interface Props {
  peopleScored: number;
  avgComposite: number;
  topScore: number;
  departmentCount: number;
  mostRecentScoredAt: string | null;
  weight?: number;
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
