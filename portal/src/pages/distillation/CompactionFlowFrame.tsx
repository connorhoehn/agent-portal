// Composed locally in `portal/src/pages/distillation/CompactionFlowFrame.tsx`
// — the one other place in the distillation feature allowed raw layout
// elements (see docs/ui-components-queue.md), for the same reason as
// `LineageFrame.tsx`: `@xyflow/react`'s canvas needs a sized wrapper and
// connector `Handle`s with no ui-components equivalent, and `NodeCard` is
// only exported from the package root (which drags in `TiptapEditor`'s
// uninstalled `@tiptap/react` peer dep and breaks `vite build`) — so node
// bodies are `Card`+`Chip` from `/shared`, same workaround as the lineage
// graph.
//
// Purely presentational: `CompactionFlow.tsx` fetches levels/health/jobs/
// published-count and reduces them to a `CompactionFlowModel` (pure, in
// distillationFormat.ts); this file only turns that model into an xyflow
// canvas and reports clicks upward via `onNavigate`.
//
// Animation, in order of precedence per edge:
//   1. `running`  — xyflow's own `animated` edge (the built-in `dashdraw`
//      dash-flow, 0.5s) PLUS a small `<circle>` riding the edge's own path
//      via native SVG `<animateMotion>`/`<mpath href="#<edgeId>">` — no
//      library needed, `BaseEdge` already gives the rendered `<path>` that
//      `id`, so the `mpath` reference is exact.
//   2. `breathing` (idle, target level behind/stalled) — a slower, custom
//      `compaction-edge-breathe` keyframe (3s) applied via `BaseEdge`'s
//      `className` passthrough; declared once in the inline `<style>`
//      below since this feature owns no shared stylesheet to add it to.
//   3. neither — a plain, static stroke in the edge's tone colour.
// `prefers-reduced-motion: reduce` short-circuits both 1 and 2 to a static
// stroke, checked once via `usePrefersReducedMotion` (same
// matchMedia-effect shape as `LineageFrame`'s `useIsWideViewport`).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BaseEdge, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow, ReactFlowProvider, getBezierPath,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Card, Chip, EmptyState, LoadingState, Stack } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { T } from './Text';
import { LEVEL_HEALTH_TONE } from './distillationFormat';
import type { CompactionFlowEdgeTone, CompactionFlowModel, CompactionFlowNode, CompactionFlowNodeKind } from './types';

const NODE_WIDTH = 168;

// `neutral` is NOT `--color-border`. That token is the hairline used for
// table rules and card edges, about 1.2:1 against this canvas — so
// every edge carrying no health verdict (the four inputs into L0, L2 →
// Library, L2 → Promotions, Library → Session config) was drawn but could
// not be seen, and the flow read as disconnected boxes with two coloured
// arrows floating between them. An edge is content, not a separator, so it
// takes a text token: `--color-text-tertiary` is the de-emphasis colour, ~2.5x
// the contrast of the border token, and still recedes behind the
// green/amber/red an edge uses when it DOES have a verdict to report.
const EDGE_TONE_COLOR: Record<CompactionFlowEdgeTone, string> = {
  healthy: 'var(--color-success)',
  behind: 'var(--color-warning)',
  stalled: 'var(--color-danger)',
  neutral: 'var(--color-text-tertiary)',
};

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function'
      ? false
      : window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => setReduced(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return reduced;
}

interface FlowNodeData {
  kind: CompactionFlowNodeKind;
  title: string;
  count: number | null;
  health?: CompactionFlowNode['health'];
  ariaLabel: string;
  /** Absent for a node with no route to open (defect #12) — the node then
   *  renders as a plain, non-focusable, non-clickable card instead of a
   *  door the caller can't actually walk through. */
  onSelect?: () => void;
}

function CompactionFlowNodeComp({ data }: NodeProps) {
  const d = data as unknown as FlowNodeData;
  const countLabel = d.count == null ? '—' : d.count;
  const body = (
    <>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Card padding="sm">
        <Stack gap="xs">
          <T className="block truncate text-[10.5px] font-semibold uppercase tracking-wide text-text-tertiary" title={d.title}>
            {d.title}
          </T>
          <T className="block text-[20px] font-semibold leading-none tabular-nums text-text-primary">{countLabel}</T>
          {d.health && (
            <Chip tone={LEVEL_HEALTH_TONE[d.health]} size="xs" dot="static">{d.health}</Chip>
          )}
        </Stack>
      </Card>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </>
  );

  if (!d.onSelect) {
    return (
      <div role="group" aria-label={d.ariaLabel} style={{ width: NODE_WIDTH }}>
        {body}
      </div>
    );
  }

  const onSelect = d.onSelect;
  return (
    <div
      onClick={onSelect}
      // Defect #11: Enter activated a node but Space did not, even though
      // both are the platform's activation keys for role="button". Space's
      // default action (page scroll) is prevented the same way a native
      // <button> suppresses it.
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
      role="button"
      tabIndex={0}
      aria-label={d.ariaLabel}
      style={{ width: NODE_WIDTH }}
    >
      {body}
    </div>
  );
}

interface FlowEdgeData {
  breathing: boolean;
  reducedMotion: boolean;
  tone: CompactionFlowEdgeTone;
  label: string;
  /** Set only on an edge that stays static on purpose — rendered as a
   *  native hover tooltip on its label chip, explaining why (a missing
   *  timestamp on the wire, not an oversight). */
  title?: string;
}

