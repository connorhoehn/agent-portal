import { Card } from '@connorhoehnslalom/ui-components/shared';
import { DEPT_COLORS } from './types';
import { HistogramBar } from './HistogramBar';

export interface BrokerSummary {
  id: string;
  name: string;
  departmentsTouched: number;
}

export interface CohortStats {
  department: string;
  count: number;
  medianComposite: number;
  meanComposite: number;
  compositeBuckets: [number, number, number, number, number];
  expertiseGini: number;
  brokers: BrokerSummary[];
}

interface CohortCardProps {
  cohort: CohortStats;
}

function giniChipStyle(gini: number): React.CSSProperties {
  if (gini < 0.3) {
    return {
      backgroundColor: 'rgba(22, 163, 74, 0.12)',
      color: '#15803d',
      border: '1px solid rgba(22, 163, 74, 0.3)',
    };
  }
  if (gini <= 0.5) {
    return {
      backgroundColor: 'rgba(202, 138, 4, 0.12)',
      color: '#a16207',
      border: '1px solid rgba(202, 138, 4, 0.3)',
    };
  }
  return {
    backgroundColor: 'rgba(220, 38, 38, 0.12)',
    color: '#b91c1c',
    border: '1px solid rgba(220, 38, 38, 0.3)',
  };
}

export function CohortCard({ cohort }: CohortCardProps) {
  const deptColor = DEPT_COLORS[cohort.department] ?? 'var(--color-text-tertiary)';
  const chipStyle = giniChipStyle(cohort.expertiseGini);

  return (
    <Card padding="none" className="flex overflow-hidden">
      {/* Left colour stripe */}
      <div className="w-[5px] shrink-0" style={{ backgroundColor: deptColor }} />

      {/* Card body */}
      <div className="flex-1 py-4 px-[18px] min-w-0">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-text-primary truncate">
              {cohort.department}
            </div>
            <div className="text-xs text-text-secondary mt-0.5">
              {cohort.count} {cohort.count === 1 ? 'person' : 'people'} &middot; median{' '}
              <span className="font-semibold text-text-primary">
                {cohort.medianComposite.toFixed(1)}
              </span>
            </div>
          </div>

          {/* Gini chip */}
          <span
            className="shrink-0 text-[11px] font-semibold py-[3px] px-2 rounded-full tracking-wide"
            style={chipStyle}
          >
            Gini {cohort.expertiseGini.toFixed(2)}
          </span>
        </div>

        {/* Histogram */}
        <HistogramBar buckets={cohort.compositeBuckets} color={deptColor} height={44} />

        {/* Bucket axis labels */}
        <div className="flex justify-between mt-[3px] text-[10px] text-text-tertiary">
          <span>0</span>
          <span>20</span>
          <span>40</span>
          <span>60</span>
          <span>80</span>
          <span>100</span>
        </div>

        {/* Brokers */}
        {cohort.brokers.length > 0 && (
          <div className="mt-3 border-t border-border pt-[10px]">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-1.5">
              Brokers
            </div>
            <ul className="m-0 p-0 list-none flex flex-col gap-1">
              {cohort.brokers.map((b) => (
                <li key={b.id} className="text-[13px] text-text-primary flex items-center gap-1.5">
                  <span
                    className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                    style={{ backgroundColor: deptColor }}
                  />
                  {b.name}
                  <span className="text-text-tertiary text-xs">
                    (touches {b.departmentsTouched} teams)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
