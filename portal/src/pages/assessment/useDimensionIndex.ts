// Dimension titles, two-track certification and evidence for a set of teams,
// keyed team → dimension id. The feedback queue's rows carry only a
// `dimension_id` ("4"); the name, the claim, what verification reached and
// the evidence behind it all live on `GET /api/assessment/teams/:id`, so the
// queue reads the detail of every team it lists — a handful of calls, cached
// for the page's life.
import { useEffect, useState } from 'react';
import type { Dimension, TeamDetailResponse } from './types';

export type DimensionIndex = Map<string, Map<string, Dimension>>;

export function useDimensionIndex(teamIds: string[]): { index: DimensionIndex; loading: boolean } {
  const [index, setIndex] = useState<DimensionIndex>(() => new Map());
  const [loading, setLoading] = useState(false);
  const key = teamIds.slice().sort().join(',');

  useEffect(() => {
    const missing = teamIds.filter((id) => !index.has(id));
    if (missing.length === 0) return;
    let cancelled = false;
    setLoading(true);
    Promise.all(missing.map(async (id) => {
      const res = await fetch(`/api/assessment/teams/${encodeURIComponent(id)}`, { credentials: 'include' });
      if (!res.ok) return [id, new Map<string, Dimension>()] as const;
      const body = (await res.json()) as TeamDetailResponse;
      return [id, new Map(body.dimensions.map((d) => [d.id, d]))] as const;
    })).then((pairs) => {
      if (cancelled) return;
      setIndex((prev) => { const next = new Map(prev); pairs.forEach(([id, m]) => next.set(id, m)); return next; });
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // `key` is the sorted id list; `index` is read but its identity change is
    // what this effect writes, so depending on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { index, loading };
}
