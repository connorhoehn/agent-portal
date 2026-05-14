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

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return 'just now';
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}
