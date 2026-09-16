// Distillation → Compactions. The run log underneath the ladder: every merge
// pass, on demand (`ManageBots`) or scheduled, plus what each pass actually
// produced — the clusters and artifacts a job made, so a row opens into the
// thing it built instead of only reporting counts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  Button, Chip, DataTable, DetailSection, Drawer, EmptyState, FilterChip, Inline, InlineAlert,
  LoadingState, PageSection, Stack, Toolbar, ToolbarGroup, ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { useUrlState } from '../../lib/useUrlState';
import { KeyValue } from '../../components/KeyValue';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { CompactionFlow } from './CompactionFlow';
import { filterCompactionJobs } from './compactionsFilter';
import { T } from './Text';
import { STATUS_TONE, bytesLabel, dedupePctLabel, durationLabel, producedSummaryLabel, usd } from './distillationFormat';
import type { CompactableLevel, CompactionJob, CompactionsResponse, CompactionStatus } from './types';

// Defect #3 (member DEFECTS.md): the middleware now answers a launch with a
// `status: 'running'` job that flips to `succeeded` ~3s later, so this page
// polls fast while that's in flight (2s) and backs off to the normal 30s
// once nothing is running — and only fires the completion toast for a job
// THIS session launched, keyed by id, so a cron-triggered or someone-else's
// compaction finishing doesn't pop a toast with no context for it.
const IDLE_POLL_MS = 30_000;
const RUNNING_POLL_MS = 2_000;

const STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'succeeded', label: 'Succeeded' },
  { value: 'running', label: 'Running' },
  { value: 'failed', label: 'Failed' },
];

const LEVEL_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'L1', label: 'L0 → L1' },
  { value: 'L2', label: 'L1 → L2' },
];

