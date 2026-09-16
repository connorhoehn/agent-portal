// Shown while a department chip is active: headcount, the department's top
// skills, and its bus-factor risk — skills only a couple of people hold
// org-wide, where at least one holder sits in this department.
//
// `department: null` renders the org-wide variant instead (the toolbar's
// "Rare skills" toggle) — no headcount/top-skills header, and every holder of
// a rare skill gets its own pill rather than one representative per
// department, since there's no department to pick "the" holder from.

import { useMemo } from 'react';
import { Link } from 'react-router';
import { Button, Inline } from '@connorhoehnslalom/ui-components/shared';
import { ContextStrip, OverlineLabel } from './graphOverlay';
import { departmentInsight, orgInsight, rareSkillFindingsUrl, firstName, type AtRiskSkill } from './graphInsights';
import type { GraphPerson } from './types';

export interface DepartmentInsightStripProps {
  /** null renders the org-wide rare-skills view instead of one department. */
  department: string | null;
  people: GraphPerson[];
  /** Click an at-risk holder → focus them (select + detail). */
  onFocusPerson: (id: string) => void;
}

export function DepartmentInsightStrip({
  department,
  people,
  onFocusPerson,
}: DepartmentInsightStripProps) {
  const { members, topSkills, atRisk } = useMemo((): {
    members: GraphPerson[];
    topSkills: [string, number][];
    atRisk: AtRiskSkill[];
  } => department
    ? departmentInsight(people, department)
    : { members: people, topSkills: [], ...orgInsight(people) },
  [department, people]);

  return (
    <ContextStrip aria-label={department ? `${department} insight` : 'Org-wide rare skills'}>
      <Inline as="span" gap="none" className="whitespace-nowrap font-bold">
        {department ? <>{department} · {members.length} people</> : 'Rare skills · org-wide'}
      </Inline>

      {topSkills.length > 0 && (
        <Inline gap="xs" align="center" wrap as="span" className="text-text-secondary">
          <OverlineLabel>Top skills</OverlineLabel>
          {topSkills.map(([skill, n]) => (
            <Inline as="span" gap="none" key={skill} className="whitespace-nowrap">
              {skill}{' '}
              <Inline as="span" gap="none" className="text-[10px] tabular-nums text-text-tertiary">({n})</Inline>
            </Inline>
          ))}
        </Inline>
      )}

      {atRisk.length > 0 && (
        <Inline gap="xs" align="center" wrap as="span">
          <OverlineLabel tone="warning">⚠ rare skills</OverlineLabel>
          {/* A rare skill is only actionable if you can reach the person who
              holds it, so the pill IS the jump to them. It has to be a real
              <button>: these were Chip-shaped before, but Chip renders a span,
              so the only way to reach them was a mouse. Beside it, a real Link
              to the bus-factor finding for that skill — the pill focuses the
              person, the link goes to the finding the sweep already filed. */}
          {atRisk.map(({ skill, holder, holderCount }) => (
            <Inline key={`${skill}-${holder.id}`} gap="none" align="center" as="span" className="whitespace-nowrap">
              <Button
                variant="ghost"
                size="sm"
                className="text-warning"
                title={`${skill} — only ${holderCount} ${holderCount === 1 ? 'person' : 'people'} org-wide. Click to focus ${holder.name}.`}
                onClick={() => onFocusPerson(holder.id)}
              >
                {skill} · {firstName(holder.name)}
              </Button>
              <Link
                to={rareSkillFindingsUrl(skill)}
                title={`See the bus-factor finding for ${skill} in Work → Findings`}
                className="text-[11px] text-primary no-underline hover:underline"
              >
                finding →
              </Link>
            </Inline>
          ))}
        </Inline>
      )}
    </ContextStrip>
  );
}
