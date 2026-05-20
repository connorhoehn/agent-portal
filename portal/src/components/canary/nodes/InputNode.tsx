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
    <Card padding="sm" style={{ width: 260, fontSize: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #0f172a)' }}>
          Input
        </span>
        <Chip tone="neutral" size="xs">
          {`${Math.round(data.rps * 60)} req/min`}
        </Chip>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {recent.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)', fontStyle: 'italic' }}>
            Waiting for traffic…
          </div>
        ) : (
          recent.map((r) => (
            <div
              key={r.id}
              title={r.text}
              style={{
                fontSize: 11,
                color: 'var(--color-text-secondary, #475569)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                fontFamily: 'monospace',
              }}
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
