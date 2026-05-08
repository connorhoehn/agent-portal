import type { GraphNode, GraphDepartment } from './types';

interface OrgGraphNodeProps {
  node: GraphNode;
  departments: GraphDepartment[];
  isSelected: boolean;
  isHighlighted: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

export function OrgGraphNode({ node, departments, isSelected, isHighlighted, onSelect, onHover }: OrgGraphNodeProps) {
  const dept = departments.find(d => d.name === node.department);
  const color = dept?.color ?? '#64748b';
  const radius = 12 + node.influenceScore * 18;
  const opacity = isHighlighted || isSelected ? 1 : isHighlighted === false ? 0.3 : 0.8;

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      onClick={() => onSelect(node.id)}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      style={{ cursor: 'pointer' }}
    >
      <circle
        r={radius}
        fill={isSelected ? color : `${color}20`}
        stroke={color}
        strokeWidth={isSelected ? 3 : 2}
        opacity={opacity}
      />
      <text
        y={radius + 14}
        textAnchor="middle"
        fontSize={10}
        fill="var(--color-text-secondary, #475569)"
        opacity={opacity}
        style={{ pointerEvents: 'none', userSelect: 'none' }}
      >
        {node.name.split(' ')[0]}
      </text>
      {isSelected && (
        <text
          y={-radius - 6}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="var(--color-text-primary, #1a1a2e)"
          style={{ pointerEvents: 'none' }}
        >
          {node.name}
        </text>
      )}
    </g>
  );
}
