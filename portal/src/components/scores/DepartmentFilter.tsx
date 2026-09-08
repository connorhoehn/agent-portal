import { FormField, Select } from '@connorhoehnslalom/ui-components/shared';

interface Props {
  departments: string[];
  selected: string;
  onChange: (d: string) => void;
}

// A closed Select, not a row of FilterChips per department — the chip row
// grew with the department count and was one of the stacked blocks pushing
// the leaderboard below the fold (DEFECTS.md #3). One control, fixed width,
// sits inline with the skill search and weighting trigger.
export function DepartmentFilter({ departments, selected, onChange }: Props) {
  return (
    <FormField label="Department" layout="inline">
      {(wiring) => (
        <Select
          id={wiring.id}
          aria-describedby={wiring['aria-describedby']}
          value={selected}
          onChange={(e) => onChange(e.target.value)}
          size="sm"
          options={[
            { value: '', label: 'All departments' },
            ...departments.map(d => ({ value: d, label: d })),
          ]}
        />
      )}
    </FormField>
  );
}
