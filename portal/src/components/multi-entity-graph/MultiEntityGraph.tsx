// Multi-entity graph — renders people (circles) alongside skill nodes (hexagons
// with domain parents) and project nodes (rounded squares with status groups).
//
// Uses d3-force with taxonomy anchor nodes fixed at the ring positions so
// children cluster naturally around their parent.

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type SimulationLinkDatum,
} from 'd3-force';
import type { MENode, MEEdge } from './types';
import { Button, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

// ── Department colour palette (matches OrgGraph) ────────────────────────────

const DEPT_COLORS: Record<string, string> = {
  'Platform Engineering': '#3b82f6',
  'Data Platform': '#22c55e',
  'Product': '#a855f7',
  'Design Systems': '#f97316',
  'ML / AI': '#ef4444',
  'Security': '#14b8a6',
};
function deptColor(dept: string | undefined): string {
  return dept ? (DEPT_COLORS[dept] ?? '#6366f1') : '#6366f1';
}

// Domain → hue for skills
const DOMAIN_HUES: Record<string, string> = {
  'Programming': '#6366f1',
  'Data': '#0ea5e9',
  'Infrastructure': '#f59e0b',
  'Design': '#ec4899',
  'Management': '#14b8a6',
  'Analytics': '#22c55e',
  'Security': '#ef4444',
  'General': '#94a3b8',
};
function domainColor(domain: string | undefined): string {
  return domain ? (DOMAIN_HUES[domain] ?? '#94a3b8') : '#94a3b8';
}

// Status → hue for projects
const STATUS_COLORS: Record<string, string> = {
  active: '#22c55e',
  in_progress: '#22c55e',
  planning: '#3b82f6',
  archived: '#94a3b8',
};
const STATUS_LABELS: Record<string, string> = {
  in_progress: 'In Progress',
  planning: 'Planning',
  active: 'Active',
  archived: 'Archived',
};
function statusColor(status: string | undefined): string {
  return status ? (STATUS_COLORS[status] ?? '#94a3b8') : '#94a3b8';
}
function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? (status.charAt(0).toUpperCase() + status.slice(1));
}

// ── Node renderers ───────────────────────────────────────────────────────────

function hexPath(cx: number, cy: number, r: number): string {
  const pts = Array.from({ length: 6 }, (_, i) => {
    const a = (i * Math.PI) / 3 - Math.PI / 6;
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  });
  return `M${pts.join('L')}Z`;
}

function roundedRect(cx: number, cy: number, w: number, h: number, r: number): string {
  const x = cx - w / 2, y = cy - h / 2;
  return `M${x + r},${y} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 -${r},${r} h-${w - 2 * r} a${r},${r} 0 0 1 -${r},-${r} v-${h - 2 * r} a${r},${r} 0 0 1 ${r},-${r}Z`;
}

interface NodeProps {
  node: MENode;
  isHighlighted: boolean;
  isSelected: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
}

