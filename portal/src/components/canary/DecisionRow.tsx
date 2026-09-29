// DecisionRow — one controller decision, in the three skins the canary
// surfaces need: `list` (the full-page table in CanaryDeploymentsView),
// `node` (the compact three-line preview inside the ReactFlow ControllerNode),
// and `card` (the collapsible rail row in DecisionHistoryPanel). These used
// to be three separate components, each with its own private timestamp
// formatter (`fmtDate`, `formatTs`, `fmtTime`) at a different precision —
// absoluteTime (lib/relativeTime) backs the clock face in all three now.

import { useState } from 'react';
import {
  Button, Chip, ChoiceRow, EntityCell, Inline, MetaLine, Stack, TableRow, TableTd,
} from '@connorhoehnslalom/ui-components/shared';
import { absoluteTime } from '../../lib/relativeTime';
import type { ControllerAction, Decision } from './types.js';

// A Chip tone per action, shared by the `list` and `card` skins.
// SKIPPED_OVERRIDE has no dedicated tone on the scale; `accent` is the
// closest match.
const ACTION_TONE: Record<ControllerAction, 'success' | 'danger' | 'warning' | 'accent' | 'neutral'> = {
  PROMOTE: 'success',
  ROLLBACK: 'danger',
  HOLD: 'warning',
  SKIPPED_OVERRIDE: 'accent',
  SKIPPED_COOLDOWN: 'neutral',
  SKIPPED_NO_SAMPLES: 'neutral',
};

const ACTION_LABEL: Record<ControllerAction, string> = {
  PROMOTE: 'Promote',
  ROLLBACK: 'Rollback',
  HOLD: 'Hold',
  SKIPPED_OVERRIDE: 'Skip — override',
  SKIPPED_COOLDOWN: 'Skip — cooldown',
  SKIPPED_NO_SAMPLES: 'Skip — no data',
};

// The compact `node` skin renders the action as coloured text rather than a
// Chip (there's no room for a pill in a 280px flow node), so it keeps its
// own text-colour map on the same three tones.
const ACTION_TEXT_CLASS: Record<ControllerAction, string> = {
  PROMOTE: 'text-success',
  ROLLBACK: 'text-danger',
  HOLD: 'text-text-secondary',
  SKIPPED_OVERRIDE: 'text-[var(--color-optimize)]',
  SKIPPED_COOLDOWN: 'text-text-tertiary',
  SKIPPED_NO_SAMPLES: 'text-text-tertiary',
};

export interface DecisionRowProps {
  decision: Decision;
  /** `list` — full-page table row; `node` — compact ReactFlow preview;
      `card` — collapsible rail row. */
  variant: 'list' | 'node' | 'card';
  /** Row position. Drives the initial expanded state on `list`/`card`
      (the newest decision starts open) — irrelevant to `node`, which never
      expands. */
  index?: number;
}

export function DecisionRow({ decision, variant, index = 0 }: DecisionRowProps): React.ReactElement {
  if (variant === 'node') return <NodeDecisionRow decision={decision} />;
  if (variant === 'card') return <CardDecisionRow decision={decision} index={index} />;
  return <ListDecisionRow decision={decision} index={index} />;
}

// ── list — CanaryDeploymentsView's full-page table ─────────────────────────

function DeltaCell({ delta }: { delta: number | undefined }): React.ReactElement {
  if (delta === undefined) return <MetaLine size="xs" items={['—']} />;
  const cls =
    delta > 0.005 ? 'text-success' :
    delta < -0.005 ? 'text-danger' :
    'text-text-secondary';
  return (
    <EntityCell label={`${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`} labelClassName={`tabular-nums ${cls}`} />
  );
}

