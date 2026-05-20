// Canary ScorePanelNode — terminal node per side. Shows the rolling mean
// judge score and a tiny sparkline of recent samples. Mirrors the recharts
// pattern in components/scores/TrendLine.tsx.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import type { ScorePanelNodeData } from '../types.js';

export type ScorePanelNodeType = Node<
  ScorePanelNodeData & Record<string, unknown>,
  'scorePanel'
>;

const SIDE_TONE: Record<'A' | 'B', 'info' | 'warning'> = {
  A: 'info',
  B: 'warning',
};

// Match the prompt-version chip palette so a glance ties the score back to
// its variant.
const SIDE_COLOR: Record<'A' | 'B', string> = {
  A: '#6366f1',
  B: '#f59e0b',
};

function ScorePanelNodeImpl({ data }: NodeProps<ScorePanelNodeType>) {
  const color = SIDE_COLOR[data.side];
  const hasData = data.sparkline.length > 0;
  return (
    <Card padding="sm" style={{ width: 200, fontSize: 12 }}>
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
          {`Score (${data.side})`}
        </span>
        <Chip tone={SIDE_TONE[data.side]} size="xs">{data.side}</Chip>
      </div>

      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
          color,
          lineHeight: 1.1,
          marginBottom: 4,
        }}
      >
        {data.rollingMean.toFixed(3)}
      </div>

      <div style={{ width: 140, height: 40 }}>
        {hasData ? (
          <ResponsiveContainer width="100%" height={40}>
            <LineChart data={data.sparkline} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
              <Line
                type="monotone"
                dataKey="v"
                stroke={color}
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <div style={{ fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)', fontStyle: 'italic' }}>
            no samples yet
          </div>
        )}
      </div>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const ScorePanelNode = memo(ScorePanelNodeImpl);
