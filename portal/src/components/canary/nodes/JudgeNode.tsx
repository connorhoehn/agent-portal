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
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 64,
          fontSize: 10,
          color: 'var(--color-text-tertiary, #94a3b8)',
          flexShrink: 0,
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 6,
          background: 'rgba(0,0,0,.08)',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            background: color,
            transition: 'width 0.4s ease',
          }}
        />
      </div>
      <span
        style={{
          width: 26,
          fontSize: 10,
          fontVariantNumeric: 'tabular-nums',
          color: 'var(--color-text-secondary, #475569)',
          textAlign: 'right',
        }}
      >
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
      style={{ width: 240, fontSize: 12, cursor: 'pointer' }}
      onClick={handleClick}
      title="Open Evaluations — configure judge + view scores"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Chip tone="info" size="xs">LLM-as-judge</Chip>
          <span
            style={{
              fontSize: 10.5,
              fontFamily: 'monospace',
              color: 'var(--color-text-tertiary, #94a3b8)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={data.judgeVersion}
          >
            {data.judgeVersion}
          </span>
        </div>
        <span style={{ fontSize: 10, color: 'var(--color-text-tertiary, #94a3b8)' }}>
          {formatRelative(data.lastJudgedAt, now)}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
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
