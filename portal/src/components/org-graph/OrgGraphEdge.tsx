import type { GraphNode } from './types';

interface OrgGraphEdgeProps {
  source: GraphNode;
  target: GraphNode;
  type: string;
  strength: number;
  isHighlighted: boolean;
}

const EDGE_COLORS: Record<string, string> = {
  collaborates: '#94a3b8',
  mentors: '#6366f1',
  reports_to: '#d1d5db',
  expert_in_common: '#f59e0b',
};

export function OrgGraphEdge({ source, target, type, strength, isHighlighted }: OrgGraphEdgeProps) {
  const color = EDGE_COLORS[type] ?? '#cbd5e1';
  const opacity = isHighlighted ? 0.8 : 0.2;
  const strokeWidth = type === 'reports_to' ? 1.5 : 1 + strength * 1.5;
  // reports_to uses an arrowhead for direction — solid line, no dash needed
  const dashArray = type === 'mentors' ? '6 3' : undefined;

  let x2 = target.x ?? 0;
  let y2 = target.y ?? 0;

  if (type === 'reports_to') {
    // Shorten the line so the arrowhead tip lands at the target node perimeter.
    const targetRadius = 12 + (target.influenceScore ?? 0) * 18;
    const markerLen = 15; // match markerWidth in the defs
    const offset = targetRadius + markerLen + 2;
    const dx = (target.x ?? 0) - (source.x ?? 0);
    const dy = (target.y ?? 0) - (source.y ?? 0);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > offset) {
      x2 = (target.x ?? 0) - (dx / dist) * offset;
      y2 = (target.y ?? 0) - (dy / dist) * offset;
    }
  }

  return (
    <line
      x1={source.x}
      y1={source.y}
      x2={x2}
      y2={y2}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeDasharray={dashArray}
      opacity={opacity}
      markerEnd={type === 'reports_to' ? 'url(#org-arrow-reports)' : undefined}
      className="pointer-events-none"
    />
  );
}
