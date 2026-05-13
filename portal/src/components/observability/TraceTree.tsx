// TraceTree — recursive renderer for parent/current/child invocation chains.
//
// Renders an indented hierarchy with Unicode box-drawing connectors. Each row
// shows: status dot, agent name, judge score chip, duration, cost, and a "view"
// affordance. Clicking a row navigates to that invocation's detail page.
// The row matching `currentInvocationId` is visually highlighted so the user
// always knows where they are in the chain.

import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router';
import { Chip } from '@connorhoehnslalom/ui-components/shared';
import { CostChip } from './CostChip';

export interface TraceNode {
  invocationId: string;
  agentId: string;
  agentName?: string;
  judgeScore?: number | null;
  durationMs?: number | null;
  totalCostUsd?: number | null;
  ts?: string;
  children?: TraceNode[];
}

interface Props {
  /** Optional parent of the current invocation (rendered above). */
  parent?: TraceNode | null;
  /** Current invocation (will be highlighted). */
  current: TraceNode;
  /** Optional direct children of the current invocation. */
  children?: TraceNode[];
  /** Used to highlight the active row — typically === current.invocationId. */
  currentInvocationId: string;
}

type Tone = 'success' | 'warning' | 'danger' | 'neutral';

const judgeTone = (v: number | null | undefined): Tone =>
  v == null ? 'neutral' : v >= 0.75 ? 'success' : v >= 0.55 ? 'warning' : 'danger';

const fmt = (v: number | null | undefined, digits = 2): string =>
  v != null && Number.isFinite(v) ? Number(v).toFixed(digits) : '—';

const fmtDur = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
};

export function TraceTree({ parent, current, children, currentInvocationId }: Props) {
  const navigate = useNavigate();
  const kids = children ?? current.children ?? [];

  return (
    <div style={treeBox}>
      {parent && (
        <Row
          node={parent}
          depth={0}
          isLastSibling={false}
          ancestorIsLast={[]}
          isParent
          isCurrent={parent.invocationId === currentInvocationId}
          onNavigate={(id) => navigate(`/observability/invocations/${id}`)}
        />
      )}
      <Row
        node={current}
        depth={parent ? 1 : 0}
        isLastSibling={kids.length === 0}
        ancestorIsLast={parent ? [true] : []}
        isCurrent={true}
        onNavigate={(id) => navigate(`/observability/invocations/${id}`)}
      />
      {kids.map((c, i) => (
        <SubTree
          key={c.invocationId}
          node={c}
          depth={parent ? 2 : 1}
          isLastSibling={i === kids.length - 1}
          ancestorIsLast={parent ? [true, kids.length === 0] : [kids.length === 0]}
          currentInvocationId={currentInvocationId}
          onNavigate={(id) => navigate(`/observability/invocations/${id}`)}
        />
      ))}
    </div>
  );
}

