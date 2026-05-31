import { useState } from 'react';
import type { GraphDepartment } from './types';

const PRESENCE_LEGEND = [
  { color: '#16a34a', label: 'In office' },
  { color: '#3b82f6', label: 'Remote' },
  { color: '#f59e0b', label: 'Traveling' },
  { color: '#f97316', label: 'PTO' },
  { color: '#8b5cf6', label: 'Vacation' },
  { color: '#ef4444', label: 'Sick' },
];

interface OrgGraphLegendProps {
  departments: GraphDepartment[];
  filter: string | null;
  onFilter: (dept: string | null) => void;
  presenceFilter?: 'office' | 'remote' | 'away' | null;
}

const EDGE_TYPES = [
  { type: 'collaborates',    color: '#94a3b8', label: 'Collaborates' },
  { type: 'mentors',         color: '#6366f1', label: 'Mentors',          dash: true },
  { type: 'reports_to',      color: '#d1d5db', label: 'Reports To',       dash: true },
  { type: 'expert_in_common',color: '#f59e0b', label: 'Shared Expertise' },
];

// Collapsed height shows roughly the Departments section only (~50% of full content)
const COLLAPSED_MAX_HEIGHT = 160;

export function OrgGraphLegend({ departments, filter, onFilter, presenceFilter }: OrgGraphLegendProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="absolute top-3 left-3 bg-white border border-border rounded-lg px-4 py-3 text-[11px] shadow-[0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden transition-[opacity,max-height] duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
      style={{
        opacity: hovered ? 1 : 0.2,
        maxHeight: hovered ? 800 : COLLAPSED_MAX_HEIGHT,
      }}
    >
      <div className="font-semibold text-xs mb-2 text-text-primary">
        Departments
      </div>
      {departments.map(dept => (
        <div
          key={dept.id}
          onClick={() => onFilter(filter === dept.name ? null : dept.name)}
          className="flex items-center gap-1.5 mb-1 cursor-pointer"
          style={{ opacity: !filter || filter === dept.name ? 1 : 0.4 }}
        >
          <span
            className="w-2.5 h-2.5 rounded-full flex-shrink-0"
            style={{ background: dept.color }}
          />
          <span>{dept.name}</span>
        </div>
      ))}

      <div className="border-t border-border mt-2 pt-2">
        <div className="font-semibold text-xs mb-1.5">Relationships</div>
        {EDGE_TYPES.map(et => (
          <div key={et.type} className="flex items-center gap-1.5 mb-[3px]">
            <svg width={20} height={8}>
              <line
                x1={0} y1={4} x2={20} y2={4}
                stroke={et.color}
                strokeWidth={2}
                strokeDasharray={et.dash ? '4 2' : undefined}
              />
            </svg>
            <span>{et.label}</span>
          </div>
        ))}
      </div>

      {filter && (
        <button
          onClick={() => onFilter(null)}
          className="mt-2 w-full py-1 text-[11px] border border-border rounded bg-surface-hover cursor-pointer"
        >
          Clear Filter
        </button>
      )}

      {/* Presence dot legend — only shown when a presence filter is active */}
      {presenceFilter && (
        <div className="border-t border-border mt-2 pt-2">
          <div className="font-semibold text-xs mb-[5px]">Presence today</div>
          {PRESENCE_LEGEND.map(({ color, label }) => (
            <div key={label} className="flex items-center gap-1.5 mb-[3px]">
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ background: color }}
              />
              <span>{label}</span>
            </div>
          ))}
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0 box-border bg-[#3b82f6] outline-2 outline-dashed outline-[#3b82f6] outline-offset-[3px]" />
            <span className="text-text-tertiary">WFH ring</span>
          </div>
        </div>
      )}
    </div>
  );
}
