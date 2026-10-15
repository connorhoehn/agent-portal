// Canary ScorePanelNode — terminal node per side. Shows the rolling mean
// judge score and a tiny sparkline of recent samples. Mirrors the recharts
// pattern in components/scores/TrendLine.tsx.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { ResponsiveContainer, LineChart, Line } from 'recharts';
import { Card, Chip, EntityCell, Inline, MetaLine } from '@connorhoehnslalom/ui-components/shared';
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
    <Card padding="sm" className="w-[200px] text-xs">
      <Inline gap="sm" justify="between" wrap={false} className="mb-1.5">
        <EntityCell label={`Score (${data.side})`} labelClassName="text-xs font-semibold" />
        <Chip tone={SIDE_TONE[data.side]} size="xs">{data.side}</Chip>
      </Inline>

      {/* `color` is a runtime value from SIDE_COLOR, so it stays a style —
          Tailwind cannot build a class from it. */}
      <Inline
        as="span"
        gap="none"
        className="text-sm font-bold tabular-nums leading-tight mb-1"
        style={{ color }}
      >
        {data.rollingMean.toFixed(3)}
      </Inline>

      <Inline gap="none" className="w-[140px] h-10">
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
          <MetaLine size="xs" items={['no samples yet']} className="italic" />
        )}
      </Inline>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const ScorePanelNode = memo(ScorePanelNodeImpl);
