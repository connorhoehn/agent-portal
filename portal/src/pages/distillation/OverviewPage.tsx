// Distillation → Overview. The front door: the whole loop from an agent's
// session to the runbook the next agent boots with, drawn as one row of
// nodes with live counts and tier health; then what the fleet can actually
// DO with what it learned and whether that still works; then only what
// needs attention, how hard the fleet is writing, and whether the human
// sample dial is calibrated. Drill-ins live on their own routes.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  Button, Card, Chip, DataTable, DetailSection, Divider, EmptyState, Inline, InlineAlert,
  Link, LoadingState, MetaLine, ProgressBar, ScoreBarGauge, StatStrip, StatusDot, Stack, TrendSparkline,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { KeyValue } from '../../components/KeyValue';
import { relativeTime } from '../../lib/relativeTime';
import { T } from './Text';
import { ProcessFlow } from './ProcessFlow';
import {
  LEVEL_HEALTH_ALERT_TONE, PROCEDURE_HEALTH_LABEL, PROCEDURE_HEALTH_TONE, SAMPLING_LABEL,
  SAMPLING_TONE, liveSessionCountForRepo, pct, procedureRollup, runsLabel, stepsLabel,
  type RepoPresenceNode,
} from './distillationFormat';
import type {
  CompactionsResponse, IngestState, LevelsResponse, ProcedureView, ProceduresResponse, SamplingResponse,
} from './types';

/** Rows on the front door. Six is enough to read the fleet's repertoire at a
 *  glance; past that the reader wants the filtered catalog, which is a link. */
const PROCEDURE_ROWS = 6;

// Same adaptive cadence CompactionsPage.tsx established: fast while a merge
// is actually running (the ladder's counts are moving), the normal rate
// otherwise. Copied as a literal rather than imported — the two pages watch
// different fetches and shouldn't share mutable poll state.
const IDLE_POLL_MS = 30_000;
const RUNNING_POLL_MS = 2_000;

// Presence is scoped to the signed-in person's own paired machines
// (`GET /api/local-compute/nodes` — "my machines," not fleet-wide; the
// audit found no honest org-wide repo-presence route yet), so it changes far
// less often than a running compaction — a flat poll is enough.
const NODES_POLL_MS = 30_000;

function repoShort(repo: string | null): string | null {
  if (!repo) return null;
  const i = repo.lastIndexOf('/');
  return i >= 0 ? repo.slice(i + 1) : repo;
}

export default function DistillationOverviewPage() {
  const [pollMs, setPollMs] = useState<number>(IDLE_POLL_MS);
  const { data: jobsData } = useFetch<CompactionsResponse>('/api/distillation/compactions', pollMs);

  useEffect(() => {
    const hasRunning = (jobsData?.jobs ?? []).some((j) => j.status === 'running');
    setPollMs(hasRunning ? RUNNING_POLL_MS : IDLE_POLL_MS);
  }, [jobsData]);

  const { data: levelsData, isLoading: levelsLoading, error: levelsError } =
    useFetch<LevelsResponse>('/api/distillation/levels', pollMs);
  const { data: ingestData } = useFetch<IngestState>('/api/distillation/ingest', 20_000);
  const { data: samplingData } = useFetch<SamplingResponse>('/api/distillation/sampling', 60_000);

  const { data: proceduresData, isLoading: proceduresLoading, error: proceduresError } =
    useFetch<ProceduresResponse>('/api/distillation/procedures', 60_000);
  const { data: nodesData } = useFetch<{ nodes: RepoPresenceNode[] }>('/api/local-compute/nodes', NODES_POLL_MS);
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
      key: 'repo_activity',
      // A weaker but honest claim than "this procedure is running": whether
      // someone is live in the same repo right now, and only on the
      // machines THIS person paired — there is no fleet-wide repo-presence
      // route yet (see docs/distillation-concept-audit-2026-09-16.md §2).
      header: <span title="Live sessions on your own paired machines, in this procedure's repo — not fleet-wide.">Repo activity</span>,
      render: (p) => {
        if (!nodesData) return <T className="text-[11px] text-text-tertiary">—</T>;
        if (!p.repo) return <T className="text-[11px] text-text-tertiary">spans repos</T>;
        const count = liveSessionCountForRepo(nodesData.nodes, p.repo);
        return (
          <Inline gap="xs" align="center" wrap={false}>
            <StatusDot
              size="xs"
              pulse={count > 0}
              color={count > 0 ? 'var(--color-success)' : 'var(--color-state-idle)'}
              aria-label={count > 0 ? `${count} live session${count === 1 ? '' : 's'} on your machines` : 'no live session on your machines'}
            />
            <T className="whitespace-nowrap text-[11px] text-text-tertiary">
              {count > 0 ? `${count} on your machines` : 'none on your machines'}
            </T>
          </Inline>
        );
      },
    },
    {
      key: 'runs',
      header: 'Runs',
      render: (p) => (
        // The sparkline is the last 14 UTC days; the caption beside it is the
        // lifetime count — two windows, so each is labelled as its own.
        <Inline gap="sm" align="center" wrap={false}>
          <TrendSparkline
            points={p.applied_per_day}
            yMin={0}
            width={96}
            height={24}
            showFill={false}
            ariaLabel={`${p.applied_per_day.reduce((a, b) => a + b, 0)} runs in the last 14 days`}
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
            hint: !proceduresData ? undefined
              : rollup.total === 0 ? 'none yet'
                : rollup.drifting > 0 ? `${rollup.drifting} drifting` : 'all holding',
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
              <KeyValue layout="row" labelWidth="w-[180px]" label="Active writers" value={`${ingestData.activeWriters} sessions`} />
              <KeyValue layout="row" labelWidth="w-[180px]" label="Observations / hour" value={String(ingestData.observationsPerHour)} />
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
