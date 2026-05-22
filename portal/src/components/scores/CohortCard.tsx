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
    <div
      style={{
        display: 'flex',
        borderRadius: 8,
        border: '1px solid var(--color-border, #e5e7eb)',
        overflow: 'hidden',
        backgroundColor: 'var(--color-surface, #fff)',
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
      }}
    >
      {/* Left colour stripe */}
      <div style={{ width: 5, flexShrink: 0, backgroundColor: deptColor }} />

      {/* Card body */}
      <div style={{ flex: 1, padding: '16px 18px', minWidth: 0 }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: 'var(--color-text-primary, #111)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {cohort.department}
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #6b7280)', marginTop: 2 }}>
              {cohort.count} {cohort.count === 1 ? 'person' : 'people'} &middot; median{' '}
              <span style={{ fontWeight: 600, color: 'var(--color-text-primary, #111)' }}>
                {cohort.medianComposite.toFixed(1)}
              </span>
            </div>
          </div>

          {/* Gini chip */}
          <span
            style={{
              flexShrink: 0,
              fontSize: 11,
              fontWeight: 600,
              padding: '3px 8px',
              borderRadius: 9999,
              letterSpacing: '0.02em',
              ...chipStyle,
            }}
          >
            Gini {cohort.expertiseGini.toFixed(2)}
          </span>
        </div>

        {/* Histogram */}
        <HistogramBar buckets={cohort.compositeBuckets} color={deptColor} height={44} />

        {/* Bucket axis labels */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 3,
            fontSize: 10,
            color: 'var(--color-text-tertiary, #9ca3af)',
          }}
        >
          <span>0</span>
          <span>20</span>
          <span>40</span>
          <span>60</span>
          <span>80</span>
          <span>100</span>
        </div>

        {/* Brokers */}
        {cohort.brokers.length > 0 && (
          <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border, #e5e7eb)', paddingTop: 10 }}>
            <div
              style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-tertiary, #9ca3af)', marginBottom: 6 }}
            >
              Brokers
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {cohort.brokers.map((b) => (
                <li key={b.id} style={{ fontSize: 13, color: 'var(--color-text-primary, #111)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      backgroundColor: deptColor,
                      flexShrink: 0,
                    }}
                  />
                  {b.name}
                  <span style={{ color: 'var(--color-text-tertiary, #9ca3af)', fontSize: 12 }}>
                    (touches {b.departmentsTouched} teams)
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
