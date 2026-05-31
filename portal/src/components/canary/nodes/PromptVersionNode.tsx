// Canary PromptVersionNode — represents one prompt template variant (A or B).
// Body is collapsible; expanded view shows the raw template in a <pre> block.

import { memo, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import type { PromptVersionNodeData } from '../types.js';

export type PromptVersionNodeType = Node<
  PromptVersionNodeData & Record<string, unknown>,
  'promptVersion'
>;

const SIDE_TONE: Record<'A' | 'B', 'info' | 'warning'> = {
  A: 'info',
  B: 'warning',
};

function PromptVersionNodeImpl({ data }: NodeProps<PromptVersionNodeType>) {
  const [expanded, setExpanded] = useState(false);
  const sideLabel = `Version ${data.side}`;
  const hasTemplate = !!data.templateText;

  return (
    <Card padding="sm" className="w-[280px] text-xs">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Chip tone={SIDE_TONE[data.side]} size="xs">{sideLabel}</Chip>
          <span
            className="text-[11px] font-mono text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap"
            title={data.versionLabel}
          >
            {data.versionLabel}
          </span>
        </div>
        {data.rollingScore !== undefined && (
          <span
            className="text-[11px] tabular-nums text-text-primary font-semibold"
            title="Rolling score"
          >
            {data.rollingScore.toFixed(2)}
          </span>
        )}
      </div>

      {hasTemplate && (
        <button
          className={`nodrag text-[11px] px-2 py-0.5 bg-[var(--color-surface-raised)] text-text-secondary border border-border rounded cursor-pointer ${expanded ? 'mb-1.5' : 'mb-0'}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Hide template' : 'Show template'}
        </button>
      )}

      {expanded && data.templateText && (
        <pre className="prompt-template nowheel m-0 p-2 bg-[var(--color-surface-raised)] border border-border rounded text-[10.5px] font-mono text-text-primary whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
          {data.templateText}
        </pre>
      )}

      {data.versionArn && (
        <div className="flex items-baseline gap-[5px] mt-1.5">
          <span className="text-[9px] font-semibold uppercase text-text-tertiary tracking-[0.04em] flex-shrink-0">
            ARN
          </span>
          <span
            className="text-[9px] font-mono text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap min-w-0"
            title={data.versionArn}
          >
            {data.versionArn.length > 35 ? `…${data.versionArn.slice(-35)}` : data.versionArn}
          </span>
        </div>
      )}

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const PromptVersionNode = memo(PromptVersionNodeImpl);
