import React from 'react';

interface Props {
  departments: string[];
  selected: string;
  onChange: (d: string) => void;
  deptColors: Record<string, string>;
}

function chipBtn(active: boolean, color: string): React.CSSProperties {
  return {
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: active ? 600 : 400,
    border: `1px solid ${active ? color : 'var(--color-border)'}`,
    background: active ? `${color}15` : 'var(--color-surface)',
    color: active ? color : 'var(--color-text-secondary)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
  };
}

export function DepartmentFilter({ departments, selected, onChange, deptColors }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12 }}>
      <span style={{ color: 'var(--color-text-tertiary)' }}>Filter:</span>
      <button
        onClick={() => onChange('')}
        style={chipBtn(selected === '', '#64748b')}
      >
        All
      </button>
      {departments.map(d => (
        <button
          key={d}
          onClick={() => onChange(d)}
          style={chipBtn(selected === d, deptColors[d] ?? '#64748b')}
        >
          {d}
        </button>
      ))}
    </div>
  );
}
