export interface ScoreEntry {
  personId: string;
  name: string;
  department: string;
  influence: number;
  expertise: number;
  composite: number;
  scoredAt: string | null;
}

export interface PersonDetail {
  id: string;
  name: string;
  title: string;
  department: string;
  skills: string[];
  influenceScore: number;
  scoredAt: string | null;
  connections: Array<{
    source: string;
    target: string;
    type: string;
    strength: number;
    otherPerson: { id: string; name: string; title: string } | null;
  }>;
}

export const DEPT_COLORS: Record<string, string> = {
  'Platform Engineering': '#2563eb',
  'Product': '#16a34a',
  'Data Platform': '#9333ea',
  'Design Systems': '#ea580c',
  'ML / AI': '#dc2626',
  'Security': '#0891b2',
};

