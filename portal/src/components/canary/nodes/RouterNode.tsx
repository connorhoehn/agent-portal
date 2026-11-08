// Canary RouterNode — splits traffic between version A and B based on the
// controller's weights. Pulses when status is 'shifting'.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip, EntityCell, Inline, StatusDot } from '@connorhoehn/ui-components/shared';
import type { RouterNodeData } from '../types.js';

export type RouterNodeType = Node<RouterNodeData & Record<string, unknown>, 'routerNode'>;

// The pulse used to be a hand-rolled 2.5px span plus a module-level
// `document.head.appendChild(<style>)` injecting @keyframes on import.
// `StatusDot` has `pulse` built in, so the injection is gone — one fewer
// global side effect from importing a node component, and the dot now matches
// every other status dot in the app instead of being its own animation.
function RouterNodeImpl({ data }: NodeProps<RouterNodeType>) {
  const isShifting = data.status === 'shifting';
  const state = isShifting ? 'Weights shifting' : 'Stable';
  return (
    <Card padding="sm" className="w-[220px] text-xs">
      <Inline gap="sm" justify="between" wrap={false} className="mb-1.5">
        <EntityCell label="Router" labelClassName="text-xs font-semibold" />
        <StatusDot
          pulse={isShifting}
          color={isShifting ? 'var(--color-warning)' : 'var(--color-success)'}
          title={state}
          aria-label={state}
        />
      </Inline>

      <Inline gap="none" justify="center">
        <Chip tone="neutral" size="xs">
          {`A: ${data.weightA}%  |  B: ${data.weightB}%`}
        </Chip>
      </Inline>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="a" className="!left-[28%]" />
      <Handle type="source" position={Position.Bottom} id="b" className="!left-[72%]" />
    </Card>
  );
}

export const RouterNode = memo(RouterNodeImpl);
