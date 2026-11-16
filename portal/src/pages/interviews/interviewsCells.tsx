// Cells the interviews tables share (docs/layout-cascade.md "Tables": one thing
// per cell, dates right-aligned, free text capped). A person is shown with
// their portrait where the cast has one (lib/demoPortraits.json), else the
// library's initials; candidates are records and carry no portrait.

import { Avatar, Chip, Inline, T } from '@connorhoehn/ui-components/shared';
import demoPortraits from '../../lib/demoPortraits.json';
import {
  RECOMMENDATION_LABELS, STAGE_LABELS, lastResultLine, recommendationTone, stageTone,
  type ApplicationStage, type ResultBrief,
} from '../../lib/interviews';

const PORTRAITS = new Map<string, string>(
  (demoPortraits as { personas: Array<{ userId?: string | null; portraitUrl?: string | null }> }).personas
    .filter((p) => p.userId && p.portraitUrl).map((p) => [p.userId!, p.portraitUrl!]),
);

/** A person: portrait (or initials) and name. `title` carries what the cell has no room for. */
export function PersonCell({ id, name, title, testId }: { id?: string; name: string; title?: string; testId?: string }) {
  return (
    <Inline gap="xs" align="center" wrap={false} data-testid={testId}>
      <Avatar name={name} size={24} src={(id && PORTRAITS.get(id)) || undefined} />
      <T size="sm" title={title ?? name} className="block max-w-[16rem] truncate">{name}</T>
    </Inline>
  );
}

export function StageChip({ stage }: { stage: ApplicationStage }) {
  return <Chip tone={stageTone(stage)} size="xs">{STAGE_LABELS[stage]}</Chip>;
}

/** The latest scorecard as "Yes · Coding", or "Scorecard due" while one is owed, or a dash. */
export function ResultChip({ result, due = false }: { result: ResultBrief | null; due?: boolean }) {
  if (result) {
    return (
      <Chip tone={recommendationTone(result.recommendation)} size="xs"
        title={`${RECOMMENDATION_LABELS[result.recommendation]} from ${result.interviewer.name} after ${result.roundName}`}>
        {lastResultLine(result)}
      </Chip>
    );
  }
  if (due) return <Chip tone="caution" size="xs">Scorecard due</Chip>;
  return <T size="xs" tone="tertiary">—</T>;
}

export const Dash = () => <T size="xs" tone="tertiary">—</T>;
