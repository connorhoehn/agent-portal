// Automate → Overview. The card dashboard for the agentic loop: the queue's
// pulse (depth, the bots pulling from it, drain ETA), the three numbers that
// matter, and everything BLOCKED ON A HUMAN — agent questions and finished
// work awaiting review, answered in the docked composer's prompt deck
// (workAttentionPrompts.ts). The queue's row-level detail lives on /iq/work/queue;
// findings and the DLQ on /iq/work/findings — this page is the glance, not
// the archive.

import { useCallback, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button, Card, CollectionToolbar, InlineAlert, PageSection, Stack, StatStrip,
  DataTable, Divider, PageHeader, Disclosure, type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands';
import { INBOX_RUNS_GRAMMAR, recentFinishedRuns } from './workCollectionCommands';
import { useFetch } from '../../hooks/useFetch';
import { useWorkEvents } from '../../hooks/useWorkEvents';
import { useCapabilities } from '../../lib/capabilities';
import { durationLabel, relativeTime } from '../../lib/relativeTime';
import { toastSuccess } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { usd } from '../../lib/format';
import { QueuePulse } from './QueuePulse';
import { attentionCount, attentionPrompts } from './workAttentionPrompts';
import { ACTIVE_RUNS_URL, dispatchedRunsNoun, type DispatchedRun } from './dispatchedRuns';
import {
  JobStatusPill, PROPOSAL_LABELS, T, money,
  type Job, type LabConsult, type Proposal, type Summary,
} from './workShared';

/** GET /api/rediscovery/stats — the number that justifies the rest of the
 * infrastructure: what the agent didn't have to rediscover. `usdAvoidedSeries`
 * is one point per day across `windowDays`, oldest first — see
 * providers/rediscovery.ts::rediscoveryStats. */
interface RediscoveryStats {
  shortCircuits: number; dismissals: number; usdAvoided: number; minutesAvoided: number; windowDays: number;
  usdAvoidedSeries: number[];
}

export default function WorkHomePage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  const { data: summary, error: summaryError, degraded: summaryDegraded, refresh: refreshSummary } = useFetch<Summary>('/api/work/summary', 8_000);
  const summaryFailure = summaryError ?? summaryDegraded;
  // Pending consults poll on the same cadence as the summary: each one is a
  // RUNNING agent blocked on a human, which outranks everything else here.
  const { data: consultData, refresh: refreshConsults } =
    useFetch<{ consults: LabConsult[] }>('/api/lab/consults?status=pending', 8_000);
  const { data: jobsData, error: jobsError, isLoading: jobsLoading, refresh: refreshJobs } = useFetch<{ jobs: Job[] }>('/api/work/jobs?limit=50', 8_000);
  // The header's "N running" counts dispatched runs, which this queue never
  // holds (dispatchedRuns.ts) — so the queue section says so rather than
  // reading Running 0 beside it with no explanation.
  const { data: dispatchedData } = useFetch<{ runs: DispatchedRun[] }>(ACTIVE_RUNS_URL, 10_000, { share: true });
  const dispatchedCount = dispatchedData?.runs.length ?? 0;
  const { data: proposalsData, refresh: refreshProposals } = useFetch<{ proposals: Proposal[] }>('/api/work/proposals?status=pending', 20_000);
  // Slower cadence than the rest of the board — this number moves on the
  // scale of decisions made, not queue churn.
  const { data: rediscovery } = useFetch<RediscoveryStats>('/api/rediscovery/stats', 60_000);

  const pendingConsults = consultData?.consults ?? [];
  // Recent runs' search: one state for the toolbar box and the composer.
  const [runQuery, setRunQuery] = useState('');

  const refreshAll = useCallback(() => {
    refreshSummary(); refreshJobs(); refreshProposals(); refreshConsults();
  }, [refreshSummary, refreshJobs, refreshProposals, refreshConsults]);

  useWorkEvents(refreshAll);

  const s = summary;
  const jobs = jobsData?.jobs ?? [];
  const proposals = proposalsData?.proposals ?? [];

  const active = (s?.jobs['running'] ?? 0) + (s?.jobs['claimed'] ?? 0);
  const needsReview = s?.jobs['awaiting_review'] ?? 0;
  const pendingProposals = s?.proposals['pending'] ?? 0;

  const recent = recentFinishedRuns(jobs, runQuery);
  const openRun = (id: string) => navigate(`/iq/work/${encodeURIComponent(id)}`);
  const runsAdapter = collectionCommandAdapter(INBOX_RUNS_GRAMMAR, {
    setQuery: setRunQuery, refresh: refreshJobs, label: 'Recent runs', id: 'inbox-recent-runs-commands',
    scopeNote: 'Commands search the finished runs on the loaded queue page and open one run; they never accept, reject, requeue or start work.',
    open: (target) => {
      const run = resolveCollectionTarget(target, recent);
      openRun(run.id);
      return `Opening ${run.title}.`;
    },
  });
  const recentColumns: DataTableColumn<Job>[] = [
    { key: 'title', header: 'Run', render: (job) => <Link to={`/iq/work/${encodeURIComponent(job.id)}`} className="text-[13px] text-text-primary hover:text-primary hover:underline">{job.title}</Link> },
    { key: 'status', header: 'Result', render: (job) => <JobStatusPill status={job.status} /> },
    { key: 'finishedAt', header: 'Finished', numeric: true, render: (job) => relativeTime(job.finishedAt!) },
    { key: 'duration', header: 'Duration', numeric: true, render: (job) => durationLabel(job.result?.durationMs) },
    { key: 'open', header: '', render: () => <span aria-hidden>›</span> },
  ];

  // The prompt deck's answers: the same writes as before, but a failure stays
  // on the card (thrown) instead of a toast, so the item is not lost.
  const deckHandlers = {
    answerConsult: async (id: string, answer: string) => { await sendJson(`/api/lab/consults/${id}/answer`, 'POST', { answer }); toastSuccess(null, 'Answer sent', 'The agent picks it up on its next poll (≤2s).'); refreshAll(); },
    reviewJob: async (job: Job, decision: 'accept' | 'reject') => { await sendJson(`/api/work/jobs/${job.id}/review`, 'POST', { decision }); refreshAll(); },
    decideProposal: async (p: Proposal, decision: 'approve' | 'reject') => {
      const body = await sendJson<Proposal>(`/api/work/proposals/${p.id}/decide`, 'POST', { decision });
      refreshAll();
      if (body.status === 'failed') throw new Error(body.applyError ?? 'The change could not be applied.');
    },
  };
  const waiting = attentionCount(pendingConsults, jobs, proposals);
  const prompts = attentionPrompts({ consults: pendingConsults, jobs, proposals, canDecide: canManage, money, label: (kind) => PROPOSAL_LABELS[kind] ?? kind }, deckHandlers);

  return (
    <Stack gap="md" data-testid="automate-inbox">
      <PageHeader title="Inbox" description="Questions and approvals waiting for you."
        actions={canManage ? <Button size="sm" variant="primary" onClick={() => navigate('/iq/work/queue?compose=1')}>New run</Button> : undefined} />
      {/* What needs a person is answered in the docked composer's prompt deck
          (agent questions, work to review, proposed graph changes — paged with
          the keyboard), so this section is one row: its count and where to
          answer, or one quiet line when nothing waits. A failed load says so
          plainly — "0 needs you" would read like a healthy, idle system. */}
      <PageSection size="sm" title="Needs your attention" data-testid="inbox-attention"
        {...(waiting > 0 ? { count: waiting, actions: <T className="text-[12px] text-text-secondary">Answer in the composer below</T> } : {})}
        {...(!summaryFailure && waiting === 0 ? { empty: 'Nothing right now — questions and reviews appear in the composer.' } : {})}>
        {summaryFailure && (
          <Card padding="md" className="border-danger/40">
            <Stack gap="xs">
              <T className="text-[13px] font-semibold text-danger">Could not reach the work queue</T>
              <T wrap className="text-[12px] text-text-secondary leading-snug">
                {summaryFailure}. The numbers below are not zero — they are unknown.
              </T>
            </Stack>
          </Card>
        )}
      </PageSection>
      <Divider spacing="none" />
      <PageSection size="sm" title="Current queue"
        description={dispatchedCount > 0
          ? `Queue jobs only — ${dispatchedRunsNoun(dispatchedCount)} from initiative work items ${dispatchedCount === 1 ? 'is' : 'are'} running outside the queue; Runs lists them.`
          : 'Queue jobs only — runs dispatched from initiative work items are listed on Runs when they are live.'}
        actions={<Link to="/iq/work/queue" className="text-[13px] text-primary hover:underline">View runs →</Link>}>
        <StatStrip variant="line" aria-label="Current queue" items={[
          { label: 'Queued', value: summaryFailure || !s ? '—' : s.jobs.queued ?? 0 },
          { label: 'Running', value: summaryFailure || !s ? '—' : active },
          { label: 'Waiting for review', value: summaryFailure || !s ? '—' : needsReview },
          { label: 'Failed', value: summaryFailure || !s ? '—' : s.jobs.failed ?? 0 },
        ]} />
      </PageSection>
      <Divider spacing="none" />
      <PageSection size="sm" title="Recent runs" actions={<Link to="/iq/work/queue" className="text-[13px] text-primary hover:underline">All runs →</Link>}>
        {/* The section that owns the table owns its command input; the input
            docks at the bottom of the content column, spanning it, with the
            rest of the page above it (CollectionCommandHost → ColumnDock). */}
        <Stack gap="sm" className="min-w-0">
          <CollectionToolbar label="Recent run filters"
            search={{ value: runQuery, onChange: setRunQuery, placeholder: 'Search recent runs', 'aria-label': 'Search recent runs' }}
            onRefresh={refreshJobs} refreshing={jobsLoading} />
          {jobsError ? <InlineAlert tone="error">{jobsError}</InlineAlert> : <DataTable data={recent} columns={recentColumns} keyField={(job) => job.id} onRowClick={(job) => openRun(job.id)} frameless loading={jobsLoading && !jobsData} emptyMessage={runQuery.trim() ? 'No finished run matches this search' : 'No completed runs yet'} />}
          <CollectionCommandHost adapter={runsAdapter} prompts={prompts} />
        </Stack>
      </PageSection>
      <Link to="/iq/work/findings" className="text-[13px] text-primary hover:underline">{s && !summaryFailure ? `${s.findings.open} open findings` : 'View findings'} →</Link>
      <Disclosure summary="Queue operations" variant="plain" density="compact">
        <QueuePulse summary={s ? { jobs: s.jobs, busyBoxes: s.busyBoxes } : null} jobs={jobs} degraded={!!summaryFailure} />
        {rediscovery && <T className="mt-3 text-[12px] text-text-tertiary">Rediscovery avoided {usd(rediscovery.usdAvoided)} · {rediscovery.shortCircuits} short-circuits · {rediscovery.windowDays}d</T>}
      </Disclosure>
    </Stack>
  );
}