function SubTree({
  node,
  depth,
  isLastSibling,
  ancestorIsLast,
  currentInvocationId,
  onNavigate,
}: {
  node: TraceNode;
  depth: number;
  isLastSibling: boolean;
  ancestorIsLast: boolean[];
  currentInvocationId: string;
  onNavigate: (id: string) => void;
}) {
  const kids = node.children ?? [];
  return (
    <>
      <Row
        node={node}
        depth={depth}
        isLastSibling={isLastSibling}
        ancestorIsLast={ancestorIsLast}
        isCurrent={node.invocationId === currentInvocationId}
        onNavigate={onNavigate}
      />
      {kids.map((c, i) => (
        <SubTree
          key={c.invocationId}
          node={c}
          depth={depth + 1}
          isLastSibling={i === kids.length - 1}
          ancestorIsLast={[...ancestorIsLast, isLastSibling]}
          currentInvocationId={currentInvocationId}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}

function Row({
  node,
  depth,
  isLastSibling,
  ancestorIsLast,
  isParent,
  isCurrent,
  onNavigate,
}: {
  node: TraceNode;
  depth: number;
  isLastSibling: boolean;
  ancestorIsLast: boolean[];
  isParent?: boolean;
  isCurrent: boolean;
  onNavigate: (id: string) => void;
}) {
  // Build the connector prefix using box-drawing chars. Each ancestor level
  // contributes either a vertical bar │ (more siblings below) or a space
  // (last sibling — line ends here). The current level uses ├ (more) or └ (last).
  let connector = '';
  for (let i = 1; i < depth; i++) {
    connector += ancestorIsLast[i - 1] ? '   ' : '│  ';
  }
  if (depth > 0) {
    connector += isLastSibling ? '└─ ' : '├─ ';
  }

  const name = node.agentName ?? node.agentId;
  // "Ghost" node: the parent record has not yet been ingested. The middleware
  // returns a placeholder `agent_id: '(record not found)'` so the chain still
  // renders. Style it distinctly (dashed border, muted text, info chip) so
  // researchers know it's not a real row yet.
  const isGhost =
    node.agentId === '(record not found)' || node.agentId === '(lookup failed)';

  const rowStyle: CSSProperties = isGhost
    ? {
        ...row,
        borderStyle: 'dashed',
        borderColor: 'var(--color-border)',
        background: 'var(--color-bg)',
        opacity: 0.78,
      }
    : {
        ...row,
        background: isCurrent ? 'var(--color-surface-hover)' : undefined,
        borderColor: isCurrent ? 'var(--color-primary, #6366f1)' : 'transparent',
      };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => !isGhost && onNavigate(node.invocationId)}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !isGhost) onNavigate(node.invocationId);
      }}
      style={rowStyle}
      title={
        isGhost
          ? 'Referenced parent has not been ingested yet. Likely the CW Logs poller has not caught its trace or the agent did not emit one.'
          : isParent
            ? 'Parent invocation — click to open'
            : 'Click to open'
      }
    >
      <span style={connectorStyle}>{connector}</span>
      <span style={isGhost ? ghostDot : dot} aria-hidden="true">
        {isGhost ? '◌' : '◉'}
      </span>
      <span style={isGhost ? ghostName : agentName}>
        {isGhost ? `parent ${node.invocationId.slice(0, 8)}…` : name}
      </span>
      {isGhost && (
        <Chip tone="warning" size="xs">
          not yet ingested
        </Chip>
      )}
      {!isGhost && isParent && (
        <Chip tone="neutral" size="xs">
          parent
        </Chip>
      )}
      {!isGhost && isCurrent && !isParent && (
        <Chip tone="neutral" size="xs">
          current
        </Chip>
      )}
      {!isGhost && (
        <>
          <span style={metaSep}>·</span>
          <span style={meta}>judge</span>
          <Chip tone={judgeTone(node.judgeScore)} size="xs">
            {fmt(node.judgeScore)}
          </Chip>
          <span style={metaSep}>·</span>
          <span style={meta}>dur {fmtDur(node.durationMs)}</span>
          {node.totalCostUsd != null && (
            <>
              <span style={metaSep}>·</span>
              <CostChip cost={node.totalCostUsd} />
            </>
          )}
        </>
      )}
      {isGhost && (
        <span style={ghostHint}>
          referenced parent — poller has not caught its trace yet
        </span>
      )}
      <span style={spacer} />
      {!isGhost && (
        <span style={viewArrow} aria-hidden="true">
          view →
        </span>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const treeBox: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontFamily: 'ui-monospace, monospace',
  fontSize: 12,
};

const row: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  borderRadius: 4,
  cursor: 'pointer',
  border: '1px solid transparent',
  background: 'transparent',
  userSelect: 'none',
};

const connectorStyle: CSSProperties = {
  whiteSpace: 'pre',
  color: 'var(--color-text-tertiary)',
  fontSize: 12,
};

const dot: CSSProperties = {
  color: 'var(--color-primary, #6366f1)',
  fontSize: 11,
};

const agentName: CSSProperties = {
  fontWeight: 600,
  color: 'var(--color-text-primary)',
};

const meta: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'system-ui, sans-serif',
};

const metaSep: CSSProperties = {
  color: 'var(--color-text-tertiary)',
  fontSize: 11,
};

const spacer: CSSProperties = { flex: 1 };

const viewArrow: CSSProperties = {
  fontSize: 11,
  color: 'var(--color-primary, #6366f1)',
  fontFamily: 'system-ui, sans-serif',
};

const ghostDot: CSSProperties = {
  color: 'var(--color-text-tertiary)',
  fontSize: 11,
};

const ghostName: CSSProperties = {
  fontWeight: 500,
  color: 'var(--color-text-tertiary)',
  fontFamily: 'ui-monospace, monospace',
};

const ghostHint: CSSProperties = {
  fontSize: 10.5,
  color: 'var(--color-text-tertiary)',
  fontStyle: 'italic',
  fontFamily: 'system-ui, sans-serif',
};

export default TraceTree;
