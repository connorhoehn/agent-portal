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
    <Card padding="sm" className="w-[220px] text-xs">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-semibold text-text-primary">
          Router
        </span>
        <span
          aria-label={isShifting ? 'Weights shifting' : 'Stable'}
          title={isShifting ? 'Weights shifting' : 'Stable'}
          className={`w-2.5 h-2.5 rounded-full ${isShifting ? 'bg-warning' : 'bg-success'}`}
          style={isShifting ? { animation: 'canary-router-pulse 1.4s ease-out infinite' } : undefined}
        />
      </div>

      <div className="flex items-center justify-center">
        <Chip tone="neutral" size="xs">
          {`A: ${data.weightA}%  |  B: ${data.weightB}%`}
        </Chip>
      </div>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="a" style={{ left: '28%' }} />
      <Handle type="source" position={Position.Bottom} id="b" style={{ left: '72%' }} />
    </Card>
  );
}

export const RouterNode = memo(RouterNodeImpl);
