import { useState, useRef, useCallback, useEffect } from 'react';
import { useForceLayout } from './useForceLayout';
import { OrgGraphNode } from './OrgGraphNode';
import { OrgGraphEdge } from './OrgGraphEdge';
import { OrgGraphTooltip } from './OrgGraphTooltip';
import { OrgGraphLegend } from './OrgGraphLegend';
import type { GraphPerson, GraphRelationship, GraphDepartment, GraphNode as GNode } from './types';

interface OrgGraphProps {
  people: GraphPerson[];
  relationships: GraphRelationship[];
  departments: GraphDepartment[];
  onPersonSelect?: (person: GraphPerson | null) => void;
}

export function OrgGraph({ people, relationships, departments, onPersonSelect }: OrgGraphProps) {
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
  });

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
  const highlighted = connectedIds(activeId);

  const handleSelect = useCallback((id: string) => {
    const newId = selectedId === id ? null : id;
    setSelectedId(newId);
    const person = people.find(p => p.id === newId);
    onPersonSelect?.(person ?? null);
  }, [selectedId, people, onPersonSelect]);

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
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', background: 'var(--color-surface, #fff)' }}
    >
      <svg
        width={dimensions.width}
        height={dimensions.height}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
      >
        <g transform={`translate(${transform.x}, ${transform.y}) scale(${transform.scale})`}>
          {links.map((link, i) => (
            <OrgGraphEdge
              key={i}
              source={link.source}
              target={link.target}
              type={link.type}
              strength={link.strength}
              isHighlighted={!activeId || highlighted.has(link.source.id) && highlighted.has(link.target.id)}
            />
          ))}
          {nodes.map(node => (
            <OrgGraphNode
              key={node.id}
              node={node}
              departments={departments}
              isSelected={selectedId === node.id}
              isHighlighted={!activeId || highlighted.has(node.id)}
              onSelect={handleSelect}
              onHover={setHoveredId}
            />
          ))}
        </g>
      </svg>

      <OrgGraphLegend departments={departments} filter={deptFilter} onFilter={setDeptFilter} />

      {hoveredNode && (
        <OrgGraphTooltip
          node={hoveredNode}
          departments={departments}
          containerRect={containerRef.current?.getBoundingClientRect() ?? null}
        />
      )}

      <div style={{
        position: 'absolute',
        bottom: 12,
        right: 12,
        display: 'flex',
        gap: 4,
      }}>
        <button
          onClick={() => setTransform(t => ({ ...t, scale: Math.min(3, t.scale * 1.2) }))}
          style={zoomBtnStyle}
        >+</button>
        <button
          onClick={() => setTransform(t => ({ ...t, scale: Math.max(0.3, t.scale * 0.8) }))}
          style={zoomBtnStyle}
        >−</button>
        <button
          onClick={() => setTransform({ x: 0, y: 0, scale: 1 })}
          style={zoomBtnStyle}
        >⟲</button>
      </div>
    </div>
  );
}

const zoomBtnStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'white',
  border: '1px solid var(--color-border, #e2e8f0)',
  borderRadius: 6,
  fontSize: 16,
  cursor: 'pointer',
  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
};
