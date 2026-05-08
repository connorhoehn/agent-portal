import { useRef, useEffect, useState, useCallback } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import type { GraphNode, GraphLink, GraphPerson, GraphRelationship, GraphDepartment } from './types';

interface UseForceLayoutProps {
  people: GraphPerson[];
  relationships: GraphRelationship[];
  departments: GraphDepartment[];
  width: number;
  height: number;
}

interface UseForceLayoutReturn {
  nodes: GraphNode[];
  links: Array<{ source: GraphNode; target: GraphNode; type: string; strength: number }>;
  isDone: boolean;
}

export function useForceLayout({ people, relationships, departments, width, height }: UseForceLayoutProps): UseForceLayoutReturn {
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [links, setLinks] = useState<Array<{ source: GraphNode; target: GraphNode; type: string; strength: number }>>([]);
  const [isDone, setIsDone] = useState(false);
  const simRef = useRef<Simulation<GraphNode, SimulationLinkDatum<GraphNode>> | null>(null);

  useEffect(() => {
    if (!people.length || !width || !height) return;

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

    const simLinks: GraphLink[] = relationships
      .filter(r => people.some(p => p.id === r.source) && people.some(p => p.id === r.target))
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

    sim.on('end', () => {
      setIsDone(true);
    });

    simRef.current = sim;

    return () => {
      sim.stop();
    };
  }, [people, relationships, departments, width, height]);

  return { nodes, links, isDone };
}
