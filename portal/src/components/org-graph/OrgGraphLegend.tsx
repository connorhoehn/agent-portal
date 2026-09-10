import { useState } from 'react';
import { Button, Card, Inline, StatusDot } from '@connorhoehnslalom/ui-components/shared';
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
    // Card, not a hand-rolled box — and that fixes a real bug on the way: the
    // original painted `bg-white`, so in dark mode the legend stayed white with
    // light text on it. `opacity`/`maxHeight` stay inline; both are animated
    // from hover state and one is a pixel number.
    <Card
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="absolute top-3 left-3 px-4 py-3 text-[11px] shadow-[0_2px_8px_rgba(0,0,0,0.06)] overflow-hidden transition-[opacity,max-height] duration-[350ms] ease-[cubic-bezier(0.4,0,0.2,1)]"
      style={{
        opacity: hovered ? 1 : 0.2,
        maxHeight: hovered ? 800 : COLLAPSED_MAX_HEIGHT,
      }}
    >
      <Inline as="div" gap="none" className="font-semibold text-xs mb-2 text-text-primary">
        Departments
      </Inline>
      {departments.map(dept => (
        <Inline
          key={dept.id}
          gap="xs"
          wrap={false}
          onClick={() => onFilter(filter === dept.name ? null : dept.name)}
          className="mb-1 cursor-pointer"
          style={{ opacity: !filter || filter === dept.name ? 1 : 0.4 }}
        >
          <StatusDot color={dept.color} size="sm" />
          <Inline as="span" gap="none">{dept.name}</Inline>
        </Inline>
      ))}

      <Inline as="div" gap="none" className="border-t border-border mt-2 pt-2 flex-col items-stretch">
        <Inline as="div" gap="none" className="font-semibold text-xs mb-1.5">Relationships</Inline>
        {EDGE_TYPES.map(et => (
          <Inline key={et.type} gap="xs" wrap={false} className="mb-[3px]">
            {/* a real line sample — dashed for mentors/reports_to — so the
                legend shows the stroke it is naming, not a coloured square */}
            <svg width={20} height={8}>
              <line
                x1={0} y1={4} x2={20} y2={4}
                stroke={et.color}
                strokeWidth={2}
                strokeDasharray={et.dash ? '4 2' : undefined}
              />
            </svg>
            <Inline as="span" gap="none">{et.label}</Inline>
          </Inline>
        ))}
      </Inline>

      {filter && (
        <Button variant="secondary" size="sm" fullWidth className="mt-2" onClick={() => onFilter(null)}>
          Clear Filter
        </Button>
      )}

      {/* Presence dot legend — only shown when a presence filter is active */}
      {presenceFilter && (
        <Inline as="div" gap="none" className="border-t border-border mt-2 pt-2 flex-col items-stretch">
          <Inline as="div" gap="none" className="font-semibold text-xs mb-[5px]">Presence today</Inline>
          {PRESENCE_LEGEND.map(({ color, label }) => (
            <Inline key={label} gap="xs" wrap={false} className="mb-[3px]">
              <StatusDot color={color} size="xs" />
              <Inline as="span" gap="none">{label}</Inline>
            </Inline>
          ))}
          <Inline gap="xs" wrap={false} className="mb-0.5">
            {/* the WFH ring is a dot PLUS a dashed outline — StatusDot has no
                ring prop, and the outline is the whole point of the entry */}
            <Inline
              as="span"
              gap="none"
              className="w-2 h-2 rounded-full shrink-0 box-border bg-[#3b82f6] outline-2 outline-dashed outline-[#3b82f6] outline-offset-[3px]"
            />
            <Inline as="span" gap="none" className="text-text-tertiary">WFH ring</Inline>
          </Inline>
        </Inline>
      )}
    </Card>
  );
}
