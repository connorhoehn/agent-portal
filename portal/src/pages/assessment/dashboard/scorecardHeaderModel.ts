// The team scorecard's header row and dimension rail, as data. No React, so
// node:test runs it alone.
//
// The user (2026-10-07, /assessment/teams/TEAM-005): the header "is taking too
// much vertical space… get things into rows together so I can have more space
// for the content and then the chat". So the coverage that used to be a
// four-card strip, two sentences and a separate collapsible bar is ONE line of
// facts under the title (a `StatStrip variant="line" size="sm"`), the level
// progress drawn inline on its first cluster; the sentences move into the
// title's info card. The 17-dimension rail is grouped by where each dimension
// stands, with no search box (17 rows do not need one), and Discussion is the
// shell's right pane, not a tab.

import { ofTotal } from '../../../lib/plural.ts';
import { hasOpenClaim, highestVerifiedLevel, type Dimension, type TeamCertification } from '../types.ts';

/** The scorecard's tabs. Discussion is not one: it is the right pane. */
export type ScorecardTab = 'scorecard' | 'plan' | 'stories' | 'evidence' | 'documents' | 'activity';
export const SCORECARD_TABS: readonly { id: ScorecardTab; label: string }[] = [
  { id: 'scorecard', label: 'Certification' },
  { id: 'plan', label: 'Improvement Plan' },
  { id: 'stories', label: 'Stories' },
  { id: 'evidence', label: 'Evidence & Intake' },
  { id: 'documents', label: 'Documents' },
  { id: 'activity', label: 'Activity' },
];

/**
 * `?tab=` → the tab to show. The retired `?tab=discussion` (bell items, old
 * links, other specs) lands on Certification with the right pane revealed;
 * anything unknown is Certification.
 */
export function scorecardTabFromParam(param: string | null): { tab: ScorecardTab; revealDiscussion: boolean } {
  if (param === 'discussion') return { tab: 'scorecard', revealDiscussion: true };
  const known = SCORECARD_TABS.find((t) => t.id === param);
  return { tab: known ? known.id : 'scorecard', revealDiscussion: false };
}

export interface HeaderFactsInput {
  certification?: TeamCertification | null;
  dimensions_assessed: number;
  dimensions_total: number;
  followups_open: number;
  workflow_step_label: string;
  /** The lead assessor's name (a name, never a person id — types.ts). */
  assessment_lead?: string | null;
}

export interface HeaderFact {
  label: string;
  value: string | number;
  tone: 'default' | 'accent' | 'danger';
  /** The full reading, as the cluster's tooltip. */
  title: string;
  /** The level progress toward the target (drawn inline on the line). Null when unknown. */
  progress: { value: number; max: number } | null;
}

/**
 * The header's one line of facts: verified level (with its progress toward the
 * target), coverage, open follow-ups, workflow step. `line` stats read value
 * then label, so each label is the rest of the sentence.
 */
