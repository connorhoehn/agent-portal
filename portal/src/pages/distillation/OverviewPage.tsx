// Distillation → Overview. The front door: the whole loop from an agent's
// session to the runbook the next agent boots with, drawn as one row of
// nodes with live counts and tier health; then only what needs attention,
// how hard the fleet is writing, and whether the human sample dial is
// calibrated. Drill-ins live on their own routes.
import {
  Card, DetailSection, Divider, EmptyState, Inline, InlineAlert, LoadingState,
  ProgressBar, StatStrip, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { T } from './Text';
import { ProcessFlow } from './ProcessFlow';
import {
  LEVEL_HEALTH_ALERT_TONE, SAMPLING_LABEL, SAMPLING_TONE, pct,
} from './distillationFormat';
import type { IngestState, LevelsResponse, SamplingResponse } from './types';

export default function DistillationOverviewPage() {
  const { data: levelsData, isLoading: levelsLoading, error: levelsError } =
    useFetch<LevelsResponse>('/api/distillation/levels', 20_000);
  const { data: ingestData } = useFetch<IngestState>('/api/distillation/ingest', 20_000);
  const { data: samplingData } = useFetch<SamplingResponse>('/api/distillation/sampling', 60_000);

  const levels = levelsData?.levels ?? [];
  const health = levelsData?.health ?? [];
  const problemLevels = health.filter((h) => h.status !== 'healthy');

  return (
    <Stack gap="lg">
      <StatStrip
        aria-label="Distillation rollup"
        items={[
          { label: 'L0 raw', value: levels.find((l) => l.level === 'L0')?.items ?? '—' },
          { label: 'L1 clusters', value: levels.find((l) => l.level === 'L1')?.items ?? '—', tone: 'accent' },
          { label: 'L2 artifacts', value: levels.find((l) => l.level === 'L2')?.items ?? '—' },
          { label: 'Active writers', value: ingestData?.activeWriters ?? '—', hint: 'sessions writing right now' },
          { label: 'L1 sample rate', value: samplingData ? `${samplingData.l1SampleRatePct}%` : '—', hint: 'what humans review' },
        ]}
      />

      {/* The process, end to end. Each node is a door (Enter/click); the
          merge edges animate while a compaction runs and breathe while a
          tier is behind — the same frame the Compactions page draws. */}
      <DetailSection
        first
        title="How findings become org knowledge"
        hint="sessions, bot runs, sweeps and lab signals → L0 → L1 → L2 → Library, Promotions, Session config"
      >
        <Stack gap="sm">
          <ProcessFlow />
          {/* Tier health is on the nodes; below the flow only what needs a
              hand — three stacked cards repeating "healthy" were the wasted
              space the reader scrolled past to reach the numbers. */}
          {levelsError ? (
            <EmptyState title="Could not load level state" description={levelsError} />
          ) : levelsLoading && !levelsData ? (
            <LoadingState label="Loading levels…" />
          ) : problemLevels.length === 0 ? (
            <InlineAlert tone="success">Every tier is keeping pace with its writers.</InlineAlert>
          ) : (
            problemLevels.map((h) => (
              <InlineAlert key={h.level} tone={LEVEL_HEALTH_ALERT_TONE[h.status]}>
                <T className="font-semibold">{h.level}</T> — {h.reason}
              </InlineAlert>
            ))
          )}
        </Stack>
      </DetailSection>

      <DetailSection title="Ingest pressure" hint={ingestData ? `${ingestData.observationsPerHour}/hr` : undefined}>
        {!ingestData ? (
          <LoadingState label="Loading ingest…" />
        ) : (
          <Card padding="sm">
            <Stack gap="sm">
              <Inline gap="md" align="baseline">
                <T className="w-[150px] shrink-0 text-[12px] text-text-tertiary">Active writers</T>
                <T className="tabular-nums text-[12px] text-text-primary">{ingestData.activeWriters} sessions</T>
              </Inline>
              <Inline gap="md" align="baseline">
                <T className="w-[150px] shrink-0 text-[12px] text-text-tertiary">Observations / hour</T>
                <T className="tabular-nums text-[12px] text-text-primary">{ingestData.observationsPerHour}</T>
              </Inline>
              <Divider spacing="sm" label="which repos dominate" />
              <Stack gap="xs">
                {ingestData.topRepos.map((r) => (
                  <ProgressBar
                    key={r.repo}
                    value={Math.round(r.share * 100)}
                    max={100}
                    showRatio={false}
                    size="sm"
                    label={`${r.repo} · ${pct(r.share)}`}
                    aria-label={`${r.repo} share of ingest`}
                  />
                ))}
              </Stack>
            </Stack>
          </Card>
        )}
      </DetailSection>

      <DetailSection title="Sampling verdict" hint={samplingData ? `${samplingData.l1SampleRatePct}% of L1 reviewed by people` : undefined}>
        <Stack gap="sm">
          {samplingData && (
            <InlineAlert tone={SAMPLING_TONE[samplingData.verdict.verdict]}>
              <T className="font-semibold">{SAMPLING_LABEL[samplingData.verdict.verdict]}</T> — {samplingData.verdict.reason}
              {' · '}{samplingData.reviewedLast30d} reviewed in 30d, {samplingData.queueDepth} in queue now — see Review sample.
            </InlineAlert>
          )}
        </Stack>
      </DetailSection>
    </Stack>
  );
}
