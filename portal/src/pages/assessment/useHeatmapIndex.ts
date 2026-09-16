// One bulk read behind the portfolio heatmap (ReportsPage.tsx's
// MaturityHeatmap): `GET /api/assessment/dimension-index` returns every
// team's 17 dimensions in one response, computed server-side from the same
// rows `GET /api/assessment/teams/:id` uses — see
// middleware/src/providers/assessment.ts `getDimensionIndex`.
//
// This is a DIFFERENT, narrower cousin of `useDimensionIndex.ts`: that hook
// still fetches full per-team detail (it backs FeedbackPage's question
// drawer, which needs `evidence` — a field this lean shape does not carry),
// one `GET /teams/:id` per team it needs to look up. The heatmap never
// needed that much: just the level and statement per cell. Do not widen
// `HeatmapDimension` to match `Dimension` — that would just reintroduce the
// N+1 the bulk endpoint exists to remove.
import { useMemo } from 'react';
import { useFetch } from '../../hooks/useFetch';

export interface HeatmapDimension {
  id: string;
  title: string;
  current_level: number | null;
  is_na: boolean;
  certification?: {
    verified_level: number | null;
    claimed_level: number | null;
    statement?: string;
  };
}

interface DimensionIndexResponse {
  teams: Array<{ id: string; dimensions: HeatmapDimension[] }>;
}

export type HeatmapIndex = Map<string, Map<string, HeatmapDimension>>;

export function useHeatmapIndex(): { index: HeatmapIndex; loading: boolean } {
  const { data, isLoading } = useFetch<DimensionIndexResponse>('/api/assessment/dimension-index');
  const index = useMemo<HeatmapIndex>(() => {
    const map: HeatmapIndex = new Map();
    for (const team of data?.teams ?? []) {
      map.set(team.id, new Map(team.dimensions.map((d) => [d.id, d])));
    }
    return map;
  }, [data]);
  return { index, loading: isLoading };
}