export default function DistillationCompactionsPage() {
  const { can, ready } = useCapabilities();
  const canCompact = ready && can('ManageBots');
  // ?level=&status= — a filtered run log is a shareable link.
  const [levelFilter, setLevelFilter] = useUrlState<string>(
    'level',
    (raw) => (raw && LEVEL_FILTERS.some((f) => f.value === raw) ? raw : 'all'),
    (v) => (v === 'all' ? null : v),
  );
  const [statusFilter, setStatusFilter] = useUrlState<string>(
    'status',
    (raw) => (raw && STATUS_FILTERS.some((f) => f.value === raw) ? raw : 'all'),
    (v) => (v === 'all' ? null : v),
  );
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<CompactableLevel | null>(null);
  // Jobs THIS tab launched, id → its live toast, so the completion toast
  // only fires for a launch this session is actually waiting on.
  const launchedToastsRef = useRef<Map<string, string>>(new Map());
  // Last-seen status per job id, so a poll tick can tell "just flipped to
  // succeeded" apart from "already was succeeded" without a second fetch.
  const lastStatusRef = useRef<Map<string, CompactionStatus>>(new Map());

  // Fetched UNFILTERED — the Merge/Status facets below narrow only the
  // table's own rows (via `filterCompactionJobs`). The ladder needs the full
  // history to find each level's most recent run regardless of what the
  // table is currently showing (defect #15, org-leader/DEFECTS.md #15):
  // filtering "L1 → L2 + Failed" used to hand `<CompactionFlow>` a jobs
  // array with no succeeded L2 run in it, so `latestJobFor('L2', jobs)`
  // found nothing and both edges read "no merges yet" seconds after a real
  // merge had succeeded.
  const [pollMs, setPollMs] = useState<number>(IDLE_POLL_MS);
  const { data: jobsData, isLoading: jobsLoading, error: jobsError, refresh: refreshJobs } =
    useFetch<CompactionsResponse>('/api/distillation/compactions', pollMs);

  const jobs = useMemo(() => jobsData?.jobs ?? [], [jobsData]);
  const filteredJobs = useMemo(
    () => filterCompactionJobs(jobs, levelFilter, statusFilter),
    [jobs, levelFilter, statusFilter],
  );
  const openJob = jobs.find((j) => j.id === openId) ?? null;

  // Fast-poll while anything in view is running, back off to the normal
  // cadence once nothing is — and resolve any toast for a job THIS tab
  // launched the moment its status leaves 'running'.
  useEffect(() => {
    if (jobsData == null) return;
    for (const job of jobs) {
      const prev = lastStatusRef.current.get(job.id);
      lastStatusRef.current.set(job.id, job.status);
      if (prev !== 'running' || job.status === 'running') continue;
      const tid = launchedToastsRef.current.get(job.id);
      if (!tid) continue;
      launchedToastsRef.current.delete(job.id);
      if (job.status === 'succeeded') {
        toastSuccess(tid, `${job.level} compaction complete`, `produced ${producedSummaryLabel(job.produced)}`);
      } else {
        toastError(tid, 'Compaction failed', job.error ?? 'failed without an error message');
      }
    }
    const hasRunning = jobs.some((j) => j.status === 'running');
    setPollMs(hasRunning ? RUNNING_POLL_MS : IDLE_POLL_MS);
  }, [jobs, jobsData]);

  async function compactNow(level: CompactableLevel) {
    if (busy) return;
    setBusy(level);
    const tid = toastPending(`Compacting ${level}`, level === 'L1' ? 'merging L0 into L1' : 'merging L1 into L2');
    try {
      const res = await fetch('/api/distillation/compact', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level }),
      });
      const body = await res.json() as CompactionJob & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.status === 'running') {
        // Async contract: the launch itself only confirms the job started.
        // Remember it so the poll-driven effect above can resolve this same
        // toast once the job actually finishes; refetch now so the running
        // row shows up immediately instead of waiting for the next tick.
        launchedToastsRef.current.set(body.id, tid);
        lastStatusRef.current.set(body.id, 'running');
        setPollMs(RUNNING_POLL_MS);
      } else {
        toastSuccess(tid, `${level} compaction complete`, `produced ${producedSummaryLabel(body.produced)}`);
      }
      refreshJobs();
    } catch (err) {
      toastError(tid, 'Compaction failed', (err as Error).message);
    } finally { setBusy(null); }
  }

  const columns: DataTableColumn<CompactionJob>[] = [
    {
      key: 'startedAt', header: 'Started', sortable: true,
      compare: (a, b) => a.startedAt.localeCompare(b.startedAt),
      // A real Button, not just the row's onClick: DataTable's row-click is
      // a bare <tr onClick> with no tabIndex/keydown/role, so a keyboard
      // user could not reach either drawer (defect #13, org-leader/
      // DEFECTS.md #13 — 10 compaction rows, none carrying tabindex/role).
      // This is the row's one focusable, Enter/Space-activatable control;
      // the row click stays as a mouse convenience alongside it — same
      // pattern as `library/LibraryPage.tsx` and
      // `promotions/PromotionsPage.tsx`.
      render: (j) => (
        <Button
          variant="ghost"
          size="sm"
          className="justify-start whitespace-nowrap border-none bg-transparent p-0 text-left text-[12px] text-text-secondary hover:bg-transparent hover:underline"
          onClick={(e) => { e.stopPropagation(); setOpenId(j.id); }}
        >
          {relativeTime(j.startedAt)}
        </Button>
      ),
    },
    {
      key: 'level', header: 'Merge', sortable: true,
      render: (j) => <T className="whitespace-nowrap text-[11px] text-text-tertiary">{j.level === 'L1' ? 'L0 → L1' : 'L1 → L2'}</T>,
    },
    {
      key: 'status', header: 'Status', sortable: true,
      // `pulse` on the running chip is the "subtle progress indication" —
      // there's no percent-complete from the API to show a real bar
      // against, so a live dot beats a determinate `ProgressBar` faking one.
      render: (j) => <Chip tone={STATUS_TONE[j.status]} size="xs" dot={j.status === 'running' ? 'pulse' : 'static'}>{j.status}</Chip>,
    },
    {
      key: 'inputItems', header: 'In', align: 'right', sortable: true,
      render: (j) => <T className="tabular-nums text-[12px] text-text-secondary">{j.inputItems}</T>,
    },
    {
      key: 'outputItems', header: 'Out', align: 'right', sortable: true,
      render: (j) => <T className="tabular-nums text-[12px] text-text-secondary">{j.outputItems}</T>,
    },
    {
      key: 'dedupe', header: 'Deduped', align: 'right',
      render: (j) => <T className="tabular-nums text-[12px] font-medium text-text-primary">{dedupePctLabel(j)}</T>,
    },
    {
      key: 'bytesReclaimed', header: 'Reclaimed', align: 'right',
      render: (j) => <T className="whitespace-nowrap tabular-nums text-[11px] text-text-tertiary">{bytesLabel(j.bytesReclaimed)}</T>,
    },
    {
      key: 'costUsd', header: 'Cost', align: 'right', sortable: true,
      render: (j) => <T className="tabular-nums text-[12px] text-text-secondary">{usd(j.costUsd)}</T>,
    },
    {
      key: 'duration', header: 'Took', align: 'right',
      render: (j) => <T className="whitespace-nowrap text-[11px] text-text-tertiary">{durationLabel(j)}</T>,
    },
    {
      key: 'produced', header: 'Produced', align: 'right',
      render: (j) => {
        const n = (j.produced?.cluster_ids.length ?? 0) + (j.produced?.artifact_ids.length ?? 0);
        return <T className="whitespace-nowrap text-[11px] text-text-tertiary">{n > 0 ? `${n} item${n === 1 ? '' : 's'}` : '—'}</T>;
      },
    },
  ];

  return (
    <PageSection
      title="Compactions"
      description="Every merge pass and what it produced; the ladder runs unattended."
      actions={canCompact
        ? (
          <Inline gap="xs">
            <Button size="sm" variant="secondary" disabled={busy != null} onClick={() => void compactNow('L1')}>
              {busy === 'L1' ? 'Compacting…' : 'Compact L0 → L1'}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy != null} onClick={() => void compactNow('L2')}>
              {busy === 'L2' ? 'Compacting…' : 'Compact L1 → L2'}
            </Button>
          </Inline>
        )
        : undefined}
    >
      <CompactionFlow jobs={jobs} height={200} />

      <Toolbar size="md" wrap aria-label="Compaction filters">
        <ToolbarGroup aria-label="Merge">
          <ToolbarLabel>Merge</ToolbarLabel>
          {LEVEL_FILTERS.map((f) => (
            <FilterChip key={f.value} active={levelFilter === f.value} onClick={() => setLevelFilter(f.value)} size="sm">
              {f.label}
            </FilterChip>
          ))}
        </ToolbarGroup>
        <ToolbarGroup aria-label="Status">
          <ToolbarLabel>Status</ToolbarLabel>
          {STATUS_FILTERS.map((f) => (
            <FilterChip key={f.value} active={statusFilter === f.value} onClick={() => setStatusFilter(f.value)} size="sm">
              {f.label}
            </FilterChip>
          ))}
        </ToolbarGroup>
      </Toolbar>

      {jobsError ? (
        <EmptyState title="Could not load compaction history" description={jobsError} />
      ) : jobsLoading && !jobsData ? (
        <LoadingState label="Loading compactions…" />
      ) : filteredJobs.length === 0 ? (
        <EmptyState title="No compactions" description="No compaction jobs match this filter." />
      ) : (
        <DataTable<CompactionJob>
          data={filteredJobs}
          columns={columns}
          keyField={(j) => j.id}
          onRowClick={(j) => setOpenId(j.id)}
          pageSize={25}
          emptyMessage="No compactions"
        />
      )}

      <Drawer open={openJob != null} onClose={() => setOpenId(null)} aria-label="Compaction job" width={520}>
        {openJob && (
          <Stack gap="md">
            <Stack gap="xs" as="header">
              <Inline gap="xs" align="center">
                <T className="text-[15px] font-semibold text-text-primary">{openJob.id}</T>
                <Chip tone={STATUS_TONE[openJob.status]} size="xs" dot={openJob.status === 'running' ? 'pulse' : 'static'}>{openJob.status}</Chip>
              </Inline>
              <T className="text-[11px] text-text-tertiary">
                {openJob.level === 'L1' ? 'L0 → L1' : 'L1 → L2'} · started {relativeTime(openJob.startedAt)} · took {durationLabel(openJob)}
              </T>
            </Stack>

            {openJob.status === 'failed' && (
              <InlineAlert tone="warning">{openJob.error ?? 'failed without an error message'}</InlineAlert>
            )}

            <DetailSection first title="What it moved">
              <Stack gap="xs">
                <KeyValue layout="row" labelWidth="w-[150px]" label="Input items" value={String(openJob.inputItems)} />
                <KeyValue layout="row" labelWidth="w-[150px]" label="Output items" value={String(openJob.outputItems)} />
                <KeyValue layout="row" labelWidth="w-[150px]" label="Deduped" value={`${openJob.dedupedItems} (${dedupePctLabel(openJob)})`} />
                <KeyValue layout="row" labelWidth="w-[150px]" label="Bytes reclaimed" value={bytesLabel(openJob.bytesReclaimed)} />
              </Stack>
            </DetailSection>

            <DetailSection title="Cost">
              <KeyValue layout="row" labelWidth="w-[150px]" label="Spend" value={usd(openJob.costUsd)} />
            </DetailSection>

            {openJob.produced && (openJob.produced.cluster_ids.length > 0 || openJob.produced.artifact_ids.length > 0) && (
              <DetailSection title="Produced" hint="what this pass made">
                <Stack gap="xs">
                  {openJob.produced.cluster_ids.map((id) => (
                    <Inline key={id} gap="xs" align="center">
                      <Chip tone="neutral" size="xs">cluster</Chip>
                      <Link to={`/iq/distillation/lineage?focus=${encodeURIComponent(id)}`} className="text-primary no-underline hover:underline">
                        {id}
                      </Link>
                    </Inline>
                  ))}
                  {openJob.produced.artifact_ids.map((id) => (
                    <Inline key={id} gap="xs" align="center">
                      <Chip tone="info" size="xs">artifact</Chip>
                      <Link to={`/iq/distillation/lineage?focus=${encodeURIComponent(id)}`} className="text-primary no-underline hover:underline">
                        {id}
                      </Link>
                    </Inline>
                  ))}
                </Stack>
              </DetailSection>
            )}
          </Stack>
        )}
      </Drawer>
    </PageSection>
  );
}
