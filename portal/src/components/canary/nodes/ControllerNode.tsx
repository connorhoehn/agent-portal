// Canary ControllerNode — Step Functions state machine that consumes A/B
// scores and decides PROMOTE / ROLLBACK / HOLD. The visual feedback edge back
// to the Router closes the loop in the diagram.

import { memo } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import type {
  ControllerNodeData,
  ControllerAction,
  Decision,
} from '../types.js';

export type ControllerNodeType = Node<
  ControllerNodeData & Record<string, unknown>,
  'controllerNode'
>;

const STATE_TONE: Record<
  ControllerNodeData['state'],
  'neutral' | 'info' | 'success' | 'danger'
> = {
  idle: 'neutral',
  evaluating: 'info',
  promoting: 'success',
  halted: 'danger',
};

const ACTION_COLOR: Record<ControllerAction, string> = {
  PROMOTE: '#16a34a',
  ROLLBACK: '#dc2626',
  HOLD: '#64748b',
  SKIPPED_OVERRIDE: '#7c3aed',
  SKIPPED_COOLDOWN: '#94a3b8',
  SKIPPED_NO_SAMPLES: '#94a3b8',
};

function formatTs(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso.slice(0, 8);
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function DecisionRow({ d }: { d: Decision }) {
  const arrow =
    d.from === d.to
      ? `${d.from}%`
      : `${d.from}%→${d.to}%`;
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        padding: '4px 0',
        borderTop: '1px solid var(--color-border, #e2e8f0)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5 }}>
        <span style={{ color: 'var(--color-text-tertiary, #94a3b8)', fontFamily: 'monospace' }}>
          {formatTs(d.ts)}
        </span>
        <span style={{ color: ACTION_COLOR[d.action], fontWeight: 600 }}>
          {d.action}
        </span>
        <span style={{ color: 'var(--color-text-secondary, #475569)', fontFamily: 'monospace' }}>
          {arrow}
        </span>
        {d.deltaScore !== undefined && (
          <span
            style={{
              color:
                d.deltaScore > 0
                  ? '#16a34a'
                  : d.deltaScore < 0
                  ? '#dc2626'
                  : 'var(--color-text-tertiary, #94a3b8)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Δ{d.deltaScore >= 0 ? '+' : ''}{d.deltaScore.toFixed(3)}
          </span>
        )}
      </div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--color-text-tertiary, #94a3b8)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={d.reason}
      >
        {d.reason}
      </div>
    </div>
  );
}

function ControllerNodeImpl({ data }: NodeProps<ControllerNodeType>) {
  const recent = data.lastDecisions.slice(0, 3);
  return (
    <Card padding="sm" style={{ width: 280, fontSize: 12 }}>
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
          Controller
        </span>
        <Chip tone={STATE_TONE[data.state]} size="xs">{data.state}</Chip>
      </div>

      {data.executionArn && (
        <div
          style={{
            fontSize: 10,
            fontFamily: 'monospace',
            color: 'var(--color-text-tertiary, #94a3b8)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            marginBottom: 4,
          }}
          title={data.executionArn}
        >
          {data.executionArn}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {recent.length === 0 ? (
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-text-tertiary, #94a3b8)',
              fontStyle: 'italic',
              paddingTop: 4,
            }}
          >
            No decisions yet
          </div>
        ) : (
          recent.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} d={d} />)
        )}
      </div>

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Left} id="feedback" />
    </Card>
  );
}

export const ControllerNode = memo(ControllerNodeImpl);
