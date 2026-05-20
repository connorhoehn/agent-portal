// Canary WeightedEdge — stroke width scales with the percentage of traffic
// that the router is sending down this edge, and the dashed pattern flows
// while there's any nonzero weight.

import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { WeightedEdgeData } from '../types.js';

// React Flow's Edge<T> requires T to satisfy Record<string, unknown>; the
// sibling-owned interface doesn't satisfy that by default, so we widen.
export type WeightedEdgeType = Edge<WeightedEdgeData & Record<string, unknown>, 'weighted'>;

// One module-level <style> for the dashflow animation. Cheaper than a
// CSS-in-JS dep and shared across every weighted edge.
const STYLE_ID = 'canary-weighted-edge-keyframes';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = `
@keyframes canary-edge-dashflow {
  from { stroke-dashoffset: 16; }
  to   { stroke-dashoffset: 0; }
}
.canary-weighted-edge--animated {
  stroke-dasharray: 6 4;
  animation: canary-edge-dashflow 0.8s linear infinite;
}`;
  document.head.appendChild(el);
}

function WeightedEdgeImpl({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  style,
}: EdgeProps<WeightedEdgeType>) {
  const weight = Math.max(0, Math.min(100, data?.weight ?? 0));
  const strokeWidth = 2 + 0.08 * weight;
  const isAnimated = weight > 0;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        path={edgePath}
        markerEnd={markerEnd}
        className={isAnimated ? 'canary-weighted-edge--animated' : undefined}
        style={{
          stroke: 'var(--color-primary, #6366f1)',
          strokeWidth,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 18}px)`,
            background: 'var(--color-surface, #fff)',
            border: '1px solid var(--color-border, #e2e8f0)',
            borderRadius: 10,
            padding: '1px 6px',
            fontSize: 10,
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: 'var(--color-text-secondary, #475569)',
            pointerEvents: 'all',
          }}
        >
          {`${Math.round(weight)}%`}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const WeightedEdge = memo(WeightedEdgeImpl);
