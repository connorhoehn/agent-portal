// Focus the graph on one department. Each chip carries the department's own
// colour so the filter row and the nodes agree about what "Engineering" looks
// like — that is why FilterChip has a `color` prop.

import { useMemo } from 'react';
import { FilterChip, Inline } from '@connorhoehnslalom/ui-components/shared';
import { membersByDepartment } from './graphInsights';
import type { GraphDepartment, GraphPerson } from './types';

export interface DepartmentChipsProps {
  departments: GraphDepartment[];
  people: GraphPerson[];
  activeDepartment: string | null;
  onToggle: (name: string | null, memberIds: string[]) => void;
}

export function DepartmentChips({
  departments,
  people,
  activeDepartment,
  onToggle,
}: DepartmentChipsProps) {
  const counts = useMemo(() => membersByDepartment(people), [people]);

  return (
    <Inline gap="xs" align="center" wrap as="span">
      {departments.map((d) => {
        const members = counts.get(d.name) ?? [];
        // A department with nobody in the current roster is not a filter.
        if (members.length === 0) return null;
        const active = activeDepartment === d.name;
        return (
          <FilterChip
            key={d.id}
            active={active}
            color={d.color}
            dot
            size="sm"
            onClick={() => onToggle(active ? null : d.name, members)}
          >
            {d.name}
            <span className="ml-1 text-[10px] tabular-nums text-text-tertiary">{members.length}</span>
          </FilterChip>
        );
      })}
    </Inline>
  );
}
