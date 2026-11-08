import { useMemo } from 'react';
import { Combobox, FilterChip, Inline } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';

interface SkillSummary {
  id: string;
  name: string;
  mentionCount: number;
}

interface Props {
  selectedSkill: string;
  onChange: (skill: string) => void;
}

// A free-text skill search on the library `Combobox` (2.410.0): the input keeps
// focus, arrows move the highlight, Enter picks, Escape closes without
// clearing, Tab is never intercepted. The "Ranked by" chip clears the filter.
export function SkillFilter({ selectedSkill, onChange }: Props) {
  const { data: skills } = useFetch<SkillSummary[]>('/api/scores/skills');
  const options = useMemo(
    () => (skills ?? []).map(s => ({ value: s.name, label: s.name })),
    [skills],
  );
  return (
    <Inline align="center" gap="xs">
      <Combobox
        options={options}
        value={selectedSkill}
        onChange={onChange}
        placeholder="Search skill…"
        aria-label="Search skills"
        size="sm"
        maxOptions={8}
        emptyMessage="No skills match"
        className="w-[180px]"
      />
      {selectedSkill && (
        <FilterChip active onClick={() => onChange('')}>
          Ranked by: {selectedSkill} ✕
        </FilterChip>
      )}
    </Inline>
  );
}
