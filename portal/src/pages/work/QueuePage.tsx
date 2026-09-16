// Automate → Queue. A queue page that looks like a queue: the jobs as short
// table rows (filterable by state, failed rows carry the DLQ's requeue verb),
// and beneath it the work from the initiatives that is READY to be assigned —
// short rows you click to get a confirmation modal, not a wall of cards.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button,
  Card,
  Chip,
  DataTable,
  EmptyState,
  FilterChip,
  Inline,
  PageSection,
  Stack,
  TaskComposer,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { AssignJobModal } from './AssignJobModal';
import {
  BotOrigin, GraphUpdatesLink, JobStatusPill, LIVE_STATUSES, ServesItem,
  SUGGESTION_LABEL, SUGGESTION_TONE, T, post, serves,
  type Job, type WorkSuggestion,
} from './workShared';

// Filter buckets, in queue order. `running` folds in `claimed` (both are "a
// worker has it") and `failed` folds in `cancelled` — the dead-letter bucket.
const JOB_FILTERS: Array<{ value: string; label: string; statuses: string[] }> = [
  { value: 'all',             label: 'All',             statuses: [] },
  { value: 'queued',          label: 'Queued',          statuses: ['queued'] },
  { value: 'running',         label: 'Running',         statuses: ['running', 'claimed'] },
  { value: 'awaiting_review', label: 'Awaiting review', statuses: ['awaiting_review'] },
  { value: 'failed',          label: 'Failed (DLQ)',    statuses: ['failed', 'cancelled'] },
  { value: 'done',            label: 'Done',            statuses: ['done'] },
];