function CompactionFlowEdgeComp({
  id, sourceX, sourceY, targetX, targetY, data, markerEnd, animated,
}: EdgeProps) {
  const d = data as unknown as FlowEdgeData;
  const [edgePath, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY });
  const color = EDGE_TONE_COLOR[d.tone];
  const showDot = animated && !d.reducedMotion;
  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        className={!animated && d.breathing && !d.reducedMotion ? 'compaction-edge-breathe' : undefined}
        style={{ stroke: color, strokeWidth: 2 }}
      />
      {showDot && (
        <circle r={4} fill={color}>
          <animateMotion dur="1.2s" repeatCount="indefinite">
            <mpath href={`#${id}`} />
          </animateMotion>
        </circle>
      )}
      {d.label !== '' && <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          title={d.title}
          // Sit the label above the line, not on it — on the line it hid the
          // stroke and, with short edges, overlapped the node cards. A
          // static edge with a `title` takes pointer events so the hover
          // tooltip actually fires; every other edge stays click-through.
          style={{
            position: 'absolute',
            transform: `translate(-50%, -100%) translate(${labelX}px, ${labelY - 8}px)`,
            pointerEvents: d.title ? 'auto' : 'none',
          }}
        >
          <Chip tone="neutral" size="xs" dot={animated ? 'pulse' : undefined}>{d.label}</Chip>
        </div>
      </EdgeLabelRenderer>}
    </>
  );
}

const NODE_TYPES = { compactionFlowNode: CompactionFlowNodeComp };
const EDGE_TYPES = { compactionFlowEdge: CompactionFlowEdgeComp };

export interface CompactionFlowFrameProps {
  model: CompactionFlowModel | null;
  loading?: boolean;
  error?: string | null;
  onNavigate: (path: string) => void;
  height?: number;
  /** The canvas's accessible name — the ladder by default; the Overview's
   *  end-to-end process flow passes its own. */
  ariaLabel?: string;
}

export function CompactionFlowFrame({
  model, loading, error, onNavigate, height = 200,
  ariaLabel = 'Compaction tier ladder: L0 observations to L1 clusters to L2 artifacts to Library',
}: CompactionFlowFrameProps) {
  const reducedMotion = usePrefersReducedMotion();

  // Stable node/edge identities. Rebuilding these arrays on every render
  // (the page polls, the reduced-motion hook re-renders once on mount) fed
  // xyflow a brand-new node set each time, so it never finished measuring:
  // every node stayed `visibility: hidden`, no edge was ever drawn, fitView
  // never ran, and a real click landed on the pane — the audit's "dead
  // click". Memoised on the model, with navigation through a ref so the
  // callback identity cannot churn the memo. Hooks sit above the early
  // returns below — calling them after a conditional return broke the
  // rules of hooks and white-screened the page on the first re-render.
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const nodes = useMemo<Node[]>(() => (model?.nodes ?? []).map((n) => ({
    id: n.id,
    type: 'compactionFlowNode',
    position: { x: n.x, y: n.y },
    data: {
      kind: n.kind, title: n.label, count: n.count, health: n.health, ariaLabel: n.ariaLabel,
      onSelect: n.navigateTo ? () => navigateRef.current(n.navigateTo!) : undefined,
    } as unknown as Record<string, unknown>,
  })), [model]);

  const edges = useMemo<Edge[]>(() => (model?.edges ?? []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: 'compactionFlowEdge',
    animated: e.running && !reducedMotion,
    markerEnd: { type: MarkerType.ArrowClosed, color: EDGE_TONE_COLOR[e.tone] },
    data: { label: e.label, breathing: e.breathing, reducedMotion, tone: e.tone, title: e.title } as unknown as Record<string, unknown>,
  })), [model, reducedMotion]);

  if (error) return <UnavailableNotice error={error} what="the compaction flow" source="Compaction jobs are read from Aurora" />;
  if (loading && !model) return <LoadingState label="Loading compaction flow…" />;
  if (!model || model.nodes.length === 0) {
    return <EmptyState title="No compaction flow yet" description="Nothing has been ingested for this ladder." />;
  }

  return (
    <div style={{ height, width: '100%' }}>
      <style>{`
        .compaction-edge-breathe { stroke-dasharray: 6 5; animation: compaction-edge-breathe 3s ease-in-out infinite; }
        @keyframes compaction-edge-breathe { 0%, 100% { stroke-opacity: 0.35; } 50% { stroke-opacity: 0.9; } }
      `}</style>
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
          nodesDraggable={false}
          // The canonical click path: the audit saw a real mouse click on a
          // tier node do nothing while Enter worked — the inner handler is
          // kept, but ReactFlow's own node click is what the pane guarantees.
          // A node with no navigateTo (defect #12's unknown-count case) has
          // nothing to open, so a click on it is a no-op rather than a
          // navigate(undefined).
          onNodeClick={(_evt, node) => {
            const target = model.nodes.find((n) => n.id === node.id);
            if (target?.navigateTo) onNavigate(target.navigateTo);
          }}
          nodesConnectable={false}
          // Defect #11: the flow's own node card is the one real tab stop
          // per node (it owns Enter/Space activation above); xyflow's outer
          // `.react-flow__node` wrapper is focusable by default and doubled
          // every node's tab stop, and its 10 edges were focusable with no
          // activation of their own — together that was 32 stops for 11
          // doors. Both switched off here so Tab visits exactly one stop per
          // node.
          nodesFocusable={false}
          edgesFocusable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          aria-label={ariaLabel}
          // Culls off-viewport nodes/edges instead of keeping every
          // compaction tier mounted — the scale-audit fix, applied across
          // every xyflow canvas in the portal.
          onlyRenderVisibleElements
        />
      </ReactFlowProvider>
    </div>
  );
}
