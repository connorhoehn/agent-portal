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
    <div className="mb-4">
      <div className="text-[11px] text-text-tertiary mb-2 text-right">
        {freshnessLabel}
      </div>
      <div className="grid grid-cols-4 gap-4">
        <StatCard label="People Scored" value={String(peopleScored)} />
        <StatCard label="Avg Composite" value={String(avgComposite)} />
        <StatCard label="Top Score" value={String(topScore)} />
        <StatCard label="Departments" value={String(departmentCount)} />
      </div>
    </div>
  );
}
