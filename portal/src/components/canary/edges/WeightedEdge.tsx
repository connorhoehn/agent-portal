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
import { Inline } from '@connorhoehnslalom/ui-components/shared';
import type { WeightedEdgeData } from '../types.js';

// React Flow's Edge<T> requires T to satisfy Record<string, unknown>; the
// sibling-owned interface doesn't satisfy that by default, so we widen.
export type WeightedEdgeType = Edge<WeightedEdgeData & Record<string, unknown>, 'weighted'>;

// The dashflow keyframes and `.canary-weighted-edge--animated` live in
// `src/animations.css`. They used to be injected into document.head at
// module scope, which meant importing this file mutated the document before
// anything rendered.

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
        className={isAnimated ? 'canary-weighted-edge canary-weighted-edge--animated' : 'canary-weighted-edge'}
        // Data-driven geometry (traffic weight -> stroke width), not presentation:
        // see the `@xyflow/react` edge helpers row in docs/ui-components-queue.md.
        style={{
          strokeWidth,
          ...style,
        }}
      />
      <EdgeLabelRenderer>
        {/* Everything static about this label is a class now; only the
            transform is left in `style`, because labelX/labelY come from
            getBezierPath at render time and Tailwind cannot build a class
            from them. */}
        <Inline
          gap="none"
          className="nodrag nopan absolute rounded-[10px] border border-border bg-surface px-1.5 py-px text-xs font-semibold tabular-nums text-text-secondary pointer-events-auto"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 18}px)`,
          }}
        >
          {`${Math.round(weight)}%`}
        </Inline>
      </EdgeLabelRenderer>
    </>
  );
}

export const WeightedEdge = memo(WeightedEdgeImpl);
