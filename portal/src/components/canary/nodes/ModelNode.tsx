// Canary ModelNode — decorative pass-through showing the shared model that
// renders both prompt variants. Static metadata only.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import type { ModelNodeData } from '../types.js';

export type ModelNodeType = Node<ModelNodeData & Record<string, unknown>, 'modelNode'>;

function ModelNodeImpl({ data }: NodeProps<ModelNodeType>) {
  return (
    <Card padding="sm" style={{ width: 180, fontSize: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #0f172a)' }}>
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
