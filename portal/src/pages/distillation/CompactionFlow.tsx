// Distillation → Compactions, top-of-page tier ladder. Fetches what
// `compactionFlowModel` needs — `/api/distillation/levels` (counts + health)
// and the published-artifact count (`/api/distillation/artifacts?status=
// published`, guarded to `library_item_id != null` rather than trusting the
// status filter alone) — and reduces them, together with the `jobs` the
// Compactions page already polls for its table, into a pure
// `CompactionFlowModel`. All the xyflow rendering lives in
// `CompactionFlowFrame.tsx`; this component is the only thing that talks to
// the network or the router.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useFetch } from '../../hooks/useFetch';
import { CompactionFlowFrame } from './CompactionFlowFrame';
import { compactionFlowModel } from './distillationFormat';
import type { ArtifactsResponse, CompactionJob, LevelsResponse } from './types';

const LEVELS_POLL_MS = 20_000;
const PUBLISHED_POLL_MS = 60_000;

export interface CompactionFlowProps {
  jobs: CompactionJob[];
  height?: number;
}

export function CompactionFlow({ jobs, height }: CompactionFlowProps) {
  const navigate = useNavigate();
  const { data: levelsData, isLoading: levelsLoading, error: levelsError } =
    useFetch<LevelsResponse>('/api/distillation/levels', LEVELS_POLL_MS);
  const { data: artifactsData, isLoading: artifactsLoading } =
    useFetch<ArtifactsResponse>('/api/distillation/artifacts?status=published', PUBLISHED_POLL_MS);

  // Guard on shape: only count artifacts that are both actually published
  // AND actually carry a library item — the ?status= filter is a server
  // hint, not a contract this page should trust blindly.
  const publishedCount = Array.isArray(artifactsData?.artifacts)
    ? artifactsData.artifacts.filter((a) => a.status === 'published' && a.library_item_id != null).length
    : 0;

  const model = useMemo(() => {
    if (!levelsData) return null;
    return compactionFlowModel(levelsData.levels, levelsData.health, jobs, publishedCount);
  }, [levelsData, jobs, publishedCount]);

  return (
    <CompactionFlowFrame
      model={model}
      loading={levelsLoading || artifactsLoading}
      error={levelsError}
      onNavigate={(path) => navigate(path)}
      height={height}
    />
  );
}
