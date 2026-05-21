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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <Chip tone={SIDE_TONE[data.side]} size="xs">{sideLabel}</Chip>
          <span
            style={{
              fontSize: 11,
              fontFamily: 'monospace',
              color: 'var(--color-text-secondary, #475569)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={data.versionLabel}
          >
            {data.versionLabel}
          </span>
        </div>
        {data.rollingScore !== undefined && (
          <span
            style={{
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
              color: 'var(--color-text-primary, #0f172a)',
              fontWeight: 600,
            }}
            title="Rolling score"
          >
            {data.rollingScore.toFixed(2)}
          </span>
        )}
      </div>

      {hasTemplate && (
        <button
          className="nodrag"
          onClick={() => setExpanded((v) => !v)}
          style={{
            fontSize: 11,
            padding: '2px 8px',
            background: 'var(--color-surface-raised, #f8fafc)',
            color: 'var(--color-text-secondary, #475569)',
            border: '1px solid var(--color-border, #e2e8f0)',
            borderRadius: 4,
            cursor: 'pointer',
            marginBottom: expanded ? 6 : 0,
          }}
        >
          {expanded ? 'Hide template' : 'Show template'}
        </button>
      )}

      {expanded && data.templateText && (
        <pre
          className="prompt-template nowheel"
          style={{
            margin: 0,
            padding: 8,
            background: 'var(--color-surface-raised, #f8fafc)',
            border: '1px solid var(--color-border, #e2e8f0)',
            borderRadius: 4,
            fontSize: 10.5,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            color: 'var(--color-text-primary, #0f172a)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          {data.templateText}
        </pre>
      )}

      {data.versionArn && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5, marginTop: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', color: 'var(--color-text-tertiary, #94a3b8)', letterSpacing: '0.04em', flexShrink: 0 }}>
            ARN
          </span>
          <span
            style={{ fontSize: 9, fontFamily: 'monospace', color: 'var(--color-text-secondary, #475569)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}
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
