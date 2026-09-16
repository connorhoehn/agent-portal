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
import { Button, Inline, MetaLine } from '@connorhoehnslalom/ui-components/shared';
import { ContextStrip, OverlineLabel } from './graphOverlay';
import {
  departmentInsight, orgInsight, rareSkillFindingsUrl, findingForSkill, firstName,
  type AtRiskSkill, type FindingLike,
} from './graphInsights';
import type { GraphPerson } from './types';

export interface DepartmentInsightStripProps {
  /** null renders the org-wide rare-skills view instead of one department. */
  department: string | null;
  people: GraphPerson[];
  /** Click an at-risk holder → focus them (select + detail). */
  onFocusPerson: (id: string) => void;
  /**
   * skill name → the server's open bus-factor finding for it, from
   * `GET /api/work/findings?status=open&sweep=bus_factor`, built by
   * `indexBusFactorFindings`. `null` means the read hasn't resolved
   * successfully (still loading, or failed) — the strip falls back to the
   * old unconditional "finding →" link rather than asserting "not on the
   * sweep yet" for something it never actually checked.
   */
  busFactorFindings: Map<string, FindingLike> | null;
  /** True only when the findings read genuinely failed (not while merely
   *  loading) — drives the "could not read the sweep" note. */
  busFactorFindingsUnavailable?: boolean;
}

export function DepartmentInsightStrip({
  department,
  people,
  onFocusPerson,
  busFactorFindings,
  busFactorFindingsUnavailable,
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
              to the bus-factor finding for that skill — but only when the
              server's own sweep actually filed one; this is a live client-side
              read and the sweep is a persisted, scheduled one, so the two can
              disagree. When `busFactorFindings` hasn't resolved we don't know
              either way, so we fall back to the old unconditional link rather
              than claim "not on the sweep yet" for something unchecked. */}
          {atRisk.map(({ skill, holder, holderCount }) => {
            const finding = busFactorFindings ? findingForSkill(busFactorFindings, skill) : undefined;
            const showFindingLink = finding !== null; // null (checked, absent) still gets no link; unknown/found do
            return (
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
                {showFindingLink ? (
                  <Link
                    to={rareSkillFindingsUrl(skill, finding?.id)}
                    title={finding
                      ? `Open the bus-factor finding the sweep filed for ${skill}`
                      : `See the bus-factor finding for ${skill} in Work → Findings`}
                    className="text-[11px] text-primary no-underline hover:underline"
                  >
                    finding →
                  </Link>
                ) : (
                  <Inline
                    as="span"
                    gap="none"
                    className="text-[11px] text-text-tertiary italic"
                    title={`The scheduled bus-factor sweep hasn't flagged ${skill} — this read is live from the graph, the sweep runs on a schedule, and they can disagree.`}
                  >
                    not on the sweep yet
                  </Inline>
                )}
              </Inline>
            );
          })}
        </Inline>
      )}
      {atRisk.length > 0 && busFactorFindingsUnavailable && (
        <MetaLine
          size="xs"
          tone="secondary"
          items={['Could not read the bus-factor sweep — showing every rare skill from the live graph instead.']}
        />
      )}
    </ContextStrip>
  );
}
