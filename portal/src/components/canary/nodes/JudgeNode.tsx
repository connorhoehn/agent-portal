// Canary JudgeNode — the LLM-as-judge scoring each variant's outputs across
// four axes. Each axis renders as a mini horizontal bar (0–100 scale).

import { memo, useEffect, useState, useCallback } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useNavigate } from 'react-router';
import { Card, Chip, Inline, ProgressBar, Stack } from '@connorhoehnslalom/ui-components/shared';
import type { JudgeNodeData } from '../types.js';

export type JudgeNodeType = Node<JudgeNodeData & Record<string, unknown>, 'judgeNode'>;

interface BarProps {
  label: string;
  value: number; // 0–100
  color: string;
}

/**
 * One scoring axis.
 *
 * The track is `ProgressBar` with no `label`, which renders the bar alone —
 * and unlike the hand-rolled pair of divs it came from, it carries
 * `role="progressbar"` with `aria-valuenow`/`min`/`max`, so a screen reader
 * gets the number instead of two anonymous boxes. The surrounding label and
 * readout stay here because ProgressBar's own `label` slot puts them above the
 * track, not on either side of it.
 */
function Bar({ label, value, color }: BarProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <Inline gap="xs" wrap={false}>
      <Inline as="span" gap="none" className="w-16 text-[10px] text-text-tertiary shrink-0">
        {label}
      </Inline>
      <ProgressBar value={pct} size="sm" color={color} aria-label={label} className="flex-1" />
      <Inline
        as="span"
        gap="none"
        justify="end"
        className="w-[26px] text-[10px] tabular-nums text-text-secondary"
      >
        {Math.round(pct)}
      </Inline>
    </Inline>
  );
}

function formatRelative(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diff = Math.max(0, Math.floor((now - t) / 1000));
  if (diff < 1) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

function JudgeNodeImpl({ data }: NodeProps<JudgeNodeType>) {
  // Ticking 'now' so "Xs ago" stays fresh without re-rendering every event.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const navigate = useNavigate();
  const handleClick = useCallback(() => {
    navigate('/iq/evaluations');
  }, [navigate]);

  const s = data.lastScores;
  return (
    <Card
      padding="sm"
      className="w-[240px] text-xs cursor-pointer"
      onClick={handleClick}
      title="Open Evaluations — configure judge + view scores"
    >
      <Inline gap="sm" justify="between" wrap={false} className="mb-2">
        <Inline gap="xs" wrap={false} className="min-w-0">
          <Chip tone="info" size="xs">LLM-as-judge</Chip>
          <Inline
            as="span"
            gap="none"
            title={data.judgeVersion}
            className="text-[10.5px] font-mono text-text-tertiary overflow-hidden text-ellipsis whitespace-nowrap"
          >
            {data.judgeVersion}
          </Inline>
        </Inline>
        <Inline as="span" gap="none" className="text-[10px] text-text-tertiary">
          {formatRelative(data.lastJudgedAt, now)}
        </Inline>
      </Inline>

      <Stack gap="xs">
        <Bar label="helpfulness" value={(s?.helpfulness ?? 0) * 100} color="#6366f1" />
        <Bar label="factuality"  value={(s?.factuality  ?? 0) * 100} color="#16a34a" />
        <Bar label="tone"        value={(s?.tone        ?? 0) * 100} color="#0891b2" />
        <Bar label="conciseness" value={(s?.conciseness ?? 0) * 100} color="#f59e0b" />
      </Stack>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const JudgeNode = memo(JudgeNodeImpl);
