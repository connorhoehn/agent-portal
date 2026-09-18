// Composed locally in `portal/src/pages/distillation/LineageFrame.tsx` — the
// one place in the distillation feature allowed raw layout elements
// (@xyflow/react's canvas needs a sized wrapper and connector `Handle`s that
// have no ui-components equivalent).
//
// The node body was meant to be the library's `NodeCard`. The reason recorded
// here used to be that it shipped only from the package ROOT, so importing it
// dragged `TiptapEditor`'s uninstalled `@tiptap/react` peer into the chunk and
// broke `vite build`. THAT REASON IS GONE: at the current pin (2.277.2)
// `NodeCard` is declared in `shared.d.ts`, present in the `shared.js` runtime
// barrel, and resolves as a function from `@connorhoehnslalom/ui-components/shared`
// — all three checked, because this repo has been burned by a `.d.ts` the
// barrel never re-exported.
//
// It still is not adopted, for a SHAPE reason rather than a packaging one.
// `NodeCardProps` expresses `status`/`statusLabel`, which drive a StatusPill,
// and exactly one `subtitle`. This node has no status — its chip carries a
// KIND (observation / cluster / artifact / library item), a taxonomy, and
// dressing that up as a status to reach the pill would make the markup lie
// about what the value is. It also needs three stacked lines (label, id, and
// an optional subtitle) where `NodeCard` offers one plus a generic `body`.
// So the body stays `Card` + `Chip` from `/shared`, still exempt as "composed
// locally", and the queue row now records the real blocker instead of the
// stale one.
//
// Typed nodes (colour + icon per LineageNodeKind, from distillationFormat.ts);
// edges carry the relation as a label; `compact` drops the
// background/controls for the mini-lineage embedded in the Artifacts drawer.
//
// Defect #6 (member DEFECTS.md): the node record panel used to render BELOW
// the graph, in normal document flow — `@xyflow/react` captures the wheel
// over its own pane for zoom, so a normal scroll gesture positioned over the
// graph never reached the panel; only scrolling the surrounding `<main>`
// directly did. Fixed here, not in the wheel handler: the frame now lays out
// the graph and an optional `aside` side by side (`xl:flex-row`, 1280px —
// the same breakpoint the panel becomes unreachable at 1440px audit width)
// inside one row whose height the graph pane sets; flexbox's default
// `align-items: stretch` matches the aside to that height with no duplicated
// height math, and the aside scrolls internally (`overflow-y-auto`) if its
// content runs longer than the graph. Below 1280px the aside drops into
// normal stacked flow below the graph (a person on a narrow screen scrolls
// the page to it, same as any other stacked layout) and the graph pane's
// `preventScrolling` flips to `false` so a wheel gesture over the canvas
// scrolls the page instead of being captured for zoom — the real cause of
// the panel being unreachable at any width.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Background, BaseEdge, Controls, EdgeLabelRenderer, Handle, MarkerType, Position, ReactFlow,
  ReactFlowProvider, getBezierPath,
  type Edge, type EdgeProps, type Node, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Card, Chip, EmptyState, LoadingState, Stack } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { T } from './Text';
import {
  LINEAGE_NODE_ACCENT, LINEAGE_NODE_ICON, LINEAGE_NODE_LABEL, LINEAGE_RELATION_LABEL,
  layoutLineage, lineageCanvasHeight, staggerLabelAnchors,
} from './distillationFormat';
import type { Lineage, LineageNodeKind } from './types';

/** Matches the `xl` Tailwind breakpoint (1280px) used for the frame's own
 *  `xl:flex-row` — kept in sync here because the graph pane's
 *  `preventScrolling` prop is a runtime boolean, not something CSS can
 *  drive. SSR-safe default (`true`, i.e. "wide") since this portal has no
 *  server render pass; the effect corrects it on mount and on resize. */
function useIsWideViewport(breakpointPx = 1280): boolean {
  const [isWide, setIsWide] = useState(() =>
    typeof window === 'undefined' ? true : window.innerWidth >= breakpointPx);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(`(min-width: ${breakpointPx}px)`);
    const onChange = () => setIsWide(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [breakpointPx]);

  return isWide;
}

