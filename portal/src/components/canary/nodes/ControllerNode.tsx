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

const ACTION_COLOR_CLASS: Record<ControllerAction, string> = {
  PROMOTE: 'text-success',
  ROLLBACK: 'text-danger',
  HOLD: 'text-text-secondary',
  SKIPPED_OVERRIDE: 'text-[var(--color-optimize)]',
  SKIPPED_COOLDOWN: 'text-text-tertiary',
  SKIPPED_NO_SAMPLES: 'text-text-tertiary',
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
  const deltaClass =
    d.deltaScore === undefined
      ? ''
      : d.deltaScore > 0
        ? 'text-success'
        : d.deltaScore < 0
          ? 'text-danger'
          : 'text-text-tertiary';
  return (
    <div className="flex flex-col gap-px py-1 border-t border-border">
      <div className="flex items-center gap-1.5 text-[10.5px]">
        <span className="text-text-tertiary font-mono">
          {formatTs(d.ts)}
        </span>
        <span className={`${ACTION_COLOR_CLASS[d.action]} font-semibold`}>
          {d.action}
        </span>
        <span className="text-text-secondary font-mono">
          {arrow}
        </span>
        {d.deltaScore !== undefined && (
          <span className={`${deltaClass} tabular-nums`}>
            Δ{d.deltaScore >= 0 ? '+' : ''}{d.deltaScore.toFixed(3)}
          </span>
        )}
      </div>
      <div
        className="text-[10px] text-text-tertiary overflow-hidden text-ellipsis whitespace-nowrap"
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
    <Card padding="sm" className="w-[280px] text-xs">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-semibold text-text-primary">
          Controller
        </span>
        <Chip tone={STATE_TONE[data.state]} size="xs">{STATE_LABEL[data.state]}</Chip>
      </div>

      {data.executionArn && (
        <div
          className="text-[10px] font-mono text-text-tertiary overflow-hidden text-ellipsis whitespace-nowrap mb-1"
          title={data.executionArn}
        >
          {data.executionArn}
        </div>
      )}

      {data.state === 'promoted' && (
        <div className="bg-success-bg border border-[var(--color-success-border)] rounded p-1.5 px-2 mb-1.5 text-[11px] text-success leading-snug">
          Version B is now serving 100% of traffic. The experiment is complete — B has been fully promoted.
        </div>
      )}
      {data.state === 'rolled_back' && (
        <div className="bg-danger-bg border border-[var(--color-danger-border)] rounded p-1.5 px-2 mb-1.5 text-[11px] text-danger leading-snug">
          Rolled back to 100% A. B underperformed and has been fully removed from traffic.
        </div>
      )}

      <div className="flex flex-col">
        {recent.length === 0 ? (
          <div className="text-[11px] text-text-tertiary pt-1 leading-normal">
            Watches A/B judge scores and fires PROMOTE / ROLLBACK / HOLD once enough samples arrive.
            Run <b className="text-text-secondary">Scenarios</b> to generate traffic.
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
