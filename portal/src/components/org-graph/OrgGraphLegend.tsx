import type { GraphDepartment } from './types';

const PRESENCE_LEGEND = [
  { color: '#16a34a', label: 'In office' },
  { color: '#3b82f6', label: 'Remote' },
  { color: '#f59e0b', label: 'Traveling' },
  { color: '#f97316', label: 'PTO' },
  { color: '#8b5cf6', label: 'Vacation' },
  { color: '#ef4444', label: 'Sick' },
];

interface OrgGraphLegendProps {
  departments: GraphDepartment[];
  filter: string | null;
  onFilter: (dept: string | null) => void;
}

const EDGE_TYPES = [
  { type: 'collaborates', color: '#94a3b8', label: 'Collaborates' },
  { type: 'mentors', color: '#6366f1', label: 'Mentors', dash: true },
  { type: 'reports_to', color: '#d1d5db', label: 'Reports To', dash: true },
  { type: 'expert_in_common', color: '#f59e0b', label: 'Shared Expertise' },
];

export function OrgGraphLegend({ departments, filter, onFilter }: OrgGraphLegendProps) {
  return (
    <div style={{
      position: 'absolute',
      top: 12,
      left: 12,
      background: 'white',
      border: '1px solid var(--color-border, #e2e8f0)',
      borderRadius: 8,
      padding: '12px 16px',
      fontSize: 11,
      boxShadow: '0 2px 8px rgba(0,0,0,0.06)',
    }}>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, color: 'var(--color-text-primary, #1a1a2e)' }}>
        Departments
      </div>
      {departments.map(dept => (
        <div
          key={dept.id}
          onClick={() => onFilter(filter === dept.name ? null : dept.name)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginBottom: 4,
            cursor: 'pointer',
            opacity: !filter || filter === dept.name ? 1 : 0.4,
          }}
        >
          <span style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: dept.color,
            flexShrink: 0,
          }} />
          <span>{dept.name}</span>
        </div>
      ))}
      <div style={{ borderTop: '1px solid var(--color-border, #e2e8f0)', marginTop: 8, paddingTop: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>Relationships</div>
        {EDGE_TYPES.map(et => (
          <div key={et.type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <svg width={20} height={8}>
              <line
                x1={0} y1={4} x2={20} y2={4}
                stroke={et.color}
                strokeWidth={2}
                strokeDasharray={et.dash ? '4 2' : undefined}
              />
            </svg>
            <span>{et.label}</span>
          </div>
        ))}
      </div>
      {filter && (
        <button
          onClick={() => onFilter(null)}
          style={{
            marginTop: 8,
            width: '100%',
            padding: '4px 0',
            fontSize: 11,
            border: '1px solid var(--color-border, #e2e8f0)',
            borderRadius: 4,
            background: 'var(--color-surface-hover, #f8fafc)',
            cursor: 'pointer',
          }}
        >
          Clear Filter
        </button>
      )}

      {/* Presence dot legend */}
      <div style={{ borderTop: '1px solid var(--color-border, #e2e8f0)', marginTop: 8, paddingTop: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 5 }}>Presence today</div>
        {PRESENCE_LEGEND.map(({ color, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
            <span>{label}</span>
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#3b82f6', flexShrink: 0, boxSizing: 'border-box', outline: '2px dashed #3b82f6', outlineOffset: 3 }} />
          <span style={{ color: 'var(--color-text-tertiary)' }}>WFH ring</span>
        </div>
      </div>
    </div>
  );
}
