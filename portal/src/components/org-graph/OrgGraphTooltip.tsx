import { Card, Chip, Inline } from '@connorhoehnslalom/ui-components/shared';
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
    // Card rather than a hand-rolled box, which also fixes a real bug: the
    // original set `bg-white`, so in dark mode this card stayed white with
    // light-on-light text. Card paints `bg-surface`, which follows the theme.
    // `left`/`top` stay inline — they are computed from the node's position.
    <Card
      className="absolute px-4 py-3 shadow-[0_4px_12px_rgba(0,0,0,0.1)] z-[100] w-[220px] pointer-events-none"
      style={{ left, top }}
    >
      <Inline as="div" gap="none" className="font-semibold text-sm mb-0.5">{node.name}</Inline>
      <Inline as="div" gap="none" className="text-xs text-text-secondary">{node.title}</Inline>
      {/* the department's own colour, straight off the row */}
      <Inline as="div" gap="none" className="text-[11px] mt-1 font-medium" style={{ color: dept?.color }}>
        {node.department}
      </Inline>
      <Inline gap="xs" wrap className="mt-2">
        {node.skills.slice(0, 4).map(skill => (
          <Chip key={skill} tone="neutral" size="xs">{skill}</Chip>
        ))}
      </Inline>
      {showAnalytics && (
        <Inline gap="sm" justify="between" wrap={false} className="mt-2 text-[11px]">
          <Inline as="span" gap="none" className="text-text-tertiary">Influence</Inline>
          <Inline as="span" gap="none" className="font-semibold">{Math.round(node.influenceScore * 100)}/100</Inline>
        </Inline>
      )}
    </Card>
  );
}
