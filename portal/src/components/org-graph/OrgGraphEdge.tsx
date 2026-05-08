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
  const strokeWidth = type === 'reports_to' ? 1 : 1 + strength * 1.5;
  const dashArray = type === 'reports_to' ? '3 3' : type === 'mentors' ? '6 3' : undefined;

  return (
    <line
      x1={source.x}
      y1={source.y}
      x2={target.x}
      y2={target.y}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeDasharray={dashArray}
      opacity={opacity}
      style={{ pointerEvents: 'none' }}
    />
  );
}