function MENodeElement({ node, isHighlighted, isSelected, onSelect, onHover }: NodeProps) {
  const dim = !isHighlighted ? 0.25 : 1;
  const strokeW = isSelected ? 2 : 1;

  if (node.kind === 'skill_domain') {
    const r = 26 + node.weight * 8;
    const fill = domainColor(node.group);
    return (
      <g transform={`translate(${node.x},${node.y})`} opacity={dim}
        onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}>
        <path d={hexPath(0, 0, r)} fill={fill} fillOpacity={0.10} stroke={fill} strokeWidth={1.5} strokeDasharray="5 3" />
        <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight={700} fill={fill}>{node.label}</text>
      </g>
    );
  }

  if (node.kind === 'skill') {
    const r = 10 + node.weight * 7;
    const fill = domainColor(node.group);
    return (
      <g transform={`translate(${node.x},${node.y})`} opacity={dim} cursor="pointer"
        onClick={() => onSelect(node.id)}
        onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}>
        <path d={hexPath(0, 0, r)} fill={fill} fillOpacity={0.22} stroke={fill} strokeWidth={strokeW} />
        <text y={r + 10} textAnchor="middle" fontSize={9} fill={fill} fontWeight={500}>{node.label}</text>
      </g>
    );
  }

  if (node.kind === 'status_group') {
    const label = node.label;
    const w = Math.max(88, label.length * 7 + 24), h = 32;
    const fill = statusColor(node.group);
    return (
      <g transform={`translate(${node.x},${node.y})`} opacity={dim}
        onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}>
        <path d={roundedRect(0, 0, w, h, 7)} fill={fill} fillOpacity={0.08} stroke={fill} strokeWidth={2} strokeDasharray="6 3" />
        <text textAnchor="middle" dominantBaseline="middle" fontSize={11} fontWeight={700} fill={fill}>{label}</text>
      </g>
    );
  }

  if (node.kind === 'project') {
    const w = Math.max(80, node.label.length * 6.2 + 24), h = 32;
    const fill = statusColor(node.group);
    const isHov = isHighlighted && !isSelected;
    return (
      <g transform={`translate(${node.x},${node.y})`} opacity={dim} cursor="pointer"
        onClick={() => onSelect(node.id)}
        onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}>
        {isSelected && (
          <path d={roundedRect(0, 0, w + 6, h + 6, 8)}
            fill="none" stroke={fill} strokeWidth={2} opacity={0.6} />
        )}
        <path d={roundedRect(0, 0, w, h, 6)}
          fill={fill} fillOpacity={isSelected ? 0.35 : isHov ? 0.22 : 0.13}
          stroke={fill} strokeWidth={isSelected ? 2.5 : strokeW} />
        <text textAnchor="middle" dominantBaseline="middle" fontSize={10} fill={fill} fontWeight={600}>{node.label}</text>
        {node.personCount !== undefined && (
          <text x={w / 2 - 4} y={-h / 2 + 9} textAnchor="end" fontSize={8} fill={fill} opacity={0.65}>{node.personCount}p</text>
        )}
      </g>
    );
  }

  // person — small dot, label only on hover/selected
  const r = 6 + node.weight * 5;
  const fill = deptColor(node.department);
  const showLabel = isSelected || isHighlighted;
  return (
    <g transform={`translate(${node.x},${node.y})`} opacity={dim} cursor="pointer"
      onClick={() => onSelect(node.id)}
      onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)}>
      <circle r={r} fill={fill} fillOpacity={isSelected ? 0.55 : 0.25} stroke={fill} strokeWidth={isSelected ? 1.5 : 0.8} />
      {showLabel && (
        <text y={r + 10} textAnchor="middle" fontSize={9} fill={fill} fontWeight={isSelected ? 600 : 400}
          className="pointer-events-none">{node.label}</text>
      )}
    </g>
  );
}

// ── Layout ───────────────────────────────────────────────────────────────────

type SimNode = MENode & { _fixed?: boolean };
type SimLink = { source: SimNode; target: SimNode; type: MEEdge['type']; strength: number };

