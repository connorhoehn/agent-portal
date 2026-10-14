// Canary ControllerNode — Step Functions state machine that consumes A/B
// scores and decides PROMOTE / ROLLBACK / HOLD. The visual feedback edge back
// to the Router closes the loop in the diagram.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Card, Chip, EntityCell, Inline, InlineAlert, MetaLine, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import { DecisionRow } from '../DecisionRow.js';
import type {
  ControllerNodeData,
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

function ControllerNodeImpl({ data }: NodeProps<ControllerNodeType>) {
  const recent = data.lastDecisions.slice(0, 3);
  return (
    <Card padding="sm" className="w-[280px] text-xs">
      <Inline gap="sm" justify="between" wrap={false} className="mb-1.5">
        <EntityCell label="Controller" labelClassName="text-xs font-semibold" />
        <Chip tone={STATE_TONE[data.state]} size="xs">{STATE_LABEL[data.state]}</Chip>
      </Inline>

      {data.executionArn && (
        <T size="xs" tone="tertiary" className="font-mono overflow-hidden text-ellipsis whitespace-nowrap mb-1" title={data.executionArn}>
          {data.executionArn}
        </T>
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
          recent.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} decision={d} variant="node" />)
        )}
      </Stack>

      <Handle type="target" position={Position.Top} id="in" />
      {/* feedback handle is invisible — it exists only as an edge anchor for the
          ReactFlow feedback loop edge back to the Router. Do not render a visible dot. */}
      <Handle
        type="source"
        position={Position.Left}
        id="feedback"
        className="opacity-0 !w-1 !h-1 !min-w-0 !min-h-0"
      />
    </Card>
  );
}

export const ControllerNode = memo(ControllerNodeImpl);
