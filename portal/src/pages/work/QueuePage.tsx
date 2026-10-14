// Automate → Queue. A queue page that looks like a queue: the jobs as short
// table rows (filterable by state, failed rows carry the DLQ's requeue verb),
// and beneath it the work from the initiatives that is READY to be assigned —
// short rows you click to get a confirmation modal, not a wall of cards.

import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  Card,
  Chip,
  DataTable,
  EmptyState,
  FilterChip,
  IconButton,
  Inline,
  Modal,
  PageSection,
  PlayCircleIcon,
  RedoIcon,
  SearchInput,
  Stack,
  TaskComposer,
  Toolbar,
  ToolbarGroup,
  ToolbarLabel,
  type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useWorkEvents } from '../../hooks/useWorkEvents';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { sendJson, writeJson } from '../../lib/writeJson';
import { AssignJobModal } from './AssignJobModal';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { QUEUE_GRAMMAR, matchesJob, queueFilterValue } from './workCollectionCommands';
import {
  ACTIVE_RUNS_URL, dispatchedRunDestination, dispatchedRunLabel, dispatchedRunsNoun, type DispatchedRun,
} from './dispatchedRuns';
import {
  BotOrigin, GraphUpdatesLink, JobStatusPill, LIVE_STATUSES, ServesItem,
  SUGGESTION_LABEL, SUGGESTION_TONE, T, money, serves,
  type Job, type Summary, type WorkSuggestion,
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

  const [params, setParams] = useSearchParams();
  const filter = params.get('status') ?? 'all';
  const setFilter = (status: string) => { const next = new URLSearchParams(params); next.set('status', status); setParams(next); };
  // The queue's search: one state for the toolbar box and the composer.
  const [query, setQuery] = useState('');
  // "New run" opens the composer in a dialog over the table, keyed on
  // `?compose=1` so the Inbox's button, this page's own button and a pasted
  // link all land the same way. The composer used to sit under the full runs
  // table and this page scrolled to it — but the scroll fired before the
  // table above it had rendered, so after an in-app navigation it landed
  // 1,650px short of the form with focus on <body>. A dialog has no position
  // to miss, the library Modal puts focus in its first field (the title), and
  // the table stays where the house rule wants it: above the fold.
  const composing = canManage && params.get('compose') === '1';
  // Closing hands focus to this page's own New run button. The Modal returns
  // focus to whatever opened it, but arriving from the Inbox (or a pasted
  // link) that element is gone or is <body>.
  const newRunRef = useRef<HTMLButtonElement>(null);
  const setComposing = (open: boolean) => {
    const next = new URLSearchParams(params);
    if (open) next.set('compose', '1'); else next.delete('compose');
    setParams(next, { replace: !open });
    if (!open) requestAnimationFrame(() => newRunRef.current?.focus());
  };
  const [assigning, setAssigning] = useState<WorkSuggestion | null>(null);
  const [composerBusy, setComposerBusy] = useState(false);

  const { data: jobsData, isLoading: jobsLoading, error: jobsError, degraded: jobsDegraded, refresh: refreshJobs } =
    useFetch<{ jobs: Job[] }>('/api/work/jobs?limit=100', 8_000);
  const jobsFailure = jobsError ?? jobsDegraded;
  // The filter chips' counts must be the real per-status aggregate
  // (queueStats(), the same one the Automate overview reads), never
  // `jobs.filter(...).length` against this page's own capped fetch (100
  // rows) — once a program crosses 100 jobs, a local count silently
  // under-reports every bucket while looking like a real total.
  const { data: summary } = useFetch<Summary>('/api/work/summary', 8_000);
  // Dispatched runs are not queue jobs (see dispatchedRuns.ts): they are listed
  // here, under their own heading, because this is where the header's
  // "N running" sends people. Same URL and cadence as the badge, shared, so the
  // two can never show different runs.
  const { data: dispatchedData } = useFetch<{ runs: DispatchedRun[] }>(ACTIVE_RUNS_URL, 10_000, { share: true });
  const dispatched = dispatchedData?.runs ?? [];
  const { data: suggestionsData, isLoading: suggestionsLoading, error: suggestionsError } =
    useFetch<{ suggestions: WorkSuggestion[] }>(canManage ? '/api/work/suggestions' : null, 60_000);

  // Shared list-page loading pattern (see also ProjectsPage.tsx): the page
  // frame — title, toolbar, filter chips, table header — stays mounted
  // through every state. `DataTable`'s own `loading` prop fills the body
  // with skeleton rows on first load instead of the page blanking to a bare
  // loader. Gate it `isLoading && !data` (the shape useFetch's own callers
  // use), never `isLoading` alone — a background poll tick (the queue polls
  // every 8s) sets `isLoading` true again on every refresh, and re-showing
  // the skeleton then would flash good rows out from under the reader. Once
  // `data` has landed once, later poll ticks update the table in place.
  const jobsLoadingFirst = jobsLoading && !jobsData;
  const suggestionsLoadingFirst = suggestionsLoading && !suggestionsData;

  // Live queue events — a job changing state updates the table without
  // waiting for the next poll.
  useWorkEvents(refreshJobs);

  const jobs = useMemo(() => jobsData?.jobs ?? [], [jobsData]);
  const suggestions = suggestionsData?.suggestions ?? null;

  const filtered = useMemo(() => {
    const spec = JOB_FILTERS.find((f) => f.value === filter);
    const byState = !spec || spec.statuses.length === 0 ? jobs : jobs.filter((j) => spec.statuses.includes(j.status));
    return byState.filter((j) => matchesJob(j, query));
  }, [jobs, filter, query]);

  const adapter = collectionCommandAdapter(QUEUE_GRAMMAR, {
    setQuery, setFilter: (value) => setFilter(queueFilterValue(value)), refresh: refreshJobs, id: 'queue-runs-commands',
    scopeNote: 'Commands search the loaded queue page, pick a State chip and open one run; they never queue, requeue, cancel or assign work.',
    open: (target) => {
      const job = resolveCollectionTarget(target, filtered);
      navigate(`/iq/work/${job.id}`);
      return `Opening ${job.title}.`;
    },
  });

  const countFor = (value: string): number => {
    const spec = JOB_FILTERS.find((f) => f.value === value)!;
    // Real aggregate when it has loaded; the capped local page only as a
    // fallback before the first /summary response lands.
    if (summary) {
      if (value === 'all') return summary.jobs['total'] ?? 0;
      return spec.statuses.reduce((n, status) => n + (summary.jobs[status] ?? 0), 0);
    }
    if (spec.statuses.length === 0) return jobs.length;
    return jobs.filter((j) => spec.statuses.includes(j.status)).length;
  };

  async function requeue(job: Job) {
    const tid = toastPending('Requeueing job', job.title);
    const res = await writeJson<Job>(`/api/work/jobs/${job.id}/requeue`, 'POST');
    if (!res.ok || !res.data) {
      toastError(tid, 'Requeue failed', res.error ?? `HTTP ${res.status}`);
      return;
    }
    toastSuccess(tid, 'Back on the queue', 'the next idle worker picks it up');
    refreshJobs();
    navigate(`/iq/work/${res.data.id}`);
  }

  async function enqueueFreeform(title: string, prompt: string) {
    if (!title.trim() || !prompt.trim() || composerBusy) return;
    setComposerBusy(true);
    const tid = toastPending('Queueing job', title.trim());
    try {
      const job = await sendJson<Job>('/api/work/jobs', 'POST', { title: title.trim(), prompt: prompt.trim() });
      toastSuccess(tid, 'Job queued', 'an idle worker picks it up within ~10s');
      refreshJobs();
      navigate(`/iq/work/${job.id}`, { replace: true });
    } catch (err) {
      toastError(tid, 'Could not queue job', (err as Error).message);
    } finally {
      setComposerBusy(false);
    }
  }

  // The job's NAME leads, not its status chip. A queue is scanned by "which
  // job is this" and only then by "what state is it in" — leading with a
  // five-state chip put a column of near-identical pills where the
  // identifying text should be, and pushed the one thing that tells rows
  // apart into second place. Measured against the other list surfaces: Bots,
  // Library and Promotions all lead with their entity's name; this was the
  // outlier.
  const jobColumns: DataTableColumn<Job>[] = [
    {
      key: 'title', header: 'Job', sortable: true,
      render: (j) => (
        // A real Link, not just the row's onClick: DataTable's row-click
        // is a bare <tr onClick> with no keyboard access, so this is the
        // one focusable, Enter-activatable control in the row. The failure
        // text is the link's tooltip, the bot origin its own column.
        <Link
          to={`/iq/work/${j.id}`}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="text-xs font-medium text-text-primary no-underline hover:text-primary truncate"
          title={j.error ? `${j.title} — ${j.error}` : j.title}
        >
          {j.title}
        </Link>
      ),
    },
    {
      key: 'origin', header: 'Origin',
      render: (j) => (j.botName ? <BotOrigin job={j} /> : <T size="xs" className="text-text-tertiary">—</T>),
    },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (j) => <JobStatusPill status={j.status} />,
    },
    {
      key: 'serves', header: 'Serves',
      render: (j) => serves(j)
        ? <ServesItem job={j} />
        : <T size="xs" className="text-text-tertiary">—</T>,
    },
    {
      key: 'boxId', header: 'Worker',
      render: (j) => (
        <T size="xs" className="text-text-tertiary whitespace-nowrap">
          {j.boxId ?? `priority ${j.priority}`}
        </T>
      ),
    },
    {
      key: 'createdAt', header: 'Age', sortable: true, numeric: true,
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
      render: (j) => relativeTime(j.createdAt),
    },
    {
      key: 'action', header: '', numeric: true,
      render: (j) => (
        <T size="xs" tone="tertiary" className="justify-end">
          {LIVE_STATUSES.has(j.status) ? 'watch →' : 'open →'}
        </T>
      ),
    },
  ];

  const dispatchedColumns: DataTableColumn<DispatchedRun>[] = [
    {
      key: 'workItemTitle', header: 'Work item',
      render: (r) => {
        const dest = dispatchedRunDestination(r, canManage);
        return (
          <Link
            to={dest.path}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className="text-xs font-medium text-text-primary no-underline hover:text-primary truncate"
            title={dispatchedRunLabel(r)}
          >
            {dispatchedRunLabel(r)}
          </Link>
        );
      },
    },
    {
      key: 'startedAt', header: 'Started', numeric: true,
      render: (r) => relativeTime(r.startedAt),
    },
    {
      key: 'open', header: '', numeric: true,
      render: (r) => (
        <T size="xs" tone="tertiary" className="justify-end">
          {dispatchedRunDestination(r, canManage).kind === 'computer' ? 'computer & logs →' : 'work item →'}
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
      // Row click opens the assign dialog; the Assign action in the row's
      // actions is its keyboard-reachable twin.
      render: (s) => (
        <T size="xs" className="font-medium text-text-primary truncate" title={s.title}>{s.title}</T>
      ),
    },
    {
      key: 'reason', header: 'Reason',
      render: (s) => <T size="xs" className="text-text-tertiary truncate" title={s.reason}>{s.reason}</T>,
    },
    {
      key: 'initiativeName', header: 'Initiative', sortable: true,
      render: (s) => (
        <Link
          to={`/iq/projects/${s.initiativeId}`}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          title={`Open ${s.initiativeName}`}
          className="text-xs text-text-secondary whitespace-nowrap no-underline hover:text-primary hover:underline"
        >
          {s.initiativeName}
        </Link>
      ),
    },
    {
      key: 'storyPoints', header: 'Est.', numeric: true, sortable: true,
      compare: (a, b) => (a.storyPoints ?? 0) - (b.storyPoints ?? 0),
      render: (s) => (
        <T size="xs" className="text-text-secondary tabular-nums whitespace-nowrap">
          {s.storyPoints != null ? `${s.storyPoints} pts` : '—'}
          {s.estimatedCostUsd != null ? ` · ${money(s.estimatedCostUsd)}` : ''}
        </T>
      ),
    },
  ];

  return (
    <PageSection
      title="Runs"
      actions={(
        <Inline gap="sm" align="center">
          <GraphUpdatesLink />
          {canManage && <Button ref={newRunRef} size="sm" variant="primary" onClick={() => setComposing(true)}>New run</Button>}
        </Inline>
      )}
    >
      <AssignJobModal
        suggestion={assigning}
        onClose={() => setAssigning(null)}
        onQueued={(job) => { setAssigning(null); refreshJobs(); navigate(`/iq/work/${job.id}`); }}
      />

      {/* ── Dispatched runs: live, and not on the queue below ── */}
      {dispatched.length > 0 && (
        <Stack gap="xs" className="mb-4" data-testid="dispatched-runs">
          <Inline align="baseline" gap="sm">
            <T size="sm" className="font-semibold text-text-primary">Running now outside the queue</T>
            <T size="xs" className="text-text-tertiary">
              {dispatchedRunsNoun(dispatched.length)} from initiative work items — they run on a computer directly, so the job counts below leave them out
            </T>
          </Inline>
          <DataTable<DispatchedRun>
            data={dispatched}
            columns={dispatchedColumns}
            keyField={(r) => r.id}
            onRowClick={(r) => navigate(dispatchedRunDestination(r, canManage).path)}
            emptyMessage="Nothing dispatched is running"
          />
        </Stack>
      )}

      {/* ── The queue itself; its command input docks at the bottom of the
             content column and drives this block (ColumnDock). ── */}
      <Stack gap="sm" className="min-w-0">
        <Toolbar wrap aria-label="Job filters">
          <ToolbarGroup aria-label="State">
            <ToolbarLabel>State</ToolbarLabel>
            {JOB_FILTERS.map((f) => (
              <FilterChip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)} size="sm">
                {f.label}{countFor(f.value) > 0 ? ` ${countFor(f.value)}` : ''}
              </FilterChip>
            ))}
          </ToolbarGroup>
          <ToolbarGroup aria-label="Search">
            <SearchInput size="sm" value={query} onChange={setQuery} placeholder="Search runs…" aria-label="Search runs" className="w-56 max-w-full" />
          </ToolbarGroup>
        </Toolbar>

        {jobsFailure && (
          <UnavailableNotice
            error={jobsFailure}
            what="the job queue"
            source="Jobs are read from Aurora"
            onRetry={refreshJobs}
            className="mb-4"
          />
        )}

        {!jobsFailure && (!jobsLoadingFirst && filtered.length === 0 ? (
          <EmptyState
            title={filter === 'failed' ? 'Nothing dead-lettered' : 'Nothing here'}
            description={query.trim()
              ? 'No loaded run matches this search. Clear the search to see the rest of the queue.'
              : filter !== 'all'
              ? `No ${JOB_FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} jobs right now.`
              // "Assign a work item below" / "write one from scratch" both
              // point at sections gated on ManageDevbox (canManage) — naming
              // them to a role without that capability was a dead reference
              // (org-leader DEFECTS #5). Point everyone else at the two doors
              // that actually put something on the queue for them instead.
              : canManage
                ? 'No jobs yet — assign a work item below, or write one from scratch with New run.'
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
            rowActions={(j) => ((j.status === 'failed' || j.status === 'cancelled') && canManage ? (
              <IconButton
                size="sm"
                icon={<RedoIcon />}
                aria-label={`Requeue ${j.title}`}
                title="Requeue"
                onClick={() => void requeue(j)}
              />
            ) : null)}
            pageSize={25}
            emptyMessage="No jobs"
            loading={jobsLoadingFirst}
          />
        ))}
        <CollectionCommandHost adapter={adapter} />
      </Stack>

      {/* ── Ready to assign — the initiatives' open work, short form ── */}
      {canManage && (
        <Stack gap="sm" align="start" className="mt-6">
          <Inline align="baseline" gap="sm">
            <T size="sm" className="font-semibold text-text-primary">Ready to assign</T>
            <T size="xs" className="text-text-tertiary">
              open work from your initiatives — click a row to queue it for an agent
            </T>
          </Inline>
          {suggestionsError ? (
            <Card padding="md" className="w-full">
              <T size="xs" className="text-text-tertiary">
                Could not read your work items — New run still works.
              </T>
            </Card>
          ) : !suggestionsLoadingFirst && suggestions != null && suggestions.length === 0 ? (
            <Card padding="md" className="w-full">
              <T size="xs" className="text-text-tertiary">
                Nothing blocked, in review, or waiting to start on your initiatives.
              </T>
            </Card>
          ) : (
            <DataTable<WorkSuggestion>
              data={suggestions ?? []}
              columns={suggestionColumns}
              keyField={(s) => s.id}
              onRowClick={(s) => setAssigning(s)}
              rowActions={(s) => (
                <IconButton
                  size="sm"
                  icon={<PlayCircleIcon />}
                  aria-label={`Assign ${s.title} to an agent`}
                  title="Assign to agent"
                  onClick={() => setAssigning(s)}
                />
              )}
              pageSize={10}
              emptyMessage="Nothing to assign"
              className="w-full"
              loading={suggestionsLoadingFirst}
            />
          )}
        </Stack>
      )}

      {/* ── Freeform — for work that is not on any board ── */}
      <Modal
        open={composing}
        onClose={() => { if (!composerBusy) setComposing(false); }}
        ariaLabel="New run"
        maxWidth={640}
        cardClassName="p-0"
        rawChildren
      >
        <TaskComposer
          className="border-0"
          title="New run"
          description="An idle computer picks it up within ~10 seconds and works in a microVM with a persistent workspace and git."
          titlePlaceholder="Title — e.g. 'Document the Cedar policy migration'"
          promptPlaceholder="What should the worker do?"
          hint="Runs on the first idle computer · ⌘⏎ · Esc to close"
          submitLabel="Queue run"
          busy={composerBusy}
          onSubmit={({ title, prompt }) => void enqueueFreeform(title, prompt)}
        />
      </Modal>
    </PageSection>
  );
}
