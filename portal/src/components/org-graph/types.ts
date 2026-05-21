export type PresenceStatus =
  | 'office'    // physically in the building
  | 'wfh'       // remote / work from home
  | 'travel'    // on-site at customer / conference
  | 'pto'       // paid time off (short)
  | 'vacation'  // extended away
  | 'sick'      // out sick
  | 'unknown';  // no check-in today

export interface GraphPerson {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  /** Today's presence status. Absent means the API did not return one (treat as unknown). */
  presence?: PresenceStatus;
}

export interface GraphRelationship {
  source: string;
  target: string;
  type: 'collaborates' | 'mentors' | 'reports_to' | 'expert_in_common';
  strength: number;
}

export interface GraphDepartment {
  id: string;
  name: string;
  color: string;
}

export interface GraphNode extends GraphPerson {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface GraphLink {
  source: GraphNode | string;
  target: GraphNode | string;
  type: string;
  strength: number;
}
