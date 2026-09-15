// Distillation → Overview. The front door: the whole loop from an agent's
// session to the runbook the next agent boots with, drawn as one row of
// nodes with live counts and tier health; then what the fleet can actually
// DO with what it learned and whether that still works; then only what
// needs attention, how hard the fleet is writing, and whether the human
// sample dial is calibrated. Drill-ins live on their own routes.
import { useNavigate } from 'react-router';
import {
  Button, Card, Chip, DataTable, DetailSection, Divider, EmptyState, Inline, InlineAlert,
  Link, LoadingState, MetaLine, ProgressBar, ScoreBarGauge, StatStrip, Stack, TrendSparkline,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { relativeTime } from '../../lib/relativeTime';
import { T } from './Text';
import { ProcessFlow } from './ProcessFlow';
import {
  LEVEL_HEALTH_ALERT_TONE, PROCEDURE_HEALTH_LABEL, PROCEDURE_HEALTH_TONE, SAMPLING_LABEL,
  SAMPLING_TONE, pct, procedureRollup, runsLabel, stepsLabel,
} from './distillationFormat';
import type { IngestState, LevelsResponse, ProcedureView, ProceduresResponse, SamplingResponse } from './types';

/** Rows on the front door. Six is enough to read the fleet's repertoire at a
 *  glance; past that the reader wants the filtered catalog, which is a link. */
const PROCEDURE_ROWS = 6;

function repoShort(repo: string | null): string | null {
  if (!repo) return null;
  const i = repo.lastIndexOf('/');
  return i >= 0 ? repo.slice(i + 1) : repo;
}

export default function DistillationOverviewPage() {
  const { data: levelsData, isLoading: levelsLoading, error: levelsError } =
    useFetch<LevelsResponse>('/api/distillation/levels', 20_000);
  const { data: ingestData } = useFetch<IngestState>('/api/distillation/ingest', 20_000);
  const { data: samplingData } = useFetch<SamplingResponse>('/api/distillation/sampling', 60_000);

  const { data: proceduresData, isLoading: proceduresLoading, error: proceduresError } =
    useFetch<ProceduresResponse>('/api/distillation/procedures', 60_000);
  const navigate = useNavigate();

  const levels = levelsData?.levels ?? [];
  const health = levelsData?.health ?? [];
  const problemLevels = health.filter((h) => h.status !== 'healthy');
  // Server-sorted drifting → unproven → proven, so the first rows are the
  // ones that need a person; the rollup is counted here from the same rows.
  const procedures = proceduresData?.procedures ?? [];
  const rollup = procedureRollup(procedures);

  const procedureColumns: DataTableColumn<ProcedureView>[] = [
    {
      key: 'title',
      header: 'Procedure',
      render: (p) => (
        <Stack gap="xs">
          {/* A ghost Button rather than a row click: rows are not tab stops,
              and every door on this page is reachable from the keyboard. */}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => navigate(`/iq/distillation/artifacts?type=procedure&open=${encodeURIComponent(p.artifact.id)}`)}
          >
            {p.artifact.title}
          </Button>
          <MetaLine
            size="xs"
            items={[
              stepsLabel(p.step_count),
              repoShort(p.repo),
              p.artifact.library_item_id ? 'in Library' : p.artifact.status,
            ]}
          />
        </Stack>
      ),
    },
    {
      key: 'proof',
      header: 'Proof',
      width: '30%',
      render: (p) => (
        <Stack gap="xs">
          <Chip tone={PROCEDURE_HEALTH_TONE[p.health.status]} size="xs" dot="static">
            {PROCEDURE_HEALTH_LABEL[p.health.status]}
          </Chip>
          <T className="text-[11px] text-text-tertiary" title={p.health.reason}>{p.health.reason}</T>
        </Stack>
      ),
    },
    {
      key: 'last_proven',
      header: 'Last proven',
      render: (p) => (
        <T className="text-[12px] text-text-secondary">
          {p.last_succeeded_at ? relativeTime(p.last_succeeded_at) : 'never'}
        </T>
      ),
    },
    {
      key: 'runs',
      header: 'Runs · 14d',
      render: (p) => (
        <Inline gap="sm" align="center" wrap={false}>
          <TrendSparkline
            points={p.applied_per_day}
            yMin={0}
            width={96}
            height={24}
            showFill={false}
            ariaLabel={`${p.runs.total} runs in 14 days`}
          />
          <T className="text-[11px] text-text-tertiary">{runsLabel(p.runs)}</T>
        </Inline>
      ),
    },
    {
      key: 'success',
      header: 'Success',
      width: '14%',
      render: (p) => (
        // NaN for an unproven procedure renders an empty gauge by contract —
        // "no data" rather than a confident 0%.
        <ScoreBarGauge
          value={p.runs.total > 0 ? p.runs.succeeded / p.runs.total : Number.NaN}
          threshold={0.8}
          size="sm"
          ariaLabel={`${p.runs.succeeded} of ${p.runs.total} runs succeeded`}
        />
      ),
    },
  ];

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
          {
            label: 'Proven procedures',
            value: proceduresData ? `${rollup.proven}/${rollup.total}` : '—',
            tone: rollup.drifting > 0 ? 'danger' : 'default',
            hint: !proceduresData ? undefined : rollup.drifting > 0 ? `${rollup.drifting} drifting` : 'all holding',
          },
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

      {/* The repertoire. A runbook is prose the next agent may or may not
          follow; a procedure is ordered steps the fleet has actually run, and
          each row says whether it still works: proven (succeeded recently,
          nothing moved since), drifting (a failed run or a new gotcha in that
          repo since it last succeeded), unproven (never run to completion).
          Every number is counted from run rows, not stored. */}
      <DetailSection
        title="What the fleet knows how to do"
        hint={proceduresData ? rollup.hint : undefined}
        actions={procedures.length > PROCEDURE_ROWS ? (
          <Link href="/iq/distillation/artifacts?type=procedure">See all {procedures.length} procedures →</Link>
        ) : undefined}
      >
        {proceduresError ? (
          <EmptyState title="Could not load procedures" description={proceduresError} />
        ) : proceduresLoading && !proceduresData ? (
          <LoadingState label="Loading procedures…" />
        ) : procedures.length === 0 ? (
          <EmptyState
            title="No procedures yet"
            description="The next L1 → L2 pass mints one when a chunk of clusters pairs a failure with the fix that resolved it."
          />
        ) : (
          <DataTable
            data={procedures.slice(0, PROCEDURE_ROWS)}
            keyField={(p) => p.artifact.id}
            columns={procedureColumns}
            emptyMessage="No procedures."
            data-testid="procedure-repertoire"
          />
        )}
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
