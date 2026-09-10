// Canary InputNode — top of the flow. Shows the last few requests routed to
// either prompt version and a rolling RPS chip. Read-only; no expansion.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip, EntityCell, Inline, MetaLine, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { InputNodeData } from '../types.js';

// React Flow's Node<T> requires T to satisfy Record<string, unknown>; plain
// interfaces don't by default, so we widen with an explicit intersection.
export type InputNodeType = Node<InputNodeData & Record<string, unknown>, 'inputNode'>;

function truncate(text: string, n: number): string {
  if (text.length <= n) return text;
  return text.slice(0, n - 1) + '…';
}

function InputNodeImpl({ data }: NodeProps<InputNodeType>) {
  const recent = data.recentRequests.slice(-5).reverse();
  return (
    <Card padding="sm" className="w-[260px] text-xs">
      <Inline gap="sm" justify="between" wrap={false} className="mb-2">
        <EntityCell label="Input" labelClassName="text-xs font-semibold" />
        <Chip tone="neutral" size="xs">
          {`${Math.round(data.rps * 60)} req/min`}
        </Chip>
      </Inline>

      <Stack gap="xs">
        {recent.length === 0 ? (
          <MetaLine size="xs" items={['Waiting for traffic…']} className="italic" />
        ) : (
          // `title` carries the untruncated request; Inline forwards it because
          // StackProps extends HTMLAttributes.
          recent.map((r) => (
            <Inline
              key={r.id}
              as="span"
              gap="none"
              title={r.text}
              className="text-[11px] text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis font-mono"
            >
              {truncate(r.text, 60)}
            </Inline>
          ))
        )}
      </Stack>

      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const InputNode = memo(InputNodeImpl);
