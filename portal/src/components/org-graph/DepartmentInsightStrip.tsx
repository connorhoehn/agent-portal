// Shown while a department chip is active: headcount, the department's top
// skills, and its bus-factor risk — skills only a couple of people hold
// org-wide, where at least one holder sits in this department.

import { useMemo } from 'react';
import { Button, Inline } from '@connorhoehnslalom/ui-components/shared';
import { ContextStrip, OverlineLabel } from './graphOverlay';
import { departmentInsight, firstName } from './graphInsights';
import type { GraphPerson } from './types';

export interface DepartmentInsightStripProps {
  department: string;
  people: GraphPerson[];
  /** Click an at-risk holder → focus them (select + detail). */
  onFocusPerson: (id: string) => void;
}

export function DepartmentInsightStrip({
  department,
  people,
  onFocusPerson,
}: DepartmentInsightStripProps) {
  const { members, topSkills, atRisk } = useMemo(
    () => departmentInsight(people, department),
    [department, people],
  );

  return (
    <ContextStrip aria-label={`${department} insight`}>
      <span className="whitespace-nowrap font-bold">
        {department} · {members.length} people
      </span>

      {topSkills.length > 0 && (
        <Inline gap="xs" align="center" wrap as="span" className="text-text-secondary">
          <OverlineLabel>Top skills</OverlineLabel>
          {topSkills.map(([skill, n]) => (
            <span key={skill} className="whitespace-nowrap">
              {skill}{' '}
              <span className="text-[10px] tabular-nums text-text-tertiary">({n})</span>
            </span>
          ))}
        </Inline>
      )}

      {atRisk.length > 0 && (
        <Inline gap="xs" align="center" wrap as="span">
          <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-wide text-warning">
            ⚠ rare skills
          </span>
          {/* A rare skill is only actionable if you can reach the person who
              holds it, so the pill IS the jump to them. It has to be a real
              <button>: these were Chip-shaped before, but Chip renders a span,
              so the only way to reach them was a mouse. */}
          {atRisk.map(({ skill, holder, holderCount }) => (
            <Button
              key={skill}
              variant="ghost"
              size="sm"
              className="text-warning"
              title={`${skill} — only ${holderCount} ${holderCount === 1 ? 'person' : 'people'} org-wide. Click to focus ${holder.name}.`}
              onClick={() => onFocusPerson(holder.id)}
            >
              {skill} · {firstName(holder.name)}
            </Button>
          ))}
        </Inline>
      )}
    </ContextStrip>
  );
}
