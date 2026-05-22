import { useRef, useEffect, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNode, GraphLink, GraphPerson, GraphRelationship, GraphDepartment } from './types';

export type LayoutMode = 'force' | 'radial';

interface UseForceLayoutProps {
  people: GraphPerson[];
  relationships: GraphRelationship[];
  departments: GraphDepartment[];
  width: number;
  height: number;
  layout?: LayoutMode;
}

interface UseForceLayoutReturn {
  nodes: GraphNode[];
  links: Array<{ source: GraphNode; target: GraphNode; type: string; strength: number }>;
  isDone: boolean;
}

// ── Static layout helpers ────────────────────────────────────────────────────

function buildLinks(
  people: GraphPerson[],
  relationships: GraphRelationship[],
  nodeMap: Map<string, GraphNode>,
): Array<{ source: GraphNode; target: GraphNode; type: string; strength: number }> {
  const result: Array<{ source: GraphNode; target: GraphNode; type: string; strength: number }> = [];
  for (const r of relationships) {
    const s = nodeMap.get(r.source);
    const t = nodeMap.get(r.target);
    if (s && t) result.push({ source: s, target: t, type: r.type, strength: r.strength });
  }
  return result;
}

function radialNodes(people: GraphPerson[], width: number, height: number): GraphNode[] {
  if (people.length === 0) return [];
  const sorted = [...people].sort((a, b) => b.influenceScore - a.influenceScore);
  const cx = width / 2, cy = height / 2;
  // Capacity and radius sized so arc-per-node stays > ~80px (avoids label collisions).
  const ringCapacity = [1, 7, 12, 17, 22, 27, 32];
  const ringRadius  = [0, 130, 240, 350, 460, 570, 680];
  const nodes: GraphNode[] = [];
  let idx = 0;
  for (let r = 0; r < ringCapacity.length && idx < sorted.length; r++) {
    const cap = ringCapacity[r];
    const radius = ringRadius[r];
    const count = Math.min(cap, sorted.length - idx);
    for (let i = 0; i < count; i++, idx++) {
      const angle = count === 1 ? -Math.PI / 2 : (i / count) * 2 * Math.PI - Math.PI / 2;
      nodes.push({ ...sorted[idx], x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    }
  }
  // Overflow: keep adding rings at +80px each
  let overflowRing = 0;
  while (idx < sorted.length) {
    const radius = ringRadius[ringRadius.length - 1] + (overflowRing + 1) * 80;
    const cap = Math.floor((2 * Math.PI * radius) / 90);
    const count = Math.min(cap, sorted.length - idx);
    for (let i = 0; i < count && idx < sorted.length; i++, idx++) {
      const angle = (i / cap) * 2 * Math.PI - Math.PI / 2;
      nodes.push({ ...sorted[idx], x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
    }
    overflowRing++;
  }
  return nodes;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useForceLayout({ people, relationships, departments, width, height, layout = 'force' }: UseForceLayoutProps): UseForceLayoutReturn {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<Array<{ source: GraphNode; target: GraphNode; type: string; strength: number }>>([]);
  const [isDone, setIsDone] = useState(false);
  const simRef = useRef<Simulation<GraphNode, SimulationLinkDatum<GraphNode>> | null>(null);

  useEffect(() => {
    if (!people.length || !width || !height) return;

    // Stop any running force simulation before switching layouts.
    simRef.current?.stop();
    simRef.current = null;

    if (layout === 'radial') {
      const staticNodes = radialNodes(people, width, height);
      const nodeMap = new Map(staticNodes.map(n => [n.id, n]));
      setNodes(staticNodes);
      setLinks(buildLinks(people, relationships, nodeMap));
      setIsDone(true);
      return;
    }

    // Force layout (default)
    setIsDone(false);
    const deptCenters = new Map<string, { x: number; y: number }>();
    const cols = Math.ceil(Math.sqrt(departments.length));
    departments.forEach((dept, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      deptCenters.set(dept.name, {
        x: (col + 0.5) * (width / cols),
        y: (row + 0.5) * (height / Math.ceil(departments.length / cols)),
      });
    });

    const simNodes: GraphNode[] = people.map(p => {
      const center = deptCenters.get(p.department) ?? { x: width / 2, y: height / 2 };
      return {
        ...p,
        x: center.x + (Math.random() - 0.5) * 100,
        y: center.y + (Math.random() - 0.5) * 100,
      };
    });

    const peopleIds = new Set(people.map(p => p.id));

    const simLinks: GraphLink[] = relationships
      .filter(r => peopleIds.has(r.source) && peopleIds.has(r.target))
      .map(r => ({ source: r.source, target: r.target, type: r.type, strength: r.strength }));

    const sim = forceSimulation<GraphNode>(simNodes)
      .force('link', forceLink<GraphNode, SimulationLinkDatum<GraphNode>>(simLinks as any)
        .id((d: any) => d.id)
        .distance(80)
        .strength((d: any) => d.strength * 0.3))
      .force('charge', forceManyBody<GraphNode>().strength(-200))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide<GraphNode>().radius(d => 15 + d.influenceScore * 20))
      .force('x', forceX<GraphNode>().x(d => deptCenters.get(d.department)?.x ?? width / 2).strength(0.1))
      .force('y', forceY<GraphNode>().y(d => deptCenters.get(d.department)?.y ?? height / 2).strength(0.1))
      .alpha(1)
      .alphaDecay(0.02);

    sim.on('tick', () => {
      setNodes([...simNodes]);
      setLinks(simLinks.map(l => ({
        source: l.source as GraphNode,
        target: l.target as GraphNode,
        type: l.type,
        strength: l.strength,
      })));
    });

    sim.on('end', () => setIsDone(true));

    simRef.current = sim;
    return () => { sim.stop(); };
  }, [people, relationships, departments, width, height, layout]);

  return { nodes, links, isDone };
}
