// Canary InputNode — top of the flow. Shows the last few requests routed to
// either prompt version and a rolling RPS chip. Read-only; no expansion.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
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
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-xs font-semibold text-text-primary">
          Input
        </span>
        <Chip tone="neutral" size="xs">
          {`${Math.round(data.rps * 60)} req/min`}
        </Chip>
      </div>

      <div className="flex flex-col gap-1">
        {recent.length === 0 ? (
          <div className="text-[11px] text-text-tertiary italic">
            Waiting for traffic…
          </div>
        ) : (
          recent.map((r) => (
            <div
              key={r.id}
              title={r.text}
              className="text-[11px] text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis font-mono"
            >
              {truncate(r.text, 60)}
            </div>
          ))
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const InputNode = memo(InputNodeImpl);
