// Canary ControllerNode — Step Functions state machine that consumes A/B
// scores and decides PROMOTE / ROLLBACK / HOLD. The visual feedback edge back
// to the Router closes the loop in the diagram.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Card, Chip, EntityCell, Inline, InlineAlert, MetaLine, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import type {
  ControllerNodeData,
  ControllerAction,
  Decision,
} from '../types.js';

export type ControllerNodeType = Node<
  ControllerNodeData & Record<string, unknown>,
  'controllerNode'
>;

const STATE_TONE: Record<
  ControllerNodeData['state'],
  'neutral' | 'info' | 'success' | 'danger'
> = {
  idle: 'neutral',
  evaluating: 'info',
  promoting: 'success',
  halted: 'danger',
  promoted: 'success',
  rolled_back: 'danger',
};

const STATE_LABEL: Record<ControllerNodeData['state'], string> = {
  idle: 'idle',
  evaluating: 'evaluating',
  promoting: 'promoting',
  halted: 'halted',
  promoted: '✓ promoted',
  rolled_back: '✕ rolled back',
};

// Six actions onto six colours, and there is no Chip tone for
// SKIPPED_OVERRIDE's `--color-optimize`, so this stays a class map applied to
// a library element rather than becoming a tone.
const ACTION_COLOR_CLASS: Record<ControllerAction, string> = {
  PROMOTE: 'text-success',
  ROLLBACK: 'text-danger',
  HOLD: 'text-text-secondary',
  SKIPPED_OVERRIDE: 'text-[var(--color-optimize)]',
  SKIPPED_COOLDOWN: 'text-text-tertiary',
  SKIPPED_NO_SAMPLES: 'text-text-tertiary',
};

function formatTs(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 8);
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function DecisionRow({ d }: { d: Decision }) {
  const arrow =
    d.from === d.to
      ? `${d.from}%`
      : `${d.from}%→${d.to}%`;
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
          {formatTs(d.ts)}
        </Inline>
        <Inline as="span" gap="none" className={`${ACTION_COLOR_CLASS[d.action]} font-semibold`}>
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

function ControllerNodeImpl({ data }: NodeProps<ControllerNodeType>) {
  const recent = data.lastDecisions.slice(0, 3);
  return (
    <Card padding="sm" className="w-[280px] text-xs">
      <Inline gap="sm" justify="between" wrap={false} className="mb-1.5">
        <EntityCell label="Controller" labelClassName="text-xs font-semibold" />
        <Chip tone={STATE_TONE[data.state]} size="xs">{STATE_LABEL[data.state]}</Chip>
      </Inline>

      {data.executionArn && (
        <Inline
          as="span"
          gap="none"
          title={data.executionArn}
          className="text-[10px] font-mono text-text-tertiary overflow-hidden text-ellipsis whitespace-nowrap mb-1"
        >
          {data.executionArn}
        </Inline>
      )}

      {/* These were hand-tinted boxes carrying their own bg/border/text triple.
          InlineAlert already owns that vocabulary, and a terminal experiment
          outcome is exactly the thing an alert is for. */}
      {data.state === 'promoted' && (
        <InlineAlert tone="success" className="mb-1.5">
          Version B is now serving 100% of traffic. The experiment is complete — B has been fully promoted.
        </InlineAlert>
      )}
      {data.state === 'rolled_back' && (
        <InlineAlert tone="error" className="mb-1.5">
          Rolled back to 100% A. B underperformed and has been fully removed from traffic.
        </InlineAlert>
      )}

      <Stack gap="none">
        {recent.length === 0 ? (
          <MetaLine
            size="xs"
            className="pt-1 leading-normal"
            items={[
              <>
                Watches A/B judge scores and fires PROMOTE / ROLLBACK / HOLD once enough samples
                arrive. Run <Inline as="span" gap="none" className="text-text-secondary font-semibold">Scenarios</Inline> to generate traffic.
              </>,
            ]}
          />
        ) : (
          recent.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} d={d} />)
        )}
      </Stack>

      <Handle type="target" position={Position.Top} id="in" />
      {/* feedback handle is invisible — it exists only as an edge anchor for the
          ReactFlow feedback loop edge back to the Router. Do not render a visible dot. */}
      <Handle
        type="source"
        position={Position.Left}
        id="feedback"
        style={{ opacity: 0, width: 4, height: 4, minWidth: 0, minHeight: 0 }}
      />
    </Card>
  );
}

export const ControllerNode = memo(ControllerNodeImpl);
