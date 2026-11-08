// Automate → Findings. Two kinds of "the loop needs a human":
//
//   • the DEAD-LETTER QUEUE — jobs that failed or were cancelled, with the
//     one verb a DLQ has (requeue), and
//   • sweep FINDINGS — what the scheduled org sweeps noticed, grouped by
//     sweep with promote/analyze/dismiss.
//
// Both lived at the very bottom of a 900-line Work page; a queue's failure
// lane is not an appendix.

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import {
  Button,
  Card,
  CollapsibleSection,
  DataTable,
  EmptyState,
  FilterChip,
  IconButton,
  Inline,
  LoadingState,
  PageSection,
  RedoIcon,
  SearchInput,
  Stack,
  Toolbar,
  ToolbarGroup,
  Tabs,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import { useUrlState } from '../../lib/useUrlState';
import { useFetch } from '../../hooks/useFetch';
import { useWorkEvents } from '../../hooks/useWorkEvents';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { writeJson } from '../../lib/writeJson';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { FINDINGS_GRAMMAR, findingStatusValue } from './workCollectionCommands';
import {
  filterFindings, promoteGrantBlock, sweepLabel, type FindingStatus, type ScopedSprintLike,
} from './findingsFilter';
import {
  BotOrigin, SeverityChip, T,
  type Finding, type Job,
} from './workShared';

export default function FindingsPage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  // Promoting/analysing/dismissing a finding — and running the sweep that
  // produces them — all end in the same place a finding's remedy already
  // ends up: an agent job. DispatchAgentRun is the capability that gates
  // enqueuing one everywhere else on the site (⚡ Estimate & authorize on
  // initiative-detail included), and Cedar grants it to sme, program-owner,
  // org-leader and hr-admin. Gating this page on ManageDevbox instead (a
  // devbox-fleet capability program-owner does not hold) hid every action
  // here from the role that is supposed to steer agent work from findings —
  // program-owner DEFECTS #4. `POST /api/work/findings/:id/promote` moves to
  // `DispatchAgentRun` alongside this (middleware change landing separately);
  // `/api/work/sweeps/run` has not moved server-side as of this fix, so "Run
  // sweeps now" may still 403 a DispatchAgentRun-only session until it does —
  // tracked, not silently re-hidden, since showing-then-403 beats an action
  // that a capability holder can never find.
  const canManageFindings = ready && can('DispatchAgentRun');
  // The dead-letter queue's Requeue is unrelated to findings — it puts a
  // clone of a failed *job* back on the fleet's queue, which stays a
  // devbox-fleet operation. DEFECTS #4 never asked for this one to move.
  const canRequeue = ready && can('ManageDevbox');

  // Promote runs the same grant-scoped check as dispatch-work: an SME with no
  // active sprint grant on the finding's initiative is refused with a 403.
  // That refusal used to arrive only after the click, while the Run setup on
  // the initiative warned "Sprint access required" before it — so read the
  // same `scope=mine` sprints it reads and say so in the row up front. Only
  // fetched for an sme, the one grant-scoped role. The server stays the gate.
  const { session } = useSession();
  const isSme = session?.role === 'sme';
  const { data: mySprints } = useFetch<{ sprints: ScopedSprintLike[] }>(
    isSme && canManageFindings ? '/api/sprints?scope=mine' : null,
  );

  const [findingStatus, setFindingStatus] = useState<FindingStatus>('open');
  const [view, setView] = useUrlState<string>('view', raw => raw === 'failed' ? 'failed' : 'findings', value => value === 'findings' ? null : value);

  const {
    data: findingsData, isLoading: findingsLoading, error: findingsError, degraded: findingsDegraded,
    refresh: refreshFindings,
  } = useFetch<{ findings: Finding[] }>(`/api/work/findings?status=${findingStatus}&limit=200`, 20_000);
  const findingsFailure = findingsError ?? findingsDegraded;
  const { data: jobsData, isLoading: jobsLoading, refresh: refreshJobs } = useFetch<{ jobs: Job[] }>('/api/work/jobs?limit=100', 15_000);
  // See the shared list-page loading pattern comment in QueuePage.tsx: only
  // the FIRST fetch for each list counts as "loading" for skeleton purposes,
  // never a background poll refresh of data already on screen.
  const jobsLoadingFirst = jobsLoading && !jobsData;
  const findingsLoadingFirst = findingsLoading && !findingsData;

  useWorkEvents(() => { refreshJobs(); refreshFindings(); });

  // The server already scopes GET /api/work/findings?status= to the
  // selected bucket, but re-applying the filter client-side means the rows
  // on screen can never disagree with the pressed pill — a fetch that
  // resolves late (a fast click, a slow network) can't flash a stale
  // status's rows under the newly-selected filter.
  // Deep links from Explore's rare-skill strip arrive as ?sweep=bus_factor&q=<skill>,
  // or — once the strip has matched the skill to a real finding —
  // ?sweep=bus_factor&finding=<id>. The sweep/q pair narrows the groups and
  // rows; `finding` instead names one specific row: it auto-opens its sweep
  // group and scrolls/highlights it, rather than narrowing the list. All
  // three are shown as removable chips so the reader can see what the URL
  // did to the list.
  const [searchParams, setSearchParams] = useSearchParams();
  const sweepParam = searchParams.get('sweep')?.trim() || null;
  const qParam = searchParams.get('q')?.trim() || null;
  const findingParam = searchParams.get('finding')?.trim() || null;
  const clearParam = (key: 'sweep' | 'q' | 'finding') => {
    const next = new URLSearchParams(searchParams);
    next.delete(key);
    setSearchParams(next, { replace: true });
  };
  // The findings search IS the `q` deep-link filter: the toolbar box, the
  // removable chip and the composer read and write the same URL param.
  const setFindingQuery = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value.trim()) next.set('q', value); else next.delete('q');
    setSearchParams(next, { replace: true });
  };
  const findingsAdapter = collectionCommandAdapter(FINDINGS_GRAMMAR, {
    setQuery: setFindingQuery,
    // `reset` passes '': back to Open, and the sweep/search deep-link filters
    // go with it (one URL write, so the two resets cannot race).
    setFilter: (value) => {
      setFindingStatus(findingStatusValue(value) as FindingStatus);
      if (!value) {
        const next = new URLSearchParams(searchParams);
        next.delete('q'); next.delete('sweep');
        setSearchParams(next, { replace: true });
      }
    },
    refresh: refreshFindings, id: 'findings-commands',
    scopeNote: 'Commands search the loaded sweep findings and pick a status; they never run sweeps, promote, analyse, dismiss or requeue, and the dead-letter table is unaffected.',
  });
  const findings = useMemo(() => {
    const byStatus = filterFindings(findingsData?.findings ?? [], findingStatus);
    const q = qParam?.toLowerCase();
    return byStatus.filter((f) =>
      (!sweepParam || f.sweep === sweepParam)
      && (!q || JSON.stringify(f).toLowerCase().includes(q)));
  }, [findingsData, findingStatus, sweepParam, qParam]);
  const deadLettered = useMemo(
    () => (jobsData?.jobs ?? []).filter((j) => j.status === 'failed' || j.status === 'cancelled'),
    [jobsData],
  );

  // Group by sweep, worst severity first so a single critical outranks forty
  // informational rows no matter how many of each there are.
  const grouped = useMemo<Array<[string, Finding[]]>>(() => {
    const by = new Map<string, Finding[]>();
    for (const f of findings) {
      const list = by.get(f.sweep);
      if (list) list.push(f); else by.set(f.sweep, [f]);
    }
    const rank = (items: Finding[]): number =>
      items.some((f) => f.severity === 'critical') ? 0
        : items.some((f) => f.severity === 'warning') ? 1 : 2;
    return [...by.entries()].sort((a, b) => rank(a[1]) - rank(b[1]) || b[1].length - a[1].length);
  }, [findings]);

  // ?finding=<id> deep link: scroll the named row into view once it's on the
  // page (its group is force-opened below, but the group's own open animation
  // still needs a tick before the row has a real position).
  useEffect(() => {
    if (!findingParam) return;
    const el = document.getElementById(`finding-${findingParam}`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [findingParam, findings]);

  async function requeue(job: Job) {
    const tid = toastPending('Requeueing job', job.title);
    const res = await writeJson<Job>(`/api/work/jobs/${job.id}/requeue`, 'POST');
    if (!res.ok || !res.data) { toastError(tid, 'Requeue failed', res.error ?? 'unknown error'); return; }
    toastSuccess(tid, 'Back on the queue', 'the next idle worker picks it up');
    refreshJobs();
    navigate(`/iq/work/${res.data.id}`);
  }

  async function promote(f: Finding) {
    const tid = toastPending('Putting a worker on it', f.title);
    // No prompt here on purpose: the remedy belongs to the sweep that
    // produced the finding, so the server builds it.
    const res = await writeJson<Job & { jobId?: string }>(`/api/work/findings/${f.id}/promote`, 'POST');
    if (!res.ok) {
      if (res.status === 409 && res.data?.jobId) {
        toastError(tid, 'Already has a worker', 'opening the existing job');
        navigate(`/iq/work/${res.data.jobId}`);
        return;
      }
      toastError(tid, 'Promote failed', res.error ?? 'unknown error');
      return;
    }
    toastSuccess(tid, 'Worker queued', 'opening the job so you can watch it run');
    refreshFindings();
    navigate(`/iq/work/${res.data!.id}`);
  }

  async function analyze(f: Finding) {
    const tid = toastPending('Reading the document', 'extracting the links it should have');
    const res = await writeJson<{
      links?: unknown[]; proposals?: unknown[]; problem?: string; candidatesConsidered?: number;
    }>(`/api/work/findings/${f.id}/analyze`, 'POST');
    if (!res.ok) { toastError(tid, 'Analysis failed', res.error ?? 'unknown error'); return; }
    const a = res.data!;
    if (a.problem) { toastError(tid, 'Could not analyse', a.problem); return; }
    const n = a.proposals?.length ?? 0;
    if (n === 0) {
      toastSuccess(tid, 'No links found',
        `Nothing in the graph (${a.candidatesConsidered ?? 0} entities) is genuinely referenced.`);
    } else {
      toastSuccess(tid, `${n} link${n === 1 ? '' : 's'} proposed`, 'review them on the Overview before they touch the graph');
    }
    refreshFindings();
  }

  async function analyzeBatch(sweep: string, count: number) {
    const n = Math.min(count, 10);
    const tid = toastPending(`Reading ${n} documents`, 'extracting the links each one should have');
    const res = await writeJson<{
      analysed: number; proposed: number; alreadyKnown: number;
      noLinks: number; failed: number; remaining: number;
    }>('/api/work/findings/analyze-batch', 'POST', { sweep, limit: n });
    if (!res.ok) { toastError(tid, 'Batch analysis failed', res.error ?? 'unknown error'); return; }
    const r = res.data!;
    const parts = [
      r.proposed > 0 ? `${r.proposed} links proposed` : null,
      r.noLinks > 0 ? `${r.noLinks} had nothing to link` : null,
      r.alreadyKnown > 0 ? `${r.alreadyKnown} already proposed` : null,
      r.failed > 0 ? `${r.failed} failed` : null,
      r.remaining > 0 ? `${r.remaining} still to go` : null,
    ].filter(Boolean);
    toastSuccess(tid, `Analysed ${r.analysed} documents`, parts.join(' · ') || 'nothing to do');
    refreshFindings();
  }

  async function dismiss(f: Finding) {
    const tid = toastPending('Dismissing finding', f.title);
    const res = await writeJson(`/api/work/findings/${f.id}/dismiss`, 'POST');
    if (!res.ok) { toastError(tid, 'Dismiss failed', res.error ?? 'unknown error'); return; }
    toastSuccess(tid, 'Dismissed', 'it will stay quiet unless it changes');
    refreshFindings();
  }

  async function runSweeps() {
    const tid = toastPending('Running org sweeps', 'scanning the graph and knowledge base…');
    const res = await writeJson<{
      results?: Array<{ sweep: string; found: number; created: number; resolved: number }>;
      released?: number;
    }>('/api/work/sweeps/run', 'POST', {});
    if (!res.ok) { toastError(tid, 'Sweeps failed', res.error ?? 'unknown error'); return; }
    const body = res.data!;
    const results = body.results ?? [];
    const created = results.reduce((n, r) => n + r.created, 0);
    const resolved = results.reduce((n, r) => n + r.resolved, 0);
    const parts = [
      created > 0 ? `${created} new` : null,
      resolved > 0 ? `${resolved} resolved` : null,
      body.released ? `${body.released} put back (worker never delivered)` : null,
    ].filter(Boolean);
    toastSuccess(tid, 'Sweeps complete', parts.length ? parts.join(' · ') : 'nothing changed');
    refreshFindings();
  }

  const dlqColumns: DataTableColumn<Job>[] = [
    {
      key: 'title', header: 'Job', sortable: true,
      // A real Link, not just the row's onClick (the row click is a bare
      // <tr onClick>); the failure text is its tooltip, the bot its own column.
      render: (j) => (
        <Link
          to={`/iq/work/${j.id}`}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="text-sm font-medium text-text-primary no-underline hover:text-primary truncate"
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
      key: 'attempts', header: 'Attempts', numeric: true,
      render: (j) => `${j.attempts}/${j.maxAttempts}`,
    },
    {
      key: 'createdAt', header: 'Age', numeric: true, sortable: true,
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
      render: (j) => relativeTime(j.createdAt),
    },
  ];

  return (
    <PageSection
      title="Findings"
      actions={canManageFindings
        ? <Button size="sm" variant="secondary" onClick={() => void runSweeps()}>Run sweeps now</Button>
        : undefined}
    >
      <Tabs badgeStyle="plain" aria-label="Finding views" value={view} onValueChange={setView} items={[
        { id: 'findings', label: 'Findings' },
        { id: 'failed', label: 'Failed runs', badge: deadLettered.length || undefined },
      ]} />
      {view === 'failed' && <PageSection size="sm" title="Failed runs" description="Failed or cancelled runs. Requeue creates a new attempt.">
      <Stack gap="none" className="mb-6">
        <DataTable<Job>
          data={deadLettered}
          columns={dlqColumns}
          keyField={(j) => j.id}
          onRowClick={(j) => navigate(`/iq/work/${j.id}`)}
          rowActions={canRequeue ? (j) => (
            <IconButton
              size="sm"
              icon={<RedoIcon />}
              aria-label={`Requeue ${j.title}`}
              title="Requeue"
              onClick={() => void requeue(j)}
            />
          ) : undefined}
          pageSize={10}
          emptyMessage="No failed or cancelled runs."
          loading={jobsLoadingFirst}
        />
      </Stack>

      </PageSection>}
      {view === 'findings' && (
      <Stack gap="sm" className="min-w-0">
        {/* ── Sweep findings, grouped. The group header is the unit of
               attention; the rows are the drill-in. ── */}
        <Toolbar wrap aria-label="Finding filters">
          <ToolbarGroup aria-label="Status">
            <Tabs aria-label="Finding status" variant="segmented" value={findingStatus} onValueChange={value => setFindingStatus(value as FindingStatus)}
              items={(['open', 'promoted', 'resolved', 'dismissed'] as const).map(status => ({ id: status, label: status[0]!.toUpperCase() + status.slice(1) }))} />
          </ToolbarGroup>
          <ToolbarGroup aria-label="Search">
            <SearchInput size="sm" value={searchParams.get('q') ?? ''} onChange={setFindingQuery} placeholder="Search findings…" aria-label="Search findings" className="w-56 max-w-full" />
          </ToolbarGroup>
          {(sweepParam || qParam || findingParam) && (
            <ToolbarGroup aria-label="Deep-link filters">
              {sweepParam && (
                <FilterChip active size="sm" onClick={() => clearParam('sweep')}>
                  Sweep: {sweepLabel(sweepParam)} ×
                </FilterChip>
              )}
              {qParam && (
                <FilterChip active size="sm" onClick={() => clearParam('q')}>
                  “{qParam}” ×
                </FilterChip>
              )}
              {findingParam && (
                <FilterChip active size="sm" onClick={() => clearParam('finding')}>
                  Finding highlighted ×
                </FilterChip>
              )}
            </ToolbarGroup>
          )}
        </Toolbar>

        {findingsFailure && (
          <UnavailableNotice
            error={findingsFailure}
            what="findings"
            source="Findings are read from Aurora"
            onRetry={refreshFindings}
            className="mb-4"
          />
        )}

        {!findingsFailure && (
        <Card padding="none" className="overflow-hidden @container">
          {findingsLoadingFirst ? (
            // Findings render as grouped, custom rows (CollapsibleSection +
            // hand-rolled row markup below), not a DataTable — there's no
            // `loading` prop to hand this to, so the frame (toolbar, Card)
            // stays mounted and this is the narrowest honest stand-in.
            <LoadingState label="Loading findings…" />
          ) : findings.length === 0 ? (
            <EmptyState
              title="Nothing here"
              description={findingStatus === 'open'
                ? canManageFindings
                  ? 'Nothing open. Sweeps run every 6 hours, or run one now.'
                  : 'Nothing open. Sweeps run automatically every 6 hours.'
                : findingStatus === 'resolved'
                  ? 'Nothing resolved yet. A finding resolves when a later sweep stops reproducing it.'
                  : `No ${findingStatus} findings.`}
              {...(findingStatus === 'open' && canManageFindings
                ? { actionLabel: 'Run sweeps now', onAction: () => void runSweeps() }
                : {})}
            />
          ) : grouped.map(([sweep, items]) => {
            const worst = items.some((f) => f.severity === 'critical') ? 'critical'
              : items.some((f) => f.severity === 'warning') ? 'warning' : 'info';
            return (
              <CollapsibleSection
                key={sweep}
                className="rounded-none border-x-0 border-t-0 last:border-b-0"
                defaultOpen
                badge={<SeverityChip severity={worst} size="md" />}
                title={
                  <Inline align="center" gap="sm">
                    <T size="sm" weight="semibold" tone="primary">{sweepLabel(sweep)}</T>
                    <T size="xs" weight="normal" tone="tertiary">
                      {items.length} finding{items.length === 1 ? '' : 's'}
                    </T>
                  </Inline>
                }
              >
                {/* Bounded to ten per press so the cost of a click stays
                    predictable; the toast says how many remain. */}
                {canManageFindings && findingStatus === 'open' && items.some((f) => f.entityType === 'document') && (
                  <Stack gap="none" align="start" className="px-4 py-3">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={(e) => { e.stopPropagation(); void analyzeBatch(sweep, items.length); }}
                    >
                      Find links in {Math.min(items.length, 10)} of these
                    </Button>
                  </Stack>
                )}

                {items.map((f) => (
                  <Inline
                    key={f.id}
                    id={`finding-${f.id}`}
                    align="center"
                    gap="sm"
                    className={`px-4 py-3 border-t border-border min-w-0 flex-col items-stretch @3xl:flex-row @3xl:items-center ${
                      f.id === findingParam ? 'bg-primary/10 ring-1 ring-inset ring-primary' : 'bg-surface-hover/30'
                    }`}
                  >
                    <Stack gap="xs" className="flex-1 min-w-0">
                      <Inline gap="sm" align="start"><SeverityChip severity={f.severity} /><T size="sm" weight="medium" tone="primary" wrap>{f.title}</T></Inline>
                      {f.detail && <T size="xs" tone="secondary" wrap>{f.detail}</T>}
                    </Stack>
                    {f.jobId ? (
                      <Link to={`/iq/work/${f.jobId}`} className="text-sm text-primary no-underline hover:underline shrink-0">
                        see the work →
                      </Link>
                    ) : canManageFindings && findingStatus === 'open' ? (
                      <Inline gap="xs" className="shrink-0">
                        {f.entityType === 'document' && (
                          <Button
                            size="sm"
                            variant="primary"
                            onClick={() => void analyze(f)}
                            title="Read the document and propose the graph links it is missing"
                          >
                            Find the links
                          </Button>
                        )}
                        <PromoteAction
                          block={promoteGrantBlock(f, isSme, mySprints?.sprints ?? null)}
                          onPromote={() => void promote(f)}
                        />
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={() => void dismiss(f)}
                          title="Stop reporting this unless it changes"
                        >
                          Dismiss
                        </Button>
                      </Inline>
                    ) : null}
                  </Inline>
                ))}
              </CollapsibleSection>
            );
          })}
        </Card>
        )}
      </Stack>)}
      <CollectionCommandHost adapter={findingsAdapter} />
    </PageSection>
  );
}

/** "Put a worker on it", or — when the grant check would refuse it — the same
 *  button disabled beside the reason, the way the Run setup says "Sprint
 *  access required" before Authorize rather than after. */
function PromoteAction({ block, onPromote }: {
  block: ReturnType<typeof promoteGrantBlock>;
  onPromote: () => void;
}) {
  if (!block) {
    return <Button size="sm" variant="secondary" onClick={onPromote}>Put a worker on it</Button>;
  }
  const where = block.initiativeName ?? "this finding's initiative";
  return (
    <>
      <T size="xs" className="text-warning whitespace-nowrap">Sprint access required</T>
      <Link to="/iq/sprints" className="text-xs text-primary no-underline hover:underline whitespace-nowrap">Open sprints</Link>
      <Button
        size="sm"
        variant="secondary"
        disabled
        title={`You hold no active sprint grant on ${where}, so a worker would be refused — ask the release manager for a grant`}
        aria-label={`Put a worker on it — unavailable: no active sprint grant on ${where}`}
      >
        Put a worker on it
      </Button>
    </>
  );
}
