// Canary ModelNode — decorative pass-through showing the shared model that
// renders both prompt variants. Static metadata only.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import type { ModelNodeData } from '../types.js';

export type ModelNodeType = Node<ModelNodeData & Record<string, unknown>, 'modelNode'>;

function ModelNodeImpl({ data }: NodeProps<ModelNodeType>) {
  return (
    <Card padding="sm" className="w-[180px] text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-text-primary">
          Model
        </span>
        <Chip tone="neutral" size="xs">{data.name || 'Nova Pro'}</Chip>
      </div>

      <Handle type="target" position={Position.Left} id="a" />
      <Handle type="target" position={Position.Right} id="b" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const ModelNode = memo(ModelNodeImpl);
