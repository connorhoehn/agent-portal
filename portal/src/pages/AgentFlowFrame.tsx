// Composed locally in `portal/src/pages/AgentFlowFrame.tsx` — the xyflow
// canvas gap noted in docs/ui-components-queue.md: no ui-components
// composite wraps an `@xyflow/react` canvas or its overlay chrome, and the
// custom node body needs connector `Handle`s that have no ui-components
// equivalent. (Distillation's two xyflow frames were retired onto the
// library's `TypedNodeCanvas` in 2.388.0; this canvas still needs connector
// `Handle`s and live metrics, which that composite does not model) —
// the node card is `Card`+`Chip`+`StatusDot` from `/shared` rather than raw
// `<div>`s, and this file owns the palette + formatters the node renderer
// needs (`STATUS_COLORS`, `CLUSTER_COLORS`, `fmtMs`, `fmtCount`) so
// `AgentFlowPage.tsx` imports them back rather than duplicating them.
//
// Purely presentational: `AgentFlowPage.tsx` fetches topology + agents,
// derives `nodes`/`edges` (xyflow `Node[]`/`Edge[]`, same shape as before)
// and a pane-click handler, and this file only turns those into the
// `<ReactFlow>` canvas plus its legend panel.
import {
  Background, Controls, Handle, Panel, Position, ReactFlow, ReactFlowProvider,
  type Edge, type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { formatTokenCount } from '../lib/format';
import { Card, Chip, Inline, Stack, StatusDot, T } from '@connorhoehnslalom/ui-components/shared';

// ── Palette + formatters shared with AgentFlowPage.tsx ───────────────────────

export const STATUS_COLORS: Record<string, string> = {
  healthy: 'var(--color-success)',
  degraded: 'var(--color-warning)',
  offline: 'var(--color-danger)',
  deploying: 'var(--color-brand)',
};

export const CLUSTER_COLORS: Record<string, string> = {
  orgiq: 'var(--color-brand)',
};

// The node card's fixed footprint (`w-[215px]` below, plus its typical
// rendered height with a status row, a two-line description and a metric
// row). AgentFlowPage.tsx seeds every node's `initialWidth`/`initialHeight`
// with these so xyflow has dimensions from the first render instead of
// waiting on a ResizeObserver that, for this fixed-position graph, never
// flips `visibility` back from `hidden` (DEFECTS.md #6).
export const NODE_WIDTH = 215;
export const NODE_HEIGHT = 128;

// Token-backed Tailwind classes standing in for the palettes above wherever
// a color needs to land on a `border`/`background` — a class string is a
// literal here (never built from a runtime template), so Tailwind's scanner
// picks it up like any other class, and no JSX ever needs a `style=` prop
// (the validator now bans that even hoisted to a named const). Keys mirror
// `STATUS_COLORS` + one fallback for an unrecognized status.
const STATUS_BORDER_CLASS: Record<string, string> = {
  healthy: 'border-success',
  degraded: 'border-warning',
  offline: 'border-danger',
  deploying: 'border-brand',
  unknown: 'border-text-tertiary',
};

export function fmtMs(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Same compact-count shape as lib/format.ts's formatTokenCount(..., { compact:
// true }) — delegated here rather than duplicated, kept under its own name
// since call/error counts (not just tokens) use it.
export function fmtCount(n: number): string {
  return formatTokenCount(n, { compact: true });
}

// ── Custom AgentNode ──────────────────────────────────────────────────────────

interface AgentNodeMeta {
  display: string;
  description: string;
  cluster: string;
}

interface AgentNodeSummary {
  status?: string;
  invocationCount: number;
  errorCount: number;
  p95Ms: number | null;
}

type AgentNodeData = {
  meta: AgentNodeMeta;
  summary: AgentNodeSummary | null;
  onSelect: (id: string) => void;
};

function AgentNodeComp({ id, data }: { id: string; data: unknown }) {
  const { meta, summary, onSelect } = data as AgentNodeData;
  const status = summary?.status ?? 'offline';
  const statusColor = STATUS_COLORS[status] ?? 'var(--color-text-tertiary)';
  const borderClass = STATUS_BORDER_CLASS[status] ?? STATUS_BORDER_CLASS['unknown'];

  return (
    <Card
      onClick={() => onSelect(id)}
      // xyflow's own node wrapper is already tabbable (`tabIndex=0`,
      // `role="group"`) and handles Enter only as a select/unselect toggle,
      // not as "activate" — it never calls back into `onNodeClick`/our
      // `onSelect`. A real Enter/Space handler here (as the retired
      // distillation compaction frame's node had) is what actually opens
      // the metrics drawer from the keyboard (DEFECTS.md #6).
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(id); } }}
      role="button"
      tabIndex={0}
      aria-label={`${meta.display} — ${status}, open metrics`}
      padding="none"
      className={`w-[215px] cursor-pointer select-none rounded-[10px] border-2 px-3.5 py-2.5 shadow-[0_2px_8px_rgba(15,23,42,0.07)] ${borderClass}`}
    >
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} className="opacity-0" />

      <Inline align="center" gap="xs" className="mb-[5px]">
        <StatusDot color={statusColor} size="xs" />
        <T size="sm" weight="bold" tone="primary" className="flex-1">{meta.display}</T>
        {/* Every agent today is in the one `orgiq` cluster (CLUSTER_COLORS
            has a single entry) — a fixed semantic tone reads the same as
            that cluster's indigo swatch without a computed `style` object. */}
        <Chip size="md" uppercase tone="accent">Work</Chip>
      </Inline>

      {/* The card is a button: its text stays on the control scale (12/14px),
          so the description is the 12px step, clamped to two lines. */}
      <T as="div" size="xs" tone="tertiary" title={meta.description} className="mb-2 line-clamp-2">{meta.description}</T>

      <Inline gap="xs">
        <MetricChip label="calls" value={fmtCount(summary?.invocationCount ?? 0)} />
        <MetricChip label="err" value={String(summary?.errorCount ?? 0)} accent={(summary?.errorCount ?? 0) > 0 ? 'warn' : undefined} />
        <MetricChip label="p95" value={fmtMs(summary?.p95Ms ?? null)} />
      </Inline>
    </Card>
  );
}

