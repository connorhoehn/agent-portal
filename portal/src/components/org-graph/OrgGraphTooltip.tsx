import type { GraphNode, GraphDepartment } from './types';

interface OrgGraphTooltipProps {
  node: GraphNode;
  departments: GraphDepartment[];
  containerRect: DOMRect | null;
}

export function OrgGraphTooltip({ node, departments, containerRect }: OrgGraphTooltipProps) {
  const dept = departments.find(d => d.name === node.department);
  if (!containerRect) return null;

  const left = Math.min(node.x + 20, containerRect.width - 240);
  const top = Math.max(node.y - 40, 10);

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        background: 'white',
        border: '1px solid var(--color-border, #e2e8f0)',
        borderRadius: 8,
        padding: '12px 16px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
        zIndex: 100,
        width: 220,
        pointerEvents: 'none',
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{node.name}</div>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #64748b)' }}>{node.title}</div>
      <div style={{ fontSize: 11, color: dept?.color, marginTop: 4, fontWeight: 500 }}>{node.department}</div>
      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {node.skills.slice(0, 4).map(skill => (
          <span key={skill} style={{
            fontSize: 10,
            padding: '2px 6px',
            background: 'var(--color-surface-hover, #f1f5f9)',
            borderRadius: 4,
            color: 'var(--color-text-secondary, #475569)',
          }}>
            {skill}
          </span>
        ))}
      </div>
      <div style={{ marginTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
        <span style={{ color: 'var(--color-text-tertiary, #94a3b8)' }}>Influence</span>
        <span style={{ fontWeight: 600 }}>{Math.round(node.influenceScore * 100)}/100</span>
      </div>
    </div>
  );
}