// Deterministic sub-ring: place `count` items in an arc centred on `parentAngle`
// at radius `r` from canvas centre.
function subRingPos(
  cx: number, cy: number, r: number,
  parentAngle: number, i: number, count: number,
  spread = Math.PI * 0.55,
): { x: number; y: number } {
  const step = count <= 1 ? 0 : spread / (count - 1);
  const a = parentAngle - spread / 2 + i * step;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function useLayout(nodes: MENode[], edges: MEEdge[], width: number, height: number, maxEdgesPerPerson: number) {
  const [simNodes, setSimNodes] = useState<SimNode[]>([]);
  const [simLinks, setSimLinks] = useState<SimLink[]>([]);

  useEffect(() => {
    if (!nodes.length || !width || !height) return;

    const cx = width / 2, cy = height / 2;
    const R_anchor = Math.min(width, height) * 0.40;  // anchor (domain/status) ring
    const R_child  = Math.min(width, height) * 0.22;  // skill/project ring radius from anchor

    // ── Anchor positions ────────────────────────────────────────────────────
    const anchorIds = new Set(
      nodes.filter(n => n.kind === 'skill_domain' || n.kind === 'status_group').map(n => n.id),
    );
    const anchors = nodes.filter(n => anchorIds.has(n.id));
    const anchorAngle = new Map<string, number>();
    const anchorPositions = new Map<string, { x: number; y: number }>();
    anchors.forEach((a, i) => {
      const angle = (i / Math.max(anchors.length, 1)) * 2 * Math.PI - Math.PI / 2;
      anchorAngle.set(a.id, angle);
      anchorPositions.set(a.id, { x: cx + R_anchor * Math.cos(angle), y: cy + R_anchor * Math.sin(angle) });
    });

    // ── Parent map ──────────────────────────────────────────────────────────
    // skill/project → anchor id
    const parentOf = new Map<string, string>();
    for (const e of edges) {
      if (e.type === 'belongs_to' || e.type === 'in_status') parentOf.set(e.source, e.target);
    }

    // ── Child positions: place skill/project nodes in sub-arc around parent ─
    const childrenByAnchor = new Map<string, string[]>();
    for (const [childId, anchorId] of parentOf) {
      const arr = childrenByAnchor.get(anchorId) ?? [];
      arr.push(childId);
      childrenByAnchor.set(anchorId, arr);
    }
    const childPositions = new Map<string, { x: number; y: number }>();
    for (const [anchorId, children] of childrenByAnchor) {
      const aPos = anchorPositions.get(anchorId)!;
      const aAngle = anchorAngle.get(anchorId) ?? 0;
      children.forEach((cid, i) => {
        const pos = subRingPos(aPos.x, aPos.y, R_child, aAngle, i, children.length);
        childPositions.set(cid, pos);
      });
    }

    // ── TopK: limit person→skill/project edges to strongest K per person ───
    const personEdges = edges.filter(e => e.type === 'has_skill' || e.type === 'contributes_to');
    const edgesByPerson = new Map<string, typeof personEdges>();
    for (const e of personEdges) {
      const arr = edgesByPerson.get(e.source) ?? [];
      arr.push(e);
      edgesByPerson.set(e.source, arr);
    }
    const keptPersonEdgeSet = new Set<string>();
    for (const [, pEdges] of edgesByPerson) {
      pEdges.sort((a, b) => b.strength - a.strength).slice(0, maxEdgesPerPerson).forEach(e => {
        keptPersonEdgeSet.add(`${e.source}→${e.target}`);
      });
    }

    // ── Person initial positions ────────────────────────────────────────────
    const personTargets = new Map<string, string[]>(); // person → [skill/project ids, top-K only]
    for (const e of personEdges) {
      if (!keptPersonEdgeSet.has(`${e.source}→${e.target}`)) continue;
      const arr = personTargets.get(e.source) ?? [];
      arr.push(e.target);
      personTargets.set(e.source, arr);
    }

    // ── Build sim nodes ─────────────────────────────────────────────────────
    const sn: SimNode[] = nodes.map(n => {
      if (anchorIds.has(n.id)) {
        const pos = anchorPositions.get(n.id) ?? { x: cx, y: cy };
        return { ...n, x: pos.x, y: pos.y, fx: pos.x, fy: pos.y };
      }
      if (childPositions.has(n.id)) {
        const pos = childPositions.get(n.id)!;
        return { ...n, x: pos.x + (Math.random() - 0.5) * 30, y: pos.y + (Math.random() - 0.5) * 30 };
      }
      if (n.kind === 'person') {
        const targets = personTargets.get(n.id);
        if (targets && targets.length > 0) {
          let ax = 0, ay = 0, cnt = 0;
          for (const tid of targets) {
            const pos = childPositions.get(tid);
            if (pos) { ax += pos.x; ay += pos.y; cnt++; }
          }
          if (cnt > 0) return { ...n, x: ax / cnt + (Math.random() - 0.5) * 50, y: ay / cnt + (Math.random() - 0.5) * 50 };
        }
      }
      return { ...n, x: cx + (Math.random() - 0.5) * 120, y: cy + (Math.random() - 0.5) * 120 };
    });

    // ── Build sim links (only top-K person edges + taxonomy for grouping) ───
    const nodeMap = new Map(sn.map(n => [n.id, n]));
    const allSimEdges = edges.filter(e =>
      e.type === 'belongs_to' || e.type === 'in_status' ||
      keptPersonEdgeSet.has(`${e.source}→${e.target}`),
    );
    const sl = allSimEdges.map(e => {
      const s = nodeMap.get(e.source);
      const t = nodeMap.get(e.target);
      if (!s || !t) return null;
      return { source: s, target: t, type: e.type, strength: e.strength };
    }).filter(Boolean) as SimLink[];

    // ── Force simulation ────────────────────────────────────────────────────
    const sim = forceSimulation<SimNode>(sn)
      .force('link', forceLink<SimNode, SimulationLinkDatum<SimNode>>(sl as any)
        .id(d => d.id)
        .distance(d => (d as any).type === 'belongs_to' || (d as any).type === 'in_status' ? 0 : 55)
        .strength(d => {
          const t = (d as any).type;
          if (t === 'belongs_to' || t === 'in_status') return 0.8;
          return (d as any).strength * 0.25;
        }))
      .force('charge', forceManyBody<SimNode>().strength(n => {
        if (anchorIds.has(n.id)) return 0;
        if (n.kind === 'skill' || n.kind === 'project') return -180;
        return -90; // person
      }))
      .force('collide', forceCollide<SimNode>().radius(n => {
        if (n.kind === 'person') return 9 + n.weight * 5;
        if (n.kind === 'skill') return 14 + n.weight * 7;
        if (n.kind === 'project') return 44;
        return 5; // anchors — don't collide
      }).strength(0.9))
      // Pull non-anchor nodes gently toward canvas centre to prevent runaway
      .force('center', forceCenter(cx, cy).strength(0.01))
      .alpha(1).alphaDecay(0.022);

    sim.on('tick', () => {
      setSimNodes([...sn]);
      setSimLinks(sl.map(l => ({ ...l, source: l.source as SimNode, target: l.target as SimNode })));
    });

    return () => { sim.stop(); };
  }, [nodes, edges, width, height, maxEdgesPerPerson]);

  return { simNodes, simLinks };
}

// ── Main component ───────────────────────────────────────────────────────────

interface MultiEntityGraphProps {
  nodes: MENode[];
  edges: MEEdge[];
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
  maxEdgesPerPerson?: number;
}

export function MultiEntityGraph({ nodes, edges, selectedIds, onToggleSelect, maxEdgesPerPerson = 4 }: MultiEntityGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const obs = new ResizeObserver(e => {
      const r = e[0];
      if (r) setDimensions({ width: r.contentRect.width, height: r.contentRect.height });
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const { simNodes, simLinks } = useLayout(nodes, edges, dimensions.width, dimensions.height, maxEdgesPerPerson);

  const connectedIds = useCallback((id: string | null) => {
    if (!id) return new Set<string>();
    const s = new Set([id]);
    simLinks.forEach(l => {
      if (l.source.id === id) s.add(l.target.id);
      if (l.target.id === id) s.add(l.source.id);
    });
    return s;
  }, [simLinks]);

  // Hover OR selection drives highlighting — show connected neighbourhood.
  const activeHighlightId = hoveredId ?? (selectedIds && selectedIds.size === 1 ? Array.from(selectedIds)[0] : null);
  const highlighted = activeHighlightId ? connectedIds(activeHighlightId) : null;

  const handleSelect = useCallback((id: string) => onToggleSelect?.(id), [onToggleSelect]);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setTransform(t => ({ ...t, scale: Math.max(0.3, Math.min(3, t.scale * (e.deltaY > 0 ? 0.9 : 1.1))) }));
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

  const handleMouseUp = useCallback(() => setIsPanning(false), []);

  return (
    <Stack ref={containerRef} gap="none" className="w-full h-full relative overflow-hidden bg-surface">
      <svg
        width={dimensions.width} height={dimensions.height}
        onWheel={handleWheel} onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove} onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        className={isPanning ? 'cursor-grabbing' : 'cursor-grab'}
      >
        <defs>
          <marker id="me-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6Z" fill="var(--color-border,#e2e8f0)" />
          </marker>
        </defs>
        <g transform={`translate(${transform.x},${transform.y}) scale(${transform.scale})`}>
          {simLinks.map((link) => {
            const dimLink = highlighted && !highlighted.has(link.source.id) && !highlighted.has(link.target.id);
            const isTaxonomy = link.type === 'belongs_to' || link.type === 'in_status';
            const sourceId = typeof link.source === 'object' ? link.source.id : link.source;
            const targetId = typeof link.target === 'object' ? link.target.id : link.target;
            return (
              <line
                key={`${sourceId}-${targetId}-${link.type}`}
                x1={link.source.x} y1={link.source.y}
                x2={link.target.x} y2={link.target.y}
                stroke="#94a3b8"
                strokeWidth={isTaxonomy ? 0.8 : link.strength * 1.2 + 0.4}
                strokeDasharray={isTaxonomy ? '4 4' : undefined}
                opacity={dimLink ? 0.08 : (isTaxonomy ? 0.2 : 0.22)}
              />
            );
          })}
          {simNodes.map((node) => {
            const isH = highlighted ? highlighted.has(node.id) : true;
            const isSel = selectedIds?.has(node.id) ?? false;
            return (
              <MENodeElement
                key={node.id}
                node={node}
                isHighlighted={isH}
                isSelected={isSel}
                onSelect={handleSelect}
                onHover={setHoveredId}
              />
            );
          })}
        </g>
      </svg>
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

// Same as the org-graph controls: square and icon-sized, and the `bg-white`
// that used to be here went with the raw <button> — Button paints bg-surface,
// so these no longer stay white in dark mode. aria-labels because "+" alone
// says nothing to a screen reader.
const zoomBtnClass = 'w-8 h-8 p-0 justify-center text-base';
