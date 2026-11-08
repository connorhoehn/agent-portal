// Canary ModelNode — decorative pass-through showing the shared model that
// renders both prompt variants. Static metadata only.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip, EntityCell, Inline } from '@connorhoehn/ui-components/shared';
import type { ModelNodeData } from '../types.js';

export type ModelNodeType = Node<ModelNodeData & Record<string, unknown>, 'modelNode'>;

function ModelNodeImpl({ data }: NodeProps<ModelNodeType>) {
  return (
    <Card padding="sm" className="w-[180px] text-xs">
      <Inline gap="sm" justify="between" wrap={false}>
        <EntityCell label="Model" labelClassName="text-xs font-semibold" />
        <Chip tone="neutral" size="xs">{data.name || 'Nova Pro'}</Chip>
      </Inline>

      <Handle type="target" position={Position.Left} id="a" />
      <Handle type="target" position={Position.Right} id="b" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const ModelNode = memo(ModelNodeImpl);
