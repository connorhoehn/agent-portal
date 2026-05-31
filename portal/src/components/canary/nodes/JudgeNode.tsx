// Canary JudgeNode — the LLM-as-judge scoring each variant's outputs across
// four axes. Each axis renders as a mini horizontal bar (0–100 scale).

import { memo, useEffect, useState, useCallback } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { useNavigate } from 'react-router';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import type { JudgeNodeData } from '../types.js';

export type JudgeNodeType = Node<JudgeNodeData & Record<string, unknown>, 'judgeNode'>;

interface BarProps {
  label: string;
  value: number; // 0–100
  color: string;
}

function Bar({ label, value, color }: BarProps) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="flex items-center gap-1.5">
      <span className="w-16 text-[10px] text-text-tertiary flex-shrink-0">
        {label}
      </span>
      <div className="flex-1 h-1.5 bg-black/10 rounded-[3px] overflow-hidden">
        <div
          className="h-full transition-[width] duration-[400ms] ease"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="w-[26px] text-[10px] tabular-nums text-text-secondary text-right">
        {Math.round(pct)}
      </span>
    </div>
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
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Chip tone="info" size="xs">LLM-as-judge</Chip>
          <span
            className="text-[10.5px] font-mono text-text-tertiary overflow-hidden text-ellipsis whitespace-nowrap"
            title={data.judgeVersion}
          >
            {data.judgeVersion}
          </span>
        </div>
        <span className="text-[10px] text-text-tertiary">
          {formatRelative(data.lastJudgedAt, now)}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <Bar label="helpfulness" value={(s?.helpfulness ?? 0) * 100} color="#6366f1" />
        <Bar label="factuality"  value={(s?.factuality  ?? 0) * 100} color="#16a34a" />
        <Bar label="tone"        value={(s?.tone        ?? 0) * 100} color="#0891b2" />
        <Bar label="conciseness" value={(s?.conciseness ?? 0) * 100} color="#f59e0b" />
      </div>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const JudgeNode = memo(JudgeNodeImpl);
