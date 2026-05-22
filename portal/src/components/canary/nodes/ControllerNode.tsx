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
  promoted: 'success',
  rolled_back: 'danger',
};

const STATE_LABEL: Record<ControllerNodeData['state'], string> = {
  idle: 'idle',
  evaluating: 'evaluating',
  promoting: 'promoting',
  halted: 'halted',
  promoted: '✓ promoted',
  rolled_back: '✕ rolled back',
};

const ACTION_COLOR: Record<ControllerAction, string> = {
  PROMOTE: '#16a34a',
  ROLLBACK: '#dc2626',
  HOLD: '#64748b',
  SKIPPED_OVERRIDE: 'var(--color-optimize)',
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
        <Chip tone={STATE_TONE[data.state]} size="xs">{STATE_LABEL[data.state]}</Chip>
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

      {data.state === 'promoted' && (
        <div style={{ background: '#dcfce7', border: '1px solid #bbf7d0', borderRadius: 4, padding: '6px 8px', marginBottom: 6, fontSize: 11, color: '#166534', lineHeight: 1.4 }}>
          Version B is now serving 100% of traffic. The experiment is complete — B has been fully promoted.
        </div>
      )}
      {data.state === 'rolled_back' && (
        <div style={{ background: '#fee2e2', border: '1px solid #fecaca', borderRadius: 4, padding: '6px 8px', marginBottom: 6, fontSize: 11, color: '#991b1b', lineHeight: 1.4 }}>
          Rolled back to 100% A. B underperformed and has been fully removed from traffic.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {recent.length === 0 ? (
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary, #94a3b8)', paddingTop: 4, lineHeight: 1.5 }}>
            Watches A/B judge scores and fires PROMOTE / ROLLBACK / HOLD once enough samples arrive.
            Run <b style={{ color: 'var(--color-text-secondary, #475569)' }}>Scenarios</b> to generate traffic.
          </div>
        ) : (
          recent.map((d, i) => <DecisionRow key={`${d.ts}-${i}`} d={d} />)
        )}
      </div>

      <Handle type="target" position={Position.Top} id="in" />
      {/* feedback handle is invisible — it exists only as an edge anchor for the
          ReactFlow feedback loop edge back to the Router. Do not render a visible dot. */}
      <Handle
        type="source"
        position={Position.Left}
        id="feedback"
        style={{ opacity: 0, width: 4, height: 4, minWidth: 0, minHeight: 0 }}
      />
    </Card>
  );
}

export const ControllerNode = memo(ControllerNodeImpl);