function ListDecisionRow({ decision, index }: { decision: Decision; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(index === 0 && !!decision.reason);
  const hasReason = !!decision.reason;

  const trafficClass =
    decision.to > decision.from ? 'text-success' :
    decision.to < decision.from ? 'text-danger' :
    'text-text-secondary';

  return (
    <>
      <TableRow aria-expanded={hasReason ? expanded : undefined}>
        <TableTd><MetaLine size="xs" className="tabular-nums" items={[absoluteTime(decision.ts)]} /></TableTd>
        <TableTd><Chip size="xs" tone={ACTION_TONE[decision.action]}>{ACTION_LABEL[decision.action]}</Chip></TableTd>
        <TableTd>
          <Inline gap="xs" align="center" className="tabular-nums">
            <MetaLine size="sm" tone="secondary" items={[`${decision.from}%`]} />
            <MetaLine size="xs" items={['→']} />
            <EntityCell label={`${decision.to}%`} labelClassName={trafficClass} />
          </Inline>
        </TableTd>
        <TableTd align="center"><DeltaCell delta={decision.deltaScore} /></TableTd>
        <TableTd className="max-w-0">
          {hasReason
            ? <MetaLine size="xs" className="truncate italic" items={[decision.reason]} />
            : <MetaLine size="xs" items={['—']} />}
        </TableTd>
        <TableTd align="center" className="w-7">
          {hasReason && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={expanded}
              aria-label={expanded ? 'Collapse reason' : 'Expand reason'}
              onClick={() => setExpanded(v => !v)}
            >
              <span aria-hidden="true">{expanded ? '▲' : '▼'}</span>
            </Button>
          )}
        </TableTd>
      </TableRow>
      {expanded && hasReason && (
        <TableRow>
          <TableTd colSpan={6}>
            <MetaLine size="sm" tone="secondary" className="italic leading-relaxed" items={[decision.reason]} />
          </TableTd>
        </TableRow>
      )}
    </>
  );
}

// ── node — ControllerNode's compact ReactFlow preview ───────────────────────

function NodeDecisionRow({ decision: d }: { decision: Decision }): React.ReactElement {
  const arrow = d.from === d.to ? `${d.from}%` : `${d.from}%→${d.to}%`;
  const deltaClass =
    d.deltaScore === undefined
      ? ''
      : d.deltaScore > 0
        ? 'text-success'
        : d.deltaScore < 0
          ? 'text-danger'
          : 'text-text-tertiary';
  return (
    <Stack gap="none" className="gap-px py-1 border-t border-border">
      <Inline gap="xs" wrap={false} className="text-[10.5px]">
        <Inline as="span" gap="none" className="text-text-tertiary font-mono">
          {absoluteTime(d.ts)}
        </Inline>
        <Inline as="span" gap="none" className={`${ACTION_TEXT_CLASS[d.action]} font-semibold`}>
          {d.action}
        </Inline>
        <Inline as="span" gap="none" className="text-text-secondary font-mono">
          {arrow}
        </Inline>
        {d.deltaScore !== undefined && (
          <Inline as="span" gap="none" className={`${deltaClass} tabular-nums`}>
            Δ{d.deltaScore >= 0 ? '+' : ''}{d.deltaScore.toFixed(3)}
          </Inline>
        )}
      </Inline>
      <Inline
        as="span"
        gap="none"
        title={d.reason}
        className="text-[10px] text-text-tertiary overflow-hidden text-ellipsis whitespace-nowrap"
      >
        {d.reason}
      </Inline>
    </Stack>
  );
}

// ── card — DecisionHistoryPanel's collapsible rail row ──────────────────────

function CardDecisionRow({ decision: d, index }: { decision: Decision; index: number }): React.ReactElement {
  const [expanded, setExpanded] = useState(index === 0); // newest starts expanded
  const delta = d.deltaScore === undefined
    ? ''
    : ` · Δ ${d.deltaScore >= 0 ? '+' : ''}${d.deltaScore.toFixed(2)}`;

  // A library disclosure row (ChoiceRow): title + one summary line, the
  // reason and score detail open beneath. This was a three-line label inside
  // a ghost `Button`, which the one-box-per-size button (2.407.14) clips.
  return (
    <ChoiceRow
      title={`${ACTION_LABEL[d.action] ?? d.action} · ${absoluteTime(d.ts)}`}
      description={`B ${d.from}% → ${d.to}%${delta}`}
      open={expanded}
      onOpenChange={setExpanded}
      data-testid={`decision-row-${index}`}
    >
      <Stack gap="xs" className="w-full">
        <Inline as="span" gap="none" className="text-[11.5px] text-text-secondary italic leading-snug">
          {d.reason}
        </Inline>
        {d.deltaScore !== undefined && (
          <Inline as="span" gap="none" className="text-[10.5px] text-text-tertiary">
            Score delta (composite_b − composite_a):{' '}
            <b className="tabular-nums">{d.deltaScore >= 0 ? '+' : ''}{d.deltaScore.toFixed(4)}</b>
          </Inline>
        )}
      </Stack>
    </ChoiceRow>
  );
}

export default DecisionRow;