function MetricChip({ label, value, accent }: { label: string; value: string; accent?: 'warn' | 'danger' }) {
  const accentClass = accent === 'danger' ? 'text-danger' : accent === 'warn' ? 'text-warning' : 'text-text-primary';
  return (
    <Card padding="none" className="flex-1 rounded border border-border bg-surface-inset px-1 py-[3px] text-center">
      <T as="div" size="xs" tone="tertiary" className="justify-center">{label}</T>
      <T as="div" size="xs" weight="semibold" className={`justify-center ${accentClass}`}>{value}</T>
    </Card>
  );
}

const NODE_TYPES = { agentNode: AgentNodeComp };

// ── Legend ────────────────────────────────────────────────────────────────────

// `swatchClass` is a literal Tailwind arbitrary-value class per row (not
// built from a runtime template), so it's picked up by the Tailwind scanner
// the same as any class written directly in JSX — no `style=` prop needed.
const LEGEND_ROWS: Array<{ swatchClass: string; label: string }> = [
  { swatchClass: 'bg-success', label: '< 2% error' },
  { swatchClass: 'bg-warning', label: '2 – 10% error' },
  { swatchClass: 'bg-danger', label: '> 10% error' },
  { swatchClass: 'bg-text-tertiary', label: 'no traffic yet' },
];

function Legend() {
  return (
    <Card padding="none" className="rounded-md px-3 py-[9px] shadow-[0_2px_8px_rgba(15,23,42,0.05)]">
      <Stack gap="xs">
        <T className="mb-[5px] block text-[10px] font-bold text-text-primary">Edges</T>
        {LEGEND_ROWS.map(({ swatchClass, label }) => (
          <Inline key={label} align="center" gap="xs" className="text-[10.5px]">
            <Inline as="span" className={`h-[2.5px] w-4 shrink-0 rounded ${swatchClass}`} />
            <T className="text-text-secondary">{label}</T>
          </Inline>
        ))}
        <Inline align="center" gap="xs" className="text-[10.5px]">
          <Inline as="span" className="h-0 w-4 shrink-0 border-t-2 border-dashed border-text-tertiary" />
          <T className="text-text-secondary">cross-cluster</T>
        </Inline>
      </Stack>
    </Card>
  );
}

// ── Frame ─────────────────────────────────────────────────────────────────────

export interface AgentFlowFrameProps {
  nodes: Node[];
  edges: Edge[];
  onPaneClick: () => void;
}

export function AgentFlowFrame({ nodes, edges, onPaneClick }: AgentFlowFrameProps) {
  return (
    <ReactFlowProvider>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.12 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable
        onPaneClick={onPaneClick}
        // Culls nodes/edges scrolled out of the viewport instead of keeping
        // every one mounted — the scale-audit fix applied to every xyflow
        // canvas in the portal, this fleet map included even though it's
        // small today.
        onlyRenderVisibleElements
      >
        <Background color="var(--color-border)" />
        <Controls />
        <Panel position="bottom-left">
          <Legend />
        </Panel>
      </ReactFlow>
    </ReactFlowProvider>
  );
}
