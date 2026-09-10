// Canary PromptVersionNode — represents one prompt template variant (A or B).
// Body is collapsible; expanded view shows the raw template in a code block.

import { memo, useState } from 'react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import {
  Button, Card, Chip, CodeBlock, Inline, SectionLabel,
} from '@connorhoehnslalom/ui-components/shared';
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
      <Inline gap="sm" justify="between" wrap={false} className="mb-1.5">
        <Inline gap="xs" wrap={false} className="min-w-0">
          <Chip tone={SIDE_TONE[data.side]} size="xs">{sideLabel}</Chip>
          <Inline
            as="span"
            gap="none"
            title={data.versionLabel}
            className="text-[11px] font-mono text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap"
          >
            {data.versionLabel}
          </Inline>
        </Inline>
        {data.rollingScore !== undefined && (
          <Inline
            as="span"
            gap="none"
            title="Rolling score"
            className="text-[11px] tabular-nums text-text-primary font-semibold"
          >
            {data.rollingScore.toFixed(2)}
          </Inline>
        )}
      </Inline>

      {hasTemplate && (
        // `nodrag` is React Flow's opt-out: without it, pressing the button
        // starts a canvas pan instead of toggling. It has to survive the swap
        // to Button, which is why it is in className rather than dropped.
        <Button
          variant="secondary"
          size="sm"
          className={`nodrag ${expanded ? 'mb-1.5' : 'mb-0'}`}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Hide template' : 'Show template'}
        </Button>
      )}

      {expanded && data.templateText && (
        // `nowheel` lets the block scroll instead of zooming the canvas.
        <CodeBlock
          className="prompt-template nowheel text-[10.5px] whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto"
          code={data.templateText}
        />
      )}

      {data.versionArn && (
        <Inline gap="none" align="baseline" wrap={false} className="gap-[5px] mt-1.5">
          <SectionLabel className="text-[9px] shrink-0">ARN</SectionLabel>
          <Inline
            as="span"
            gap="none"
            title={data.versionArn}
            className="text-[9px] font-mono text-text-secondary overflow-hidden text-ellipsis whitespace-nowrap min-w-0"
          >
            {data.versionArn.length > 35 ? `…${data.versionArn.slice(-35)}` : data.versionArn}
          </Inline>
        </Inline>
      )}

      <Handle type="target" position={Position.Top} id="in" />
      <Handle type="source" position={Position.Bottom} id="out" />
    </Card>
  );
}

export const PromptVersionNode = memo(PromptVersionNodeImpl);
