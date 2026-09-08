// Distillation → Overview, top of page: the whole loop from an agent's
// session to the runbook the next agent boots with. Fetches what
// `processFlowModel` needs and reduces it; all rendering is the same
// `CompactionFlowFrame` the Compactions ladder uses, so the two views can
// never disagree about a tier's count or health.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { useFetch } from '../../hooks/useFetch';
import { CompactionFlowFrame } from './CompactionFlowFrame';
import { processFlowModel } from './distillationFormat';
import type { ArtifactsResponse, CompactionsResponse, IngestState, LevelsResponse } from './types';

interface FindingsResponse { findings: Array<{ id: string; sweep?: string }> }
interface LiveBundleResponse { skills?: unknown[] }
interface BotsResponse { bots?: Array<{ enabled?: boolean; todayRunCount?: number }> }
interface PromotionsResponse { candidates?: Array<{ status?: string }> }
interface SamplingLite { reviewedLast30d?: number }

const LAB_SWEEP = 'lab-signal';

export function ProcessFlow({ height = 400 }: { height?: number }) {
  const navigate = useNavigate();
  const { data: levelsData, isLoading: levelsLoading, error: levelsError } =
    useFetch<LevelsResponse>('/api/distillation/levels', 20_000);
  const { data: ingestData } = useFetch<IngestState>('/api/distillation/ingest', 20_000);
  const { data: jobsData } = useFetch<CompactionsResponse>('/api/distillation/compactions', 20_000);
  const { data: artifactsData } = useFetch<ArtifactsResponse>('/api/distillation/artifacts?status=published', 60_000);
  const { data: findingsData } = useFetch<FindingsResponse>('/api/work/findings?status=open', 60_000);
  const { data: bundle } = useFetch<LiveBundleResponse>('/api/session-bundle/live', 60_000);
  // `degraded` counts as a failure here for the same reason `botsError` does
  // (see below): the route answers 200 with `{ bots: [] }` when the roster
  // read fails, and folding that into the run-count would report a confident
  // zero for a number nobody managed to read.
  const {
    data: botsData, error: botsTransportError, degraded: botsDegraded,
  } = useFetch<BotsResponse>('/api/bots', 60_000);
  const botsError = botsTransportError ?? botsDegraded;
  const { data: promotionsData } = useFetch<PromotionsResponse>('/api/promotions', 60_000);
  const { data: samplingData } = useFetch<SamplingLite>('/api/distillation/sampling', 60_000);

  // Guard on shape, not presence: every count below is derived from an
  // array that must actually be there, never from a status filter alone.
  const publishedCount = Array.isArray(artifactsData?.artifacts)
    ? artifactsData.artifacts.filter((a) => a.status === 'published' && a.library_item_id != null).length
    : 0;
  const findings = Array.isArray(findingsData?.findings) ? findingsData.findings : [];
  const labSignals = findings.filter((f) => f.sweep === LAB_SWEEP).length;
  const sweepFindings = findings.length - labSignals;
  const bundleSkills = Array.isArray(bundle?.skills) ? bundle.skills.length : null;
  const jobs = Array.isArray(jobsData?.jobs) ? jobsData.jobs : [];
  // Defect #12: a failed fetch (a member's /api/bots 403) is not "0 runs
  // today" — null says "unknown" instead of asserting a fact about the org
  // that isn't true. Checked via `botsError`, not just the data shape,
  // because a later poll can fail while `botsData` still holds a prior
  // successful response — that stale array must not paper over a fetch that
  // just started failing.
  const botRunsToday = botsError || !Array.isArray(botsData?.bots)
    ? null
    : botsData.bots.reduce((n, b) => n + (typeof b.todayRunCount === 'number' ? b.todayRunCount : 0), 0);
  const candidates = Array.isArray(promotionsData?.candidates)
    ? promotionsData.candidates.filter((c) => c.status === 'candidate').length
    : 0;
  const reviewed30d = typeof samplingData?.reviewedLast30d === 'number' ? samplingData.reviewedLast30d : 0;

  const model = useMemo(() => {
    if (!levelsData) return null;
    return processFlowModel({
      activeWriters: ingestData?.activeWriters ?? 0,
      botRunsToday,
      sweepFindings,
      labSignals,
      reviewed30d,
      levels: levelsData.levels,
      health: levelsData.health,
      jobs,
      publishedCount,
      candidates,
      bundleSkills,
    });
  }, [levelsData, ingestData?.activeWriters, botRunsToday, sweepFindings, labSignals, reviewed30d, jobs, publishedCount, candidates, bundleSkills]);

  return (
    <CompactionFlowFrame
      model={model}
      loading={levelsLoading}
      error={levelsError}
      onNavigate={(path) => navigate(path)}
      height={height}
      ariaLabel="How findings become org knowledge: agent sessions, bot runs, sweep findings and lab signals feed L0 observations; L0 merges into L1 clusters, calibrated by human review; L1 into L2 runbooks; published to the Library and promoted as candidate skills; the Library is bundled into Session config"
    />
  );
}
