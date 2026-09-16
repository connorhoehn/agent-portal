import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useForceLayout, type LayoutMode } from './useForceLayout';
import { OrgGraphNode } from './OrgGraphNode';
import { OrgGraphEdge } from './OrgGraphEdge';
import { OrgGraphTooltip } from './OrgGraphTooltip';
import { OrgGraphLegend } from './OrgGraphLegend';
import type { GraphPerson, GraphRelationship, GraphDepartment, GraphNode as GNode } from './types';
import { degreeMap as buildDegreeMap, maxDegree as maxOfDegreeMap } from './graphInsights';
import { Button, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

interface OrgGraphProps {
  people: GraphPerson[];
  relationships: GraphRelationship[];
  departments: GraphDepartment[];
  onPersonSelect?: (person: GraphPerson | null) => void;
  /** Optional multi-select mode. When provided, clicking toggles IDs in this set. */
  multiSelectIds?: Set<string>;
  onToggleMultiSelect?: (id: string) => void;
  /** Optional ID set to apply a "spotlight" visual highlight (e.g. agent-cited nodes). */
  spotlightIds?: Set<string>;
  /** Layout algorithm to use. Defaults to 'force'. */
  layout?: LayoutMode;
  /** Presence filter — dims nodes that don't match. null/undefined = no filter. */
  presenceFilter?: 'office' | 'remote' | 'away' | null;
  /** True only for roles allowed to see influence (org-leader/hr-admin/admin)
   *  — sizes nodes by influence. Everyone else sizes by connection count so a
   *  bigger circle can't leak a number the tooltip and detail card hide. */
  showInfluence?: boolean;
}

export function OrgGraph({
  people,
  relationships,
  departments,
  onPersonSelect,
  multiSelectIds,
  onToggleMultiSelect,
  spotlightIds,
  layout,
  presenceFilter,
  showInfluence = false,
}: OrgGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [deptFilter, setDeptFilter] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const obs = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) {
        setDimensions({ width: entry.contentRect.width, height: entry.contentRect.height });
      }
    });
    obs.observe(container);
    return () => obs.disconnect();
  }, []);

  const filteredPeople = deptFilter ? people.filter(p => p.department === deptFilter) : people;
  const filteredRels = deptFilter
    ? relationships.filter(r =>
        filteredPeople.some(p => p.id === r.source) && filteredPeople.some(p => p.id === r.target))
    : relationships;

  const { nodes, links } = useForceLayout({
    people: filteredPeople,
    relationships: filteredRels,
    departments,
    width: dimensions.width,
    height: dimensions.height,
    layout,
  });

  // Degree in the graph currently on screen — the size signal for roles that
  // may not see influence (see graphInsights.ts's node-sizing section).
  const degrees = useMemo(
    () => buildDegreeMap(links.map(l => ({ source: l.source.id, target: l.target.id }))),
    [links],
  );
  const maxDeg = useMemo(() => maxOfDegreeMap(degrees), [degrees]);

  const connectedIds = useCallback((id: string | null): Set<string> => {
    if (!id) return new Set();
    const set = new Set<string>([id]);
    links.forEach(l => {
      if (l.source.id === id) set.add(l.target.id);
      if (l.target.id === id) set.add(l.source.id);
    });
    return set;
  }, [links]);

  const activeId = hoveredId ?? selectedId;
  // When spotlight is active (agent cited nodes), use that as the highlight set
  // rather than the hover/selection neighborhood — the page is telling us which
  // people matter for this view.
  const spotlightActive = spotlightIds && spotlightIds.size > 0;
  const highlighted = spotlightActive
    ? new Set([...(spotlightIds ?? []), ...Array.from(connectedIds(activeId))])
    : connectedIds(activeId);

  const handleSelect = useCallback((id: string) => {
    if (onToggleMultiSelect) {
      onToggleMultiSelect(id);
      return;
    }
    const newId = selectedId === id ? null : id;
    setSelectedId(newId);
    const person = people.find(p => p.id === newId);
    onPersonSelect?.(person ?? null);
  }, [selectedId, people, onPersonSelect, onToggleMultiSelect]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setTransform(t => ({ ...t, scale: Math.max(0.3, Math.min(3, t.scale * delta)) }));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget || (e.target as Element).tagName === 'svg') {
      setIsPanning(true);
      panStart.current = { x: e.clientX - transform.x, y: e.clientY - transform.y };
    }
  }, [transform]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning) return;
    setTransform(t => ({ ...t, x: e.clientX - panStart.current.x, y: e.clientY - panStart.current.y }));
  }, [isPanning]);

  const handleMouseUp = useCallback(() => {
    setIsPanning(false);
  }, []);

  const hoveredNode = hoveredId ? nodes.find(n => n.id === hoveredId) : null;

  return (
    <Stack
      ref={containerRef}
      gap="none"
      className="w-full h-full relative overflow-hidden bg-surface"
    >
      <svg
        width={dimensions.width}
        height={dimensions.height}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className={isPanning ? 'cursor-grabbing' : 'cursor-grab'}
      >
        <defs>
          <marker id="org-arrow-reports" markerWidth="14" markerHeight="10" refX="13" refY="5" orient="auto" markerUnits="userSpaceOnUse">
            <path d="M0,0 L14,5 L0,10 Z" fill="#64748b" />
          </marker>
        </defs>
        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
          {links.map((link) => {
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            return (
              <OrgGraphEdge
                key={`${sourceId}-${targetId}-${link.type}`}
                source={link.source}
                target={link.target}
                type={link.type}
                strength={link.strength}
                isHighlighted={!activeId || highlighted.has(link.source.id) && highlighted.has(link.target.id)}
              />
            );
          })}
          {nodes.map(node => {
            const isSelected = multiSelectIds
              ? multiSelectIds.has(node.id)
              : selectedId === node.id;
            const isHighlighted = spotlightActive
              ? highlighted.has(node.id)
              : !activeId || highlighted.has(node.id);
            return (
              <OrgGraphNode
                key={node.id}
                node={node}
                departments={departments}
                isSelected={isSelected}
                isHighlighted={isHighlighted}
                onSelect={handleSelect}
                onHover={setHoveredId}
                presenceFilter={presenceFilter}
                showInfluence={showInfluence}
                degree={degrees.get(node.id) ?? 0}
                maxDegree={maxDeg}
              />
            );
          })}
        </g>
      </svg>

      <OrgGraphLegend departments={departments} filter={deptFilter} onFilter={setDeptFilter} presenceFilter={presenceFilter} />

      {hoveredNode && (
        <OrgGraphTooltip
          node={hoveredNode}
          departments={departments}
          containerRect={containerRef.current?.getBoundingClientRect() ?? null}
        />
      )}

      <Inline gap="xs" wrap={false} className="absolute bottom-3 right-3">
        <Button variant="secondary" size="sm" aria-label="Zoom in" className={zoomBtnClass}
          onClick={() => setTransform(t => ({ ...t, scale: Math.min(3, t.scale * 1.2) }))}>+</Button>
        <Button variant="secondary" size="sm" aria-label="Zoom out" className={zoomBtnClass}
          onClick={() => setTransform(t => ({ ...t, scale: Math.max(0.3, t.scale * 0.8) }))}>−</Button>
        <Button variant="secondary" size="sm" aria-label="Reset view" className={zoomBtnClass}
          onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}>⟲</Button>
      </Inline>
    </Stack>
  );
}

// Square, icon-sized. The `bg-white` these carried is gone with the raw
// <button>: Button paints `bg-surface`, so the controls no longer stay white in
// dark mode. They also gained aria-labels — "+" alone told a screen reader
// nothing.
const zoomBtnClass = 'w-8 h-8 p-0 justify-center text-base';
