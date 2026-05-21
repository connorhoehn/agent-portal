import { FilterChip } from '@connorhoehnslalom/ui-components/shared';

interface Props {
  departments: string[];
  selected: string;
  onChange: (d: string) => void;
  deptColors: Record<string, string>;
}

export function DepartmentFilter({ departments, selected, onChange, deptColors }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12 }}>
      <span style={{ color: 'var(--color-text-tertiary)' }}>Filter:</span>
      <FilterChip
        active={selected === ''}
        onClick={() => onChange('')}
        color="#64748b"
      >
        All
      </FilterChip>
      {departments.map(d => (
        <FilterChip
          key={d}
          active={selected === d}
          onClick={() => onChange(d)}
          color={deptColors[d] ?? '#64748b'}
        >
          {d}
        </FilterChip>
      ))}
    </div>
  );
}
