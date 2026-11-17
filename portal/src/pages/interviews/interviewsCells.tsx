// Cells the interviews tables share (docs/layout-cascade.md "Tables": one thing
// per cell, dates right-aligned, free text capped). A person is shown with
// their portrait where the cast has one (lib/demoPortraits.json), else the
// library's initials; candidates are records and carry no portrait.

import { Avatar, AvatarGroup, Chip, Inline, Link, T } from '@connorhoehn/ui-components/shared';
import { useNavigate } from 'react-router';
import type { ReactNode } from 'react';
import demoPortraits from '../../lib/demoPortraits.json';
import {
  RECOMMENDATION_LABELS, STAGE_LABELS, lastResultLine, recommendationTone, stageTone,
  type ApplicationStage, type ResultBrief,
} from '../../lib/interviews';

const PORTRAITS = new Map<string, string>(
  (demoPortraits as { personas: Array<{ userId?: string | null; portraitUrl?: string | null }> }).personas
    .filter((p) => p.userId && p.portraitUrl).map((p) => [p.userId!, p.portraitUrl!]),
);

/** A link inside the app: a plain click navigates, a modified click still opens the href. */
export function AppLink({ to, children, ...rest }: { to: string; children: ReactNode; 'data-testid'?: string }) {
  const navigate = useNavigate();
  return (
    <Link href={to} {...rest} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); e.stopPropagation(); navigate(to); }}>
      {children}
    </Link>
  );
}

/** A person: portrait (or initials) and name; `to` makes the name a link. `title` carries what the cell has no room for. */
export function PersonCell({ id, name, title, testId, to }: { id?: string; name: string; title?: string; testId?: string; to?: string }) {
  const label = <T size="sm" title={title ?? name} className="block max-w-[16rem] truncate">{name}</T>;
  return (
    <Inline gap="xs" align="center" wrap={false} data-testid={testId}>
      <Avatar name={name} size={24} src={(id && PORTRAITS.get(id)) || undefined} />
      {to ? <AppLink to={to}>{label}</AppLink> : label}
    </Inline>
  );
}

/** The people on a round: the lead by name, the rest as portraits with their names on hover. */
export function PanelCell({ lead, panel }: { lead: { id: string; name: string }; panel: Array<{ id: string; name: string }> }) {
  return (
    <Inline gap="sm" align="center" wrap={false}>
      <PersonCell id={lead.id} name={lead.name} title={panel.length ? `${lead.name} leads, with ${panel.map((p) => p.name).join(', ')}` : `${lead.name} leads`} />
      {panel.length > 0 && <AvatarGroup size={20} items={panel.map((p) => ({ name: p.name, src: PORTRAITS.get(p.id) || undefined }))} />}
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
