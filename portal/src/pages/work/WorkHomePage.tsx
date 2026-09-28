// Automate → Overview. The card dashboard for the agentic loop: the queue's
// pulse (depth, the bots pulling from it, drain ETA), the three numbers that
// matter, and everything BLOCKED ON A HUMAN — agent questions and finished
// work awaiting review. The queue's row-level detail lives on /iq/work/queue;
// findings and the DLQ on /iq/work/findings — this page is the glance, not
// the archive.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button, Card, Chip, ConsultCard, Inline, InlineAlert, PageSection, SectionLabel, Stack, StatStrip,
  ToolCallStrip, Toolbar, DataTable, PageHeader, Disclosure, type DataTableColumn,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { durationLabel, relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { sendJson, writeJson } from '../../lib/writeJson';
import { usd } from '../../lib/format';
import { QueuePulse } from './QueuePulse';
import {
  BotOrigin, JobStatusPill, PROPOSAL_LABELS, ServesItem, T, money, toToolCallStripItems,
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
  const { data: proposalsData, refresh: refreshProposals } = useFetch<{ proposals: Proposal[] }>('/api/work/proposals?status=pending', 20_000);
  // Slower cadence than the rest of the board — this number moves on the
  // scale of decisions made, not queue churn.
  const { data: rediscovery } = useFetch<RediscoveryStats>('/api/rediscovery/stats', 60_000);

  const pendingConsults = consultData?.consults ?? [];
  const [answeringId, setAnsweringId] = useState<string | null>(null);

  const refreshAll = useCallback(() => {
    refreshSummary(); refreshJobs(); refreshProposals(); refreshConsults();
  }, [refreshSummary, refreshJobs, refreshProposals, refreshConsults]);

  useEffect(() => {
    const es = new EventSource('/api/work/events');
    es.onmessage = () => refreshAll();
    return () => es.close();
  }, [refreshAll]);

  async function answerConsult(id: string, answer: string) {
    setAnsweringId(id);
    try {
      await sendJson(`/api/lab/consults/${id}/answer`, 'POST', { answer });
      toastSuccess(null, 'Answer sent', 'The agent picks it up on its next poll (≤2s).');
      refreshAll();
    } catch (err) {
      toastError(null, 'Could not send the answer', (err as Error).message);
    } finally {
      setAnsweringId(null);
    }
  }

  async function reviewJob(job: Job, decision: 'accept' | 'reject') {
    const tid = toastPending(decision === 'accept' ? 'Accepting work' : 'Rejecting work', job.title);
    try {
      await sendJson(`/api/work/jobs/${job.id}/review`, 'POST', { decision });
      toastSuccess(tid, decision === 'accept' ? 'Accepted' : 'Rejected');
      refreshAll();
    } catch (err) { toastError(tid, 'Review failed', (err as Error).message); }
  }

  async function decideProposal(p: Proposal, decision: 'approve' | 'reject') {
    const tid = toastPending(decision === 'approve' ? 'Applying to the graph' : 'Rejecting proposal', p.kind);
    try {
      const body = await sendJson<Proposal>(`/api/work/proposals/${p.id}/decide`, 'POST', { decision });
      if (body.status === 'failed') toastError(tid, 'Apply failed', body.applyError ?? 'unknown error');
      else toastSuccess(tid, decision === 'approve' ? 'Applied to the graph' : 'Rejected');
      refreshAll();
    } catch (err) { toastError(tid, 'Decision failed', (err as Error).message); }
  }

  async function decideAll(group: Proposal[], decision: 'approve' | 'reject') {
    const tid = toastPending(
      decision === 'approve' ? `Applying ${group.length} changes` : `Rejecting ${group.length} changes`,
      group[0]?.targetId ?? '',
    );
    let applied = 0;
    let failed = 0;
    for (const p of group) {
      const res = await writeJson<Proposal>(`/api/work/proposals/${p.id}/decide`, 'POST', { decision });
      if (!res.ok || res.data?.status === 'failed') failed++; else applied++;
    }
    if (failed > 0) toastError(tid, `${failed} of ${group.length} failed`, `${applied} applied`);
    else toastSuccess(tid, decision === 'approve' ? `${applied} applied to the graph` : `${applied} rejected`);
    refreshAll();
  }

  const s = summary;
  const jobs = jobsData?.jobs ?? [];
  const proposals = proposalsData?.proposals ?? [];

  // One analysed document yields a proposal per link. Grouped by target it is
  // a single judgement about the document, with per-link control underneath.
  const proposalGroups = useMemo<Array<[string, Proposal[]]>>(() => {
    const by = new Map<string, Proposal[]>();
    for (const p of proposals) {
      const list = by.get(p.targetId);
      if (list) list.push(p); else by.set(p.targetId, [p]);
    }
    return [...by.entries()];
  }, [proposals]);

  const active = (s?.jobs['running'] ?? 0) + (s?.jobs['claimed'] ?? 0);
  const needsReview = s?.jobs['awaiting_review'] ?? 0;
  const pendingProposals = s?.proposals['pending'] ?? 0;

  const recent = jobs.filter((job) => job.finishedAt).sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!)).slice(0, 4);
  const recentColumns: DataTableColumn<Job>[] = [
    { key: 'title', header: 'Run', render: (job) => <Link to={`/iq/work/${encodeURIComponent(job.id)}`} className="text-[13px] text-text-primary hover:text-primary hover:underline">{job.title}</Link> },
    { key: 'status', header: 'Result', render: (job) => <JobStatusPill status={job.status} /> },
    { key: 'finishedAt', header: 'Finished', render: (job) => <T className="text-[13px] text-text-secondary">{relativeTime(job.finishedAt!)}</T> },
    { key: 'duration', header: 'Duration', render: (job) => <T className="text-[13px] text-text-secondary">{durationLabel(job.result?.durationMs)}</T> },
    { key: 'open', header: '', render: () => <span aria-hidden>›</span> },
  ];

  return (
    <Stack gap="lg" data-testid="automate-inbox">
      <PageHeader size="lg" title="Inbox" description="Questions and approvals waiting for you."
        actions={canManage ? <Button variant="primary" onClick={() => navigate('/iq/work/queue?compose=1#new-run')}>New run</Button> : undefined} />
      <PageSection size="md" title="Needs your attention">
      {/* A failed load renders as zeros everywhere below — "0 workers, 0 needs
          you" reads exactly like a healthy, idle system. Say so plainly.
          `summaryFailure` (transport error OR the wire's `degraded` marker) —
          checking only `summaryError` left a degraded-but-200 response
          rendering this banner as if the read had succeeded. */}
      {summaryFailure && (
        <Card padding="md" className="mb-4 border-danger/40">
          <Stack gap="xs">
            <T className="text-[13px] font-semibold text-danger">Could not reach the work queue</T>
            <T wrap className="text-[12px] text-text-secondary leading-snug">
              {summaryFailure}. The numbers below are not zero — they are unknown.
            </T>
          </Stack>
        </Card>
      )}

      {/* ── What needs a person comes first: the review lane IS the page.
          The pulse, the four numbers and the bots roster follow — they
          describe the loop; this is the part of it that is waiting on you. ── */}
      {/* ── Agent questions first: a pending consult is a RUNNING computer
          blocked on a person. ── */}
      {pendingConsults.length > 0 && (
        <Stack gap="none" className="mb-5">
          <Stack gap="sm" className="p-3.5">
            {pendingConsults.map((c) => (
              <ConsultCard
                key={c.id}
                question={c.question}
                {...(c.context ? { context: c.context } : {})}
                origin={[c.repo, c.boxId].filter((x): x is string => !!x)}
                askedAt={`asked ${relativeTime(c.createdAt)}`}
                status={c.status}
                busy={answeringId === c.id}
                {...(canManage ? { onAnswer: (answer: string) => void answerConsult(c.id, answer) } : {})}
              />
            ))}
          </Stack>
        </Stack>
      )}

      {/* ── Needs review: the human-in-the-loop lane ── */}
      {(needsReview > 0 || pendingProposals > 0) && (
        <Card padding="none" className="mb-5 overflow-hidden border-warning/40">
          <Toolbar size="sm"><SectionLabel className="text-warning">Needs your review</SectionLabel></Toolbar>
          {jobs.filter((j) => j.status === 'awaiting_review').map((j) => (
            <Inline key={j.id} align="start" gap="md" className="px-3.5 py-3 border-b border-border last:border-b-0 min-w-0">
              <Stack gap="xs" className="flex-1 min-w-0">
                <Inline align="center" gap="sm" className="min-w-0">
                  <Link to={`/iq/work/${j.id}`} className="text-[13px] font-semibold text-text-primary no-underline hover:text-primary truncate">
                    {j.title}
                  </Link>
                  <ServesItem job={j} />
                  <BotOrigin job={j} />
                </Inline>
                <T className="text-[12px] text-text-secondary leading-snug">{j.result?.summary ?? 'No summary reported.'}</T>
                {j.result?.toolCallList && j.result.toolCallList.length > 0 && (
                  <ToolCallStrip toolCalls={toToolCallStripItems(j.result.toolCallList)} />
                )}
                <T className="text-[11px] text-text-tertiary">
                  {money(j.result?.costUsd)}
                  {' · '}
                  <Link to={`/iq/work/${j.id}`} className="text-primary no-underline hover:underline">
                    read what it did →
                  </Link>
                </T>
              </Stack>
              {canManage && (
                <Inline gap="sm" className="shrink-0">
                  <Button variant="primary" size="sm" onClick={() => void reviewJob(j, 'accept')}>Accept</Button>
                  <Button variant="secondary" size="sm" onClick={() => void reviewJob(j, 'reject')}>Reject</Button>
                </Inline>
              )}
            </Inline>
          ))}
          {proposalGroups.map(([targetId, group]) => (
            <Stack key={targetId} gap="none" className="border-b border-border last:border-b-0 bg-warning-bg/20">
              <Inline align="center" justify="between" gap="sm" wrap className="px-3.5 py-2.5">
                <Inline align="center" gap="sm" wrap>
                  <Chip tone="warning" size="xs">graph change{group.length === 1 ? '' : 's'}</Chip>
                  <T className="text-[12.5px] font-semibold text-text-primary">
                    {group.length} proposed for {targetId}
                  </T>
                </Inline>
                {canManage && (
                  <Inline gap="sm">
                    <Button variant="primary" size="sm" onClick={() => void decideAll(group, 'approve')}>
                      Approve all {group.length}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void decideAll(group, 'reject')}>
                      Reject all
                    </Button>
                  </Inline>
                )}
              </Inline>

              {group.map((p) => (
                <Inline key={p.id} align="start" gap="md" className="px-3.5 py-2.5 pl-8 border-t border-border min-w-0">
                  <Stack gap="xs" className="flex-1 min-w-0">
                    <Inline align="center" gap="sm" wrap>
                      <T className="text-[12.5px] font-semibold text-text-primary">
                        {PROPOSAL_LABELS[p.kind] ?? p.kind}
                      </T>
                      {p.confidence != null && (
                        <T className="text-[11px] text-text-tertiary">confidence {(p.confidence * 100).toFixed(0)}%</T>
                      )}
                    </Inline>
                    <T className="text-[12px] text-text-secondary leading-snug">{p.rationale ?? '—'}</T>
                    {/* The quote is the reviewable part: it is verified to
                        appear verbatim in the source document. */}
                    {typeof p.evidence?.['quote'] === 'string' && (
                      <T wrap className="text-[12px] text-text-primary pl-2.5 border-l-2 border-primary/40 italic">
                        “{String(p.evidence['quote'])}”
                      </T>
                    )}
                    <T className="text-[11px] text-text-tertiary">{p.source}</T>
                  </Stack>
                  {canManage && (
                    <Inline gap="sm" className="shrink-0">
                      <Button variant="secondary" size="sm" onClick={() => void decideProposal(p, 'approve')}>Approve</Button>
                      <Button variant="danger" size="sm" onClick={() => void decideProposal(p, 'reject')}>Reject</Button>
                    </Inline>
                  )}
                </Inline>
              ))}
            </Stack>
          ))}
        </Card>
      )}

      {/* The loop sentence below promises "anything ... waits ... for a person" —
          when the queue genuinely has nothing for a human, say so explicitly
          instead of leaving blank space that reads as a page that failed to
          render, not a page reporting zero. */}
      {!summaryFailure && pendingConsults.length === 0 && needsReview === 0 && pendingProposals === 0 && (
        <InlineAlert tone="info" className="mb-5">
          Nothing needs your attention right now — agent questions and finished work awaiting review will show up here.
        </InlineAlert>
      )}

      {!summaryFailure && (needsReview === 0 && pendingProposals === 0) && pendingConsults.length > 0 && <T className="text-[13px] text-text-tertiary">✓ No pending approvals or proposed changes.</T>}
      </PageSection>
      <PageSection size="md" title="Current queue" className="border-t border-b border-border py-5"
        actions={<Link to="/iq/work/queue" className="text-[13px] text-primary hover:underline">View runs →</Link>}>
        <StatStrip frameless aria-label="Current queue" items={[
          { label: 'Queued', value: summaryFailure || !s ? '—' : s.jobs.queued ?? 0 },
          { label: 'Running', value: summaryFailure || !s ? '—' : active },
          { label: 'Waiting for review', value: summaryFailure || !s ? '—' : needsReview },
          { label: 'Failed', value: summaryFailure || !s ? '—' : s.jobs.failed ?? 0 },
        ]} />
      </PageSection>
      <PageSection size="md" title="Recent runs" actions={<Link to="/iq/work/queue" className="text-[13px] text-primary hover:underline">All runs →</Link>}>
        {jobsError ? <InlineAlert tone="error">{jobsError}</InlineAlert> : <DataTable data={recent} columns={recentColumns} keyField={(job) => job.id} onRowClick={(job) => navigate(`/iq/work/${encodeURIComponent(job.id)}`)} frameless loading={jobsLoading && !jobsData} emptyMessage="No completed runs yet" />}
      </PageSection>
      <Link to="/iq/work/findings" className="text-[13px] text-primary hover:underline">{s && !summaryFailure ? `${s.findings.open} open findings` : 'View findings'} →</Link>
      <Disclosure summary="Queue operations" variant="plain" density="compact">
        <QueuePulse summary={s ? { jobs: s.jobs, busyBoxes: s.busyBoxes } : null} jobs={jobs} degraded={!!summaryFailure} />
        {rediscovery && <T className="mt-3 text-[12px] text-text-tertiary">Rediscovery avoided {usd(rediscovery.usdAvoided)} · {rediscovery.shortCircuits} short-circuits · {rediscovery.windowDays}d</T>}
      </Disclosure>
    </Stack>
  );
}
