export interface ScoreEntry {
  personId: string;
  name: string;
  department: string;
  influence: number;
  collaboration: number;
  expertise: number;
  velocity: number;
  quality: number;
  composite: number;
  trend: number[];
}

function composite(s: Omit<ScoreEntry, 'composite' | 'trend' | 'personId' | 'name' | 'department'>): number {
  return Math.round(((s.influence + s.collaboration + s.expertise + s.velocity + s.quality) / 5) * 100);
}

function trend(): number[] {
  const base = 50 + Math.random() * 30;
  return Array.from({ length: 7 }, (_, i) => Math.round(base + (i * 2) + (Math.random() - 0.5) * 8));
}

export const mockScores: ScoreEntry[] = [
  { personId: 'p-023', name: 'Raj Mehta', department: 'Data Platform', influence: 0.93, collaboration: 0.88, expertise: 0.96, velocity: 0.72, quality: 0.94, composite: 0, trend: [] },
  { personId: 'p-010', name: 'Nina Kowalski', department: 'Product', influence: 0.91, collaboration: 0.78, expertise: 0.72, velocity: 0.85, quality: 0.80, composite: 0, trend: [] },
  { personId: 'p-001', name: 'Alex Chen', department: 'Platform Engineering', influence: 0.89, collaboration: 0.82, expertise: 0.91, velocity: 0.75, quality: 0.88, composite: 0, trend: [] },
  { personId: 'p-020', name: 'Diana Martinez', department: 'Design Systems', influence: 0.88, collaboration: 0.85, expertise: 0.76, velocity: 0.72, quality: 0.90, composite: 0, trend: [] },
  { personId: 'p-011', name: 'Carlos Rivera', department: 'Data Platform', influence: 0.85, collaboration: 0.90, expertise: 0.88, velocity: 0.70, quality: 0.92, composite: 0, trend: [] },
  { personId: 'p-005', name: 'David Kim', department: 'Platform Engineering', influence: 0.82, collaboration: 0.88, expertise: 0.70, velocity: 0.80, quality: 0.75, composite: 0, trend: [] },
  { personId: 'p-015', name: 'Marcus Thompson', department: 'Data Platform', influence: 0.79, collaboration: 0.84, expertise: 0.73, velocity: 0.77, quality: 0.81, composite: 0, trend: [] },
  { personId: 'p-006', name: 'Sarah Johnson', department: 'Product', influence: 0.76, collaboration: 0.80, expertise: 0.68, velocity: 0.82, quality: 0.74, composite: 0, trend: [] },
  { personId: 'p-021', name: 'Ben Foster', department: 'Platform Engineering', influence: 0.74, collaboration: 0.77, expertise: 0.82, velocity: 0.70, quality: 0.85, composite: 0, trend: [] },
  { personId: 'p-002', name: 'Maria Santos', department: 'Platform Engineering', influence: 0.72, collaboration: 0.75, expertise: 0.80, velocity: 0.78, quality: 0.82, composite: 0, trend: [] },
  { personId: 'p-016', name: 'Olivia Park', department: 'Design Systems', influence: 0.71, collaboration: 0.82, expertise: 0.77, velocity: 0.68, quality: 0.86, composite: 0, trend: [] },
  { personId: 'p-004', name: 'Priya Patel', department: 'Platform Engineering', influence: 0.68, collaboration: 0.72, expertise: 0.84, velocity: 0.73, quality: 0.79, composite: 0, trend: [] },
].map(s => ({ ...s, composite: composite(s), trend: trend() }));
