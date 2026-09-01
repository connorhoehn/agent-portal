// "How are these two people connected at all?" — a BFS over the org graph.
//
// Pure: people + edges in, hops out. Lifted out of ExplorePanels.tsx so the
// traversal can be reasoned about (and unit-tested) without a React tree.

import type { GraphPerson, GraphRelationship } from './types';

export interface PathHop {
  person: GraphPerson;
  /** Edge type connecting this person to the PREVIOUS hop (empty for hop 0). */
  viaType: string;
}

export const PATH_TYPE_LABELS: Record<string, string> = {
  collaborates: 'collaborates with',
  mentors: 'mentors',
  reports_to: 'reports to',
  expert_in_common: 'shares expertise with',
};

/**
 * Shortest path between two people over the full (unfiltered) edge set —
 * paths are allowed to cross relationship types the current view hides,
 * because "how are these two connected at all?" is the actual question.
 */
export function findConnectionPath(
  people: GraphPerson[],
  edges: GraphRelationship[],
  fromId: string,
  toId: string,
): PathHop[] | null {
  if (fromId === toId) return null;
  const byId = new Map(people.map((p) => [p.id, p]));
  if (!byId.has(fromId) || !byId.has(toId)) return null;

  const adj = new Map<string, Array<{ other: string; type: string }>>();
  const link = (from: string, other: string, type: string) => {
    const list = adj.get(from);
    if (list) list.push({ other, type });
    else adj.set(from, [{ other, type }]);
  };
  for (const e of edges) {
    link(e.source, e.target, e.type);
    link(e.target, e.source, e.type);
  }

  const prev = new Map<string, { from: string; type: string }>();
  const seen = new Set<string>([fromId]);
  let frontier = [fromId];
  let found = false;

  while (frontier.length > 0 && !found) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const { other, type } of adj.get(id) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        prev.set(other, { from: id, type });
        if (other === toId) { found = true; break; }
        next.push(other);
      }
      if (found) break;
    }
    frontier = next;
  }
  if (!found) return null;

  // Walk back from target to source.
  const hops: PathHop[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const p = prev.get(cursor)!;
    hops.unshift({ person: byId.get(cursor)!, viaType: p.type });
    cursor = p.from;
  }
  hops.unshift({ person: byId.get(fromId)!, viaType: '' });
  return hops;
}
