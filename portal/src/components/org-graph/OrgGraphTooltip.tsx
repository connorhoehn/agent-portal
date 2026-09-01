import type { GraphNode, GraphDepartment } from './types';
import { useSession } from '../../lib/auth';

interface OrgGraphTooltipProps {
  node: GraphNode;
  departments: GraphDepartment[];
  containerRect: DOMRect | null;
}

export function OrgGraphTooltip({ node, departments, containerRect }: OrgGraphTooltipProps) {
  // Influence is leadership analytics (the ViewLeaderboard tier) — the hover
  // card was quietly giving every role the HR read on each node.
  const { session } = useSession();
  const showAnalytics =
    session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const dept = departments.find(d => d.name === node.department);
  if (!containerRect) return null;

  const left = Math.min(node.x + 20, containerRect.width - 240);
  const top = Math.max(node.y - 40, 10);

  return (
    <div
      className="absolute bg-white border border-border rounded-lg px-4 py-3 shadow-[0_4px_12px_rgba(0,0,0,0.1)] z-[100] w-[220px] pointer-events-none"
      style={{ left, top }}
    >
      <div className="font-semibold text-sm mb-0.5">{node.name}</div>
      <div className="text-xs text-text-secondary">{node.title}</div>
      <div className="text-[11px] mt-1 font-medium" style={{ color: dept?.color }}>{node.department}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {node.skills.slice(0, 4).map(skill => (
          <span key={skill} className="text-[10px] px-1.5 py-0.5 bg-surface-hover rounded text-text-secondary">
            {skill}
          </span>
        ))}
      </div>
      {showAnalytics && (
        <div className="mt-2 flex justify-between text-[11px]">
          <span className="text-text-tertiary">Influence</span>
          <span className="font-semibold">{Math.round(node.influenceScore * 100)}/100</span>
        </div>
      )}
    </div>
  );
}