export default function QueuePage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  const [filter, setFilter] = useState('all');
  const [assigning, setAssigning] = useState<WorkSuggestion | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);

  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: Job[] }>('/api/work/jobs?limit=100', 8_000);
  const { data: suggestionsData, error: suggestionsError } =
    useFetch<{ suggestions: WorkSuggestion[] }>(canManage ? '/api/work/suggestions' : null, 60_000);

  // Live queue events — a job changing state updates the table without
  // waiting for the next poll.
  useEffect(() => {
    const es = new EventSource('/api/work/events');
    es.onmessage = () => refreshJobs();
    return () => es.close();
  }, [refreshJobs]);

  const jobs = useMemo(() => jobsData?.jobs ?? [], [jobsData]);
  const suggestions = suggestionsData?.suggestions ?? null;

  const filtered = useMemo(() => {
    const spec = JOB_FILTERS.find((f) => f.value === filter);
    if (!spec || spec.statuses.length === 0) return jobs;
    return jobs.filter((j) => spec.statuses.includes(j.status));
  }, [jobs, filter]);

  const countFor = (value: string): number => {
    const spec = JOB_FILTERS.find((f) => f.value === value)!;
    if (spec.statuses.length === 0) return jobs.length;
    return jobs.filter((j) => spec.statuses.includes(j.status)).length;
  };

  async function requeue(job: Job) {
    const tid = toastPending('Requeueing job', job.title);
    try {
      const res = await post(`/api/work/jobs/${job.id}/requeue`);
      const body = await res.json() as Job & { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Back on the queue', 'the next idle worker picks it up');
      refreshJobs();
      navigate(`/iq/work/${body.id}`);
    } catch (err) {
      toastError(tid, 'Requeue failed', (err as Error).message);
    }
  }

  async function enqueueFreeform(title: string, prompt: string) {
    if (!title.trim() || !prompt.trim() || composerBusy) return;
    setComposerBusy(true);
    const tid = toastPending('Queueing job', title.trim());
    try {
      const res = await post('/api/work/jobs', { title: title.trim(), prompt: prompt.trim() });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      const job = await res.json() as Job;
      toastSuccess(tid, 'Job queued', 'an idle worker picks it up within ~10s');
      refreshJobs();
      navigate(`/iq/work/${job.id}`);
    } catch (err) {
      toastError(tid, 'Could not queue job', (err as Error).message);
    } finally {
      setComposerBusy(false);
    }
  }

  const jobColumns: DataTableColumn<Job>[] = [
    {
      key: 'status', header: 'Status', sortable: true,
      render: (j) => <JobStatusPill status={j.status} />,
    },
    {
      key: 'title', header: 'Job', sortable: true,
      render: (j) => (
        <Stack gap="none" className="min-w-0">
          <Inline align="center" gap="sm" className="min-w-0">
            {/* A real Link, not just the row's onClick: DataTable's row-click
                is a bare <tr onClick> with no keyboard access, so this is the
                one focusable, Enter-activatable control in the row. */}
            <Link
              to={`/iq/work/${j.id}`}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className="text-[12.5px] font-medium text-text-primary no-underline hover:text-primary truncate"
              title={j.title}
            >
              {j.title}
            </Link>
            <BotOrigin job={j} />
          </Inline>
          {j.error && (
            <T className="text-[11px] text-danger truncate" title={j.error}>{j.error}</T>
          )}
        </Stack>
      ),
    },
    {
      key: 'serves', header: 'Serves',
      render: (j) => serves(j)
        ? <ServesItem job={j} onOpenInitiative={(id) => navigate(`/iq/projects/${id}`)} />
        : <T className="text-[11px] text-text-tertiary">—</T>,
    },
    {
      key: 'boxId', header: 'Worker',
      render: (j) => (
        <T className="text-[11px] text-text-tertiary whitespace-nowrap">
          {j.boxId ?? `priority ${j.priority}`}
        </T>
      ),
    },
    {
      key: 'createdAt', header: 'Age', sortable: true, align: 'right',
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
      render: (j) => <T className="text-[11px] text-text-tertiary whitespace-nowrap">{relativeTime(j.createdAt)}</T>,
    },
    {
      key: 'action', header: '', align: 'right',
      render: (j) => (j.status === 'failed' || j.status === 'cancelled') && canManage ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); void requeue(j); }}
        >
          Requeue
        </Button>
      ) : (
        <T className="text-[11px] text-text-tertiary whitespace-nowrap">
          {LIVE_STATUSES.has(j.status) ? 'watch →' : 'open →'}
        </T>
      ),
    },
  ];

  const suggestionColumns: DataTableColumn<WorkSuggestion>[] = [
    {
      key: 'kind', header: 'Why',
      render: (s) => <Chip tone={SUGGESTION_TONE[s.kind]} size="sm">{SUGGESTION_LABEL[s.kind]}</Chip>,
    },
    {
      key: 'title', header: 'Work item', sortable: true,
      render: (s) => (
        <Stack gap="none" className="min-w-0">
          {/* A real Button, not just the row's onClick: DataTable's row-click
              is a bare <tr onClick> with no keyboard access, so this is the
              one focusable, Enter/Space-activatable control in the row. */}
          <Button
            variant="ghost"
            size="sm"
            className="justify-start px-0 py-0 border-0 h-fit min-w-0 truncate text-[12.5px] font-medium text-text-primary"
            title={s.title}
            onClick={(e) => { e.stopPropagation(); setAssigning(s); }}
          >
            {s.title}
          </Button>
          <T className="text-[11px] text-text-tertiary truncate" title={s.reason}>{s.reason}</T>
        </Stack>
      ),
    },
    {
      key: 'initiativeName', header: 'Initiative', sortable: true,
      render: (s) => <T className="text-[12px] text-text-secondary whitespace-nowrap">{s.initiativeName}</T>,
    },
    {
      key: 'storyPoints', header: 'Est.', align: 'right', sortable: true,
      compare: (a, b) => (a.storyPoints ?? 0) - (b.storyPoints ?? 0),
      render: (s) => (
        <T className="text-[12px] text-text-secondary tabular-nums whitespace-nowrap">
          {s.storyPoints != null ? `${s.storyPoints} pts` : '—'}
          {s.estimatedCostUsd != null ? ` · $${s.estimatedCostUsd.toFixed(2)}` : ''}
        </T>
      ),
    },
    {
      key: 'assign', header: '', align: 'right',
      render: () => (
        <T className="text-[11px] font-semibold text-primary whitespace-nowrap">Assign to agent →</T>
      ),
    },
  ];

  return (
    <PageSection title="Queue" actions={<GraphUpdatesLink />}>
      <AssignJobModal
        suggestion={assigning}
        onClose={() => setAssigning(null)}
        onQueued={(job) => { setAssigning(null); refreshJobs(); navigate(`/iq/work/${job.id}`); }}
      />

      {/* ── The queue itself ── */}
      <Toolbar wrap aria-label="Job filters">
        <ToolbarGroup aria-label="State">
          <ToolbarLabel>State</ToolbarLabel>
          {JOB_FILTERS.map((f) => (
            <FilterChip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)} size="sm">
              {f.label}{countFor(f.value) > 0 ? ` ${countFor(f.value)}` : ''}
            </FilterChip>
          ))}
        </ToolbarGroup>
      </Toolbar>

      {filtered.length === 0 ? (
        <EmptyState
          title={filter === 'failed' ? 'Nothing dead-lettered' : 'Nothing here'}
          description={filter !== 'all'
            ? `No ${JOB_FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} jobs right now.`
            // "Assign a work item below" / "write one from scratch" both
            // point at sections gated on ManageDevbox (canManage) — naming
            // them to a role without that capability was a dead reference
            // (org-leader DEFECTS #5). Point everyone else at the two doors
            // that actually put something on the queue for them instead.
            : canManage
              ? 'No jobs yet — assign a work item below, or write one from scratch.'
              : (
                <>
                  No jobs yet —{' '}
                  <Link to="/iq/work/findings" className="text-primary no-underline hover:underline">
                    promote a finding
                  </Link>
                  {' '}or{' '}
                  <Link to="/iq/projects" className="text-primary no-underline hover:underline">
                    dispatch work from an initiative
                  </Link>.
                </>
              )}
        />
      ) : (
        <DataTable<Job>
          data={filtered}
          columns={jobColumns}
          keyField={(j) => j.id}
          onRowClick={(j) => navigate(`/iq/work/${j.id}`)}
          pageSize={25}
          emptyMessage="No jobs"
        />
      )}

      {/* ── Ready to assign — the initiatives' open work, short form ── */}
      {canManage && (
        <Stack gap="sm" align="start" className="mt-6">
          <Inline align="baseline" gap="sm">
            <T className="text-[13px] font-semibold text-text-primary">Ready to assign</T>
            <T className="text-[11px] text-text-tertiary">
              open work from your initiatives — click a row to queue it for an agent
            </T>
          </Inline>
          {suggestionsError ? (
            <Card padding="md" className="w-full">
              <T className="text-[12px] text-text-tertiary">
                Could not read your work items — the composer below still works.
              </T>
            </Card>
          ) : suggestions != null && suggestions.length === 0 ? (
            <Card padding="md" className="w-full">
              <T className="text-[12px] text-text-tertiary">
                Nothing blocked, in review, or waiting to start on your initiatives.
              </T>
            </Card>
          ) : (
            <DataTable<WorkSuggestion>
              data={suggestions ?? []}
              columns={suggestionColumns}
              keyField={(s) => s.id}
              onRowClick={(s) => setAssigning(s)}
              pageSize={10}
              emptyMessage="Nothing to assign"
              className="w-full"
            />
          )}
        </Stack>
      )}

      {/* ── Freeform — for work that is not on any board ── */}
      {canManage && (
        <TaskComposer
          className="mt-6"
          title="Or write a job from scratch"
          description="An idle computer picks it up within ~10 seconds and works in a microVM with a persistent workspace and git."
          titlePlaceholder="Title — e.g. 'Document the Cedar policy migration'"
          promptPlaceholder="What should the worker do?"
          hint="Runs on the first idle computer · ⌘⏎"
          submitLabel="Queue job"
          busy={composerBusy}
          onSubmit={({ title, prompt }) => void enqueueFreeform(title, prompt)}
        />
      )}
    </PageSection>
  );
}
