// Canary RouterNode — splits traffic between version A and B based on the
// controller's weights. Pulses when status is 'shifting'.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import type { RouterNodeData } from '../types.js';

export type RouterNodeType = Node<RouterNodeData & Record<string, unknown>, 'routerNode'>;

// Keyframes injected once per module load. Cheaper than a CSS-in-JS dep and
// avoids touching global stylesheets.
const STYLE_ID = 'canary-router-pulse-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
@keyframes canary-router-pulse {
  0%   { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.55); }
  70%  { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); }
  100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0); }
}`;
  document.head.appendChild(el);
}

function RouterNodeImpl({ data }: NodeProps<RouterNodeType>) {
  const isShifting = data.status === 'shifting';
  return (
    <Card padding="sm" style={{ width: 220, fontSize: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary, #0f172a)' }}>
          Router
        </span>
        <span
          aria-label={isShifting ? 'Weights shifting' : 'Stable'}
          title={isShifting ? 'Weights shifting' : 'Stable'}
          style={{
            width: 10,
            height: 10,
            borderRadius: '50%',
            background: isShifting ? '#f59e0b' : '#16a34a',
            animation: isShifting ? 'canary-router-pulse 1.4s ease-out infinite' : undefined,
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Chip tone="neutral" size="xs">
          {`A: ${data.weightA}%  |  B: ${data.weightB}%`}
        </Chip>
      </div>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Left} id="a" />
      <Handle type="source" position={Position.Right} id="b" />
    </Card>
  );
}

export const RouterNode = memo(RouterNodeImpl);
