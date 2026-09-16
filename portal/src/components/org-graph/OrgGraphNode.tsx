import type { KeyboardEvent } from 'react';
import type { GraphNode, GraphDepartment, PresenceStatus } from './types';
import { nodeRadius } from './graphInsights';

// ── Presence palette ──────────────────────────────────────────────────────────
// Visual language mirrors Slack/Teams status dots + vacation indicators.

const PRESENCE_DOT: Record<PresenceStatus, { fill: string; stroke: string; label: string }> = {
  office:   { fill: '#16a34a', stroke: '#fff',    label: 'In office'   },
  wfh:      { fill: '#3b82f6', stroke: '#fff',    label: 'Remote'      },
  travel:   { fill: '#f59e0b', stroke: '#fff',    label: 'Traveling'   },
  pto:      { fill: '#f97316', stroke: '#fff',    label: 'PTO'         },
  vacation: { fill: '#8b5cf6', stroke: '#fff',    label: 'Vacation'    },
  sick:     { fill: '#ef4444', stroke: '#fff',    label: 'Out sick'    },
  unknown:  { fill: '#cbd5e1', stroke: '#e2e8f0', label: 'No check-in' },
};

// Away = any status that means NOT at keyboard
const AWAY_STATUSES: PresenceStatus[] = ['pto', 'vacation', 'sick'];

interface OrgGraphNodeProps {
  node: GraphNode;
  departments: GraphDepartment[];
  isSelected: boolean;
  isHighlighted: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  /** When set, dim nodes that don't match the given presence filter. null/undefined = no filter. */
  presenceFilter?: 'office' | 'remote' | 'away' | null;
  /** True only for roles allowed to see influence (org-leader/hr-admin/admin)
   *  — everyone else sizes by connection count so the circle can't leak the
   *  hidden number. */
  showInfluence: boolean;
  /** This node's degree in the currently-rendered graph (edges touching it). */
  degree: number;
  /** Largest degree in the currently-rendered graph, for normalizing `degree`. */
  maxDegree: number;
}

export function OrgGraphNode({
  node, departments, isSelected, isHighlighted, onSelect, onHover, presenceFilter,
  showInfluence, degree, maxDegree,
}: OrgGraphNodeProps) {
  const dept = departments.find(d => d.name === node.department);
  const color = dept?.color ?? '#64748b';
  const radius = nodeRadius(showInfluence, node.influenceScore, degree, maxDegree);

  // Presence
  const pres: PresenceStatus = node.presence ?? 'unknown';
  const presInfo = PRESENCE_DOT[pres];

  // Does this node pass the active presence filter?
  const passesFilter = !presenceFilter
    ? true
    : presenceFilter === 'office' ? pres === 'office'
    : presenceFilter === 'remote' ? (pres === 'wfh' || pres === 'travel')
    : AWAY_STATUSES.includes(pres);

  const baseOpacity = isHighlighted || isSelected ? 1 : isHighlighted === false ? 0.3 : 0.8;
  const opacity = passesFilter ? baseOpacity : 0.15;

  // Presence dot size and position (bottom-right of the circle)
  const dotR = Math.max(2, radius * 0.14);
  const dotAngle = Math.PI * 0.25; // 45° from bottom-right
  const dotX = (radius - dotR * 0.4) * Math.cos(dotAngle);
  const dotY = (radius - dotR * 0.4) * Math.sin(dotAngle);

  // Vacation/PTO badge: small ✈ or ☀ text above node
  const awayIcon = pres === 'vacation' ? '☀' : pres === 'pto' ? '🏖' : pres === 'sick' ? '🤒' : pres === 'travel' ? '✈' : null;

  function handleKeyDown(e: KeyboardEvent<SVGGElement>) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      onSelect(node.id);
    }
  }

  return (
    <g
      transform={`translate(${node.x}, ${node.y})`}
      onClick={() => onSelect(node.id)}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(null)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-label={`${node.name} · ${node.title} · ${node.department}`}
      aria-pressed={isSelected}
      className="cursor-pointer"
      style={{ opacity }}
    >
      {/* Node ring for WFH — dashed blue stroke overlay */}
      {pres === 'wfh' && (
        <circle
          r={radius + 3}
          fill="none"
          stroke="#3b82f6"
          strokeWidth={1.5}
          strokeDasharray="4 3"
          opacity={0.5}
        />
      )}

      {/* Main circle */}
      <circle
        r={radius}
        fill={isSelected ? color : `${color}20`}
        stroke={color}
        strokeWidth={isSelected ? 3 : 2}
      />

      {/* First-name label below */}
      <text
        y={radius + 14}
        textAnchor="middle"
        fontSize={10}
        fill="var(--color-text-secondary, #475569)"
        className="pointer-events-none select-none"
      >
        {node.name.split(' ')[0]}
      </text>

      {/* Full name label when selected */}
      {isSelected && (
        <text
          y={-radius - 6}
          textAnchor="middle"
          fontSize={11}
          fontWeight={600}
          fill="var(--color-text-primary, #1a1a2e)"
          className="pointer-events-none"
        >
          {node.name}
        </text>
      )}

      {/* Presence status dot (bottom-right quadrant) */}
      {pres !== 'unknown' && (
        <g transform={`translate(${dotX}, ${dotY})`}>
          <circle r={dotR} fill={presInfo.stroke} />
          <circle r={dotR - 1} fill={presInfo.fill} />
        </g>
      )}

      {/* Away icon intentionally omitted — shown in hover card only */}
    </g>
  );
}