interface LineageNodeData {
  kind: LineageNodeKind;
  label: string;
  subtitle?: string;
  isFocus: boolean;
  onSelect: (id: string) => void;
}

const NODE_WIDTH = 220;

function LineageNodeComp({ id, data }: NodeProps) {
  const d = data as unknown as LineageNodeData;
  return (
    <div
      onClick={() => d.onSelect(id)}
      onKeyDown={(e) => { if (e.key === 'Enter') d.onSelect(id); }}
      role="button"
      tabIndex={0}
      style={{ width: NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
      <Card padding="sm" className={d.isFocus ? 'border-primary shadow-md' : undefined}>
        <Stack gap="xs">
          <Chip tone="neutral" size="xs" icon={LINEAGE_NODE_ICON[d.kind]}>
            {LINEAGE_NODE_LABEL[d.kind]}
          </Chip>
          <T className={`h-1 w-8 rounded-full ${LINEAGE_NODE_ACCENT[d.kind]}`}>&nbsp;</T>
          {/* The title truncates to one line (labels are often a full
              observation headline, well past what NODE_WIDTH can show), and
              a hover-only `title` attribute doesn't help a touch or keyboard
              user. The id is short and stable — showing it underneath means
              a reader can still tell nodes apart, and match one to a URL's
              `?focus=<id>`, without needing the pointer. */}
          <T className="block truncate text-[12px] font-medium text-text-primary" title={d.label}>{d.label}</T>
          <T className="block truncate text-[10px] text-text-tertiary" title={id}>{id}</T>
          {d.subtitle && <T className="block truncate text-[10.5px] text-text-tertiary" title={d.subtitle}>{d.subtitle}</T>}
        </Stack>
      </Card>
    </div>
  );
}

const NODE_TYPES = { lineageNode: LineageNodeComp };

// Defect #14 (org-leader/DEFECTS.md #14, reproduced on member too): the
// default edge label sits at the straight-line midpoint between source and
// target, in FLOW coordinates — and `layoutLineage` (distillationFormat.ts)
// places every node on a fixed column grid, `x = column * <pitch>`. Two
// edges skip a column outright: `published_as` runs artifact (col 2) →
// library_item (col 4), and its midpoint lands EXACTLY on col 3 — the Fact
// column — so a 45px-wide label rendered dead center of the `fact-001` card
// was fully hidden under it (nodes paint above edges in xyflow's pane
// order). `written_by` (observation ↔ session, both col 0) never leaves its
// own column at all, so its midpoint can land on a THIRD node stacked
// between them in that same column instead — same symptom, different node.
//
// The fix doesn't need the column pitch itself (a private constant in
// distillationFormat.ts, not exported, and not this file's to touch):
// whatever the pitch is, `layoutLineage`'s "no node-on-node overlap"
// contract (verified by the audit) means the pitch is provably wider than
// `NODE_WIDTH`, so a fixed inset just past a node's right edge —
// `NODE_WIDTH + LABEL_INSET` — always lands in the gap after that column,
// which no node at any row ever occupies. Anchoring every label's LEFT EDGE
// there (past whichever endpoint sits further left) keeps it out from under
// every node regardless of how many columns — or how few — the edge spans.
const LABEL_INSET = 16;

interface LineageEdgeData {
  relationLabel: string;
  labelX: number;
  labelY: number;
}

function LineageEdgeComp({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, data,
}: EdgeProps) {
  const d = data as unknown as LineageEdgeData;
  const [edgePath] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            // Anchor the label's LEFT edge at labelX, not its centre: a
            // centred label put half its width back over the card to its
            // left, tucking the first characters under it ("ritten by").
            transform: `translate(0, -50%) translate(${d.labelX}px, ${d.labelY}px)`,
            fontSize: 10,
            color: 'var(--color-text-secondary)',
            // Opaque, and a pill: the label sits over a card whenever the
            // 29px gap cannot hold it, so it has to carry its own ground.
            background: 'var(--color-surface)',
            border: '1px solid var(--color-border)',
            borderRadius: 4,
            padding: '0 4px',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {d.relationLabel}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

const EDGE_TYPES = { lineageEdge: LineageEdgeComp };

export interface LineageFrameProps {
  lineage: Lineage | null;
  loading?: boolean;
  error?: string | null;
  focusId?: string | null;
  onSelectNode?: (id: string) => void;
  /** Drops background/controls/pan/zoom for a small embedded preview
   *  (the Artifacts drawer's "Distilled from" mini-lineage). */
  compact?: boolean;
  height?: number;
  /** The selected node's record panel, rendered beside the graph at ≥1280px
   *  and stacked below it under that (defect #6) — pass `null`/`undefined`
   *  to render the graph alone. */
  aside?: ReactNode;
}

export function LineageFrame({
  lineage, loading, error, focusId, onSelectNode, compact, height, aside,
}: LineageFrameProps) {
  const isWide = useIsWideViewport();
  const positions = useMemo(
    () => layoutLineage(lineage?.nodes ?? [], lineage?.edges ?? []),
    [lineage],
  );

  const nodes = useMemo<Node[]>(() => {
    if (!lineage) return [];
    const byId = new Map(positions.map((p) => [p.id, p]));
    return lineage.nodes.map((n) => {
      const pos = byId.get(n.id) ?? { x: 0, y: 0 };
      const subtitle = typeof n.meta?.['subtitle'] === 'string' ? (n.meta['subtitle'] as string) : undefined;
      return {
        id: n.id,
        type: 'lineageNode',
        position: { x: pos.x, y: pos.y },
        data: {
          kind: n.kind, label: n.label, subtitle, isFocus: n.id === focusId,
          onSelect: (id: string) => onSelectNode?.(id),
        } as unknown as Record<string, unknown>,
      };
    });
  }, [lineage, positions, focusId, onSelectNode]);

  const edges = useMemo<Edge[]>(() => {
    if (!lineage) return [];
    const byId = new Map(positions.map((p) => [p.id, p]));
    // See LABEL_INSET above: anchored just past whichever endpoint is further
    // left, not at the raw source/target midpoint — then staggered, because
    // two edges from the same column to the same row land on the same point
    // and would paint over each other.
    const anchors = staggerLabelAnchors(lineage.edges.map((e) => {
      const sp = byId.get(e.from);
      const tp = byId.get(e.to);
      return {
        x: Math.min(sp?.x ?? 0, tp?.x ?? 0) + NODE_WIDTH + LABEL_INSET,
        y: ((sp?.y ?? 0) + (tp?.y ?? 0)) / 2,
      };
    }));
    return lineage.edges.map((e, i) => {
      const labelX = anchors[i]!.x;
      const labelY = anchors[i]!.y;
      return {
        id: `${e.from}-${e.to}-${i}`,
        source: e.from,
        target: e.to,
        type: 'lineageEdge',
        data: { relationLabel: LINEAGE_RELATION_LABEL[e.relation], labelX, labelY } as unknown as Record<string, unknown>,
        markerEnd: { type: MarkerType.ArrowClosed },
        // Not `--color-border`: that is the hairline separator token and an
        // edge drawn in it is invisible against this canvas. See the tone map
        // in CompactionFlowFrame.tsx for the same fix.
        style: { stroke: 'var(--color-text-tertiary)' },
      };
    });
  }, [lineage, positions]);

  if (error) return <UnavailableNotice error={error} what="lineage" source="Lineage is traced from Aurora" />;
  if (loading) return <LoadingState label="Loading lineage…" />;
  if (!lineage || lineage.nodes.length === 0) {
    return <EmptyState title="No lineage yet" description="Nothing has been traced for this item." />;
  }

  // Residual defect: a fixed 560px canvas left most single-artifact traces
  // (1-4 rows against LINEAGE_ROW_HEIGHT=116, i.e. a ~166-460px-tall bounding
  // box) floating small in a mostly-empty box — fitView's zoom is bound by
  // whichever ratio (width or height) is tighter, and a canvas far taller
  // than the content makes the height ratio slack, so the graph never grew
  // past what the (unchanged) width ratio already allowed. Sizing the canvas
  // to the graph's own row count closes that gap; see lineageCanvasHeight's
  // doc comment for the full numbers. `height` still wins when a caller
  // passes one explicitly.
  const graphHeight = height ?? lineageCanvasHeight(positions, compact ? { min: 180, max: 260 } : { min: 220, max: 560 });
  // Below 1280px the aside stacks in normal flow, so the graph must stop
  // eating the wheel: `preventScrolling={false}` lets it bubble to the page
  // instead of zooming the canvas. At ≥1280px the aside sits beside the
  // graph within the same bounded row, so capturing the wheel for zoom is
  // back to being the right default (and matches `compact`'s existing
  // "no pan/zoom chrome" contract, where scroll capture is moot either way).
  const wheelScrollsPage = !compact && !isWide;

  return (
    <div className="flex flex-col gap-3 xl:flex-row">
      <div className="min-w-0 flex-1" style={{ height: graphHeight, width: '100%' }}>
        {/* The inter-column gap is 29px and a relation label is 37–50px wide,
            so no horizontal anchor keeps a label clear of both cards: centring
            buried its head, left-anchoring buried its tail ("supports" read as
            "supp"). The labels carry an opaque pill background, so the answer
            is to paint the label layer ABOVE the nodes instead of squeezing it
            between them — xyflow puts `.react-flow__edgelabel-renderer` under
            `.react-flow__nodes` by default. */}
        <style>{`
          .lineage-canvas .react-flow__edgelabel-renderer { z-index: 6; }
        `}</style>
        <ReactFlowProvider>
          <ReactFlow
            className="lineage-canvas"
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            fitView
            // minZoom/maxZoom bound fitView's own calculation (on top of the
            // canvas-height fix above): a floor of 0.6 — up from xyflow's
            // 0.5 default — keeps a wide, shallow graph from settling at the
            // "roughly half zoom" the audit flagged, and a 1.5 ceiling stops
            // a small graph in a wide container from being blown up past
            // the card's designed scale.
            // The 0.6 floor is for the full-page canvas, where a wide shallow
            // graph used to settle at "roughly half zoom". In the drawer it
            // OUTRANKED fitView: a 1260-unit graph pinned at 0.6 renders
            // 756px into a 680px canvas, clipping 38px off both ends — the
            // leading 29% of a card, which is exactly where the id line sits.
            // A preview's job is to fit, so compact keeps xyflow's own floor.
            fitViewOptions={compact
              ? { padding: 0.08, maxZoom: 1.5 }
              : { padding: 0.12, minZoom: 0.6, maxZoom: 1.5 }}
            proOptions={{ hideAttribution: true }}
            // Nodes are doors ("Tab + Enter a node"); the 13 edges were tab
            // stops that announced raw ids and did nothing on Enter. The
            // sibling CompactionFlowFrame already measures 0 focusable edges.
            edgesFocusable={false}
            nodesDraggable={!compact}
            nodesConnectable={false}
            panOnDrag={!compact}
            zoomOnScroll={!compact}
            preventScrolling={!wheelScrollsPage}
            aria-label="Distillation lineage graph"
            // Culls off-viewport nodes/edges instead of keeping the whole
            // lineage graph mounted — the scale-audit fix, applied here too
            // since a deep compaction lineage can run well past what fits
            // on screen.
            onlyRenderVisibleElements
          >
            {!compact && <Background color="var(--color-border)" />}
            {!compact && <Controls />}
          </ReactFlow>
        </ReactFlowProvider>
      </div>
      {aside && (
        <div className="w-full shrink-0 overflow-y-auto border-t border-border pt-3 xl:h-auto xl:w-[340px] xl:border-l xl:border-t-0 xl:pl-4 xl:pt-0">
          {aside}
        </div>
      )}
    </div>
  );
}
