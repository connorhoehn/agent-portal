// Node and edge types for the multi-entity graph (Skills / Projects views).

export type MENodeKind = 'person' | 'skill' | 'skill_domain' | 'project' | 'status_group';

export interface MENode {
  id: string;
  kind: MENodeKind;
  label: string;
  // Domain name (skills) or status value (projects), used for clustering
  group?: string;
  // Relative importance — drives node size
  weight: number;
  // Position (set by layout)
  x: number;
  y: number;
  // For force sim
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  // Extra metadata
  department?: string;   // person only
  personCount?: number;  // skill / project only
}

export interface MEEdge {
  source: string;
  target: string;
  type: 'has_skill' | 'contributes_to' | 'belongs_to' | 'in_status';
  strength: number;
}