export function scorecardFacts(team: HeaderFactsInput, activeStepLabel?: string | null): HeaderFact[] {
  const cert = team.certification ?? null;
  const verified = highestVerifiedLevel(cert);
  const target = cert?.target_level ?? null;
  const step = activeStepLabel ?? team.workflow_step_label;
  const level: HeaderFact = verified != null
    ? {
        label: target != null ? `verified · target L${target}` : 'highest verified',
        value: `L${verified}`,
        tone: 'accent',
        title: target != null
          ? `Highest verified level across assessed dimensions: L${verified}, working toward Level ${target}`
          : `Highest verified level across assessed dimensions: L${verified}`,
        // Drawn only with a real target: "L1 of 3" is a fact, a bar against nothing is not.
        progress: target != null && target > 0 ? { value: Math.min(verified, target), max: target } : null,
      }
    : {
        label: target != null ? `verified · target L${target}` : 'verified',
        value: 'None',
        tone: 'default',
        title: target != null ? `Not yet verified on any dimension; working toward Level ${target}` : 'Not yet verified on any dimension',
        progress: null,
      };
  return [
    level,
    {
      label: 'assessed',
      value: `${team.dimensions_assessed}/${team.dimensions_total}`,
      tone: 'default',
      title: `${ofTotal(team.dimensions_assessed, team.dimensions_total, 'dimension')} assessed`,
      progress: null,
    },
    {
      label: team.followups_open === 1 ? 'open follow-up' : 'open follow-ups',
      value: team.followups_open,
      tone: team.followups_open > 0 ? 'danger' : 'default',
      title: `${team.followups_open} open follow-up question${team.followups_open === 1 ? '' : 's'}`,
      progress: null,
    },
    { label: 'workflow step', value: step, tone: 'default', title: `Workflow step: ${step}`, progress: null },
    ...(team.assessment_lead?.trim()
      ? [{ label: 'lead assessor', value: team.assessment_lead.trim(), tone: 'default' as const, title: `Assessed by ${team.assessment_lead.trim()}`, progress: null }]
      : []),
  ];
}

/** One rung of the level track: L1…L<target>, the library `WorkflowStep` shape. */
export interface LevelTrackStep { step: number; label: string; done: boolean; active: boolean }

/**
 * The verified level as a stepped track toward the target (the compact
 * `WorkflowStepper` on the facts line, ui-components 2.440): every level up to
 * the verified one is done, the next is the one being worked toward, the rest
 * are ahead. Empty when the fact carries no progress (no target, or nothing
 * verified) — the same rule the bar it replaces had.
 */
export function levelTrackSteps(progress: HeaderFact['progress']): LevelTrackStep[] {
  if (!progress || !(progress.max > 0) || !Number.isFinite(progress.value)) return [];
  return Array.from({ length: progress.max }, (_, i) => {
    const level = i + 1;
    return { step: level, label: `L${level}`, done: level <= progress.value, active: level === progress.value + 1 };
  });
}

// ─── The dimension rail ────────────────────────────────────────────────────

export type DimensionRailGroupId = 'claims' | 'verified' | 'unassessed' | 'na';

export const DIMENSION_RAIL_GROUPS: readonly { id: DimensionRailGroupId; title: string }[] = [
  { id: 'claims', title: 'Claims to verify' },
  { id: 'verified', title: 'Verified' },
  { id: 'unassessed', title: 'Not yet assessed' },
  { id: 'na', title: 'Not applicable' },
];

type RailDimension = Pick<Dimension, 'id' | 'is_na' | 'current_level' | 'certification'>;

/** Where a dimension stands: an open claim first, then verified, unassessed, not applicable. */
export function dimensionRailGroup(dimension: RailDimension): DimensionRailGroupId {
  if (dimension.is_na) return 'na';
  if (dimension.certification && hasOpenClaim(dimension.certification)) return 'claims';
  const level = dimension.certification?.verified_level ?? dimension.current_level;
  return level == null ? 'unassessed' : 'verified';
}

/** The rail's groups with their counts, in order; empty groups are dropped. */
export function dimensionRailGroups(dimensions: readonly RailDimension[]): { id: DimensionRailGroupId; title: string; count: number }[] {
  return DIMENSION_RAIL_GROUPS
    .map((group) => ({ ...group, count: dimensions.filter((d) => dimensionRailGroup(d) === group.id).length }))
    .filter((group) => group.count > 0);
}

/** "Open claims" narrows the rail to the dimensions whose claim sits above verification. */
export function filterRailDimensions<T extends RailDimension>(dimensions: readonly T[], onlyClaims: boolean): T[] {
  return onlyClaims ? dimensions.filter((d) => dimensionRailGroup(d) === 'claims') : [...dimensions];
}

/** "01 Continuous Integration (CI)" — the rail row's title, numbered in the rubric's order. */
export const dimensionRailTitle = (index: number, title: string): string => `${String(index + 1).padStart(2, '0')} ${title}`;
