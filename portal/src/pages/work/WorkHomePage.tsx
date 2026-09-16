// Automate → Overview. The card dashboard for the agentic loop: the queue's
// pulse (depth, the bots pulling from it, drain ETA), the three numbers that
// matter, and everything BLOCKED ON A HUMAN — agent questions and finished
// work awaiting review. The queue's row-level detail lives on /iq/work/queue;
// findings and the DLQ on /iq/work/findings — this page is the glance, not
// the archive.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  Button, Card, Chip, ConsultCard, Inline, InlineAlert, PageSection, SectionLabel, Stack, StatStrip, Toolbar,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { DEVBOX_ROLES } from './automateNav';
import { QueuePulse } from './QueuePulse';
import {
  BotOrigin, GraphUpdatesLink, PROPOSAL_LABELS, ServesItem, T, money, post,
  type Job, type LabConsult, type Proposal, type Summary,
} from './workShared';

/** GET /api/rediscovery/stats — the number that justifies the rest of the
 * infrastructure: what the agent didn't have to rediscover. */
interface RediscoveryStats {
  shortCircuits: number; dismissals: number; usdAvoided: number; minutesAvoided: number; windowDays: number;
}

export default function WorkHomePage() {
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const { session } = useSession();
  const canOpenDevbox = !!session && DEVBOX_ROLES.includes(session.role);

  const { data: summary, error: summaryError, refresh: refreshSummary } = useFetch<Summary>('/api/work/summary', 8_000);
  // Pending consults poll on the same cadence as the summary: each one is a
  // RUNNING agent blocked on a human, which outranks everything else here.
  const { data: consultData, refresh: refreshConsults } =
    useFetch<{ consults: LabConsult[] }>('/api/lab/consults?status=pending', 8_000);
  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: Job[] }>('/api/work/jobs?limit=50', 8_000);
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
      const res = await post(`/api/lab/consults/${id}/answer`, { answer });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      const res = await post(`/api/work/jobs/${job.id}/review`, { decision });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, decision === 'accept' ? 'Accepted' : 'Rejected');
      refreshAll();
    } catch (err) { toastError(tid, 'Review failed', (err as Error).message); }
  }

  async function decideProposal(p: Proposal, decision: 'approve' | 'reject') {
    const tid = toastPending(decision === 'approve' ? 'Applying to the graph' : 'Rejecting proposal', p.kind);
    try {
      const res = await post(`/api/work/proposals/${p.id}/decide`, { decision });
      const body = await res.json() as Proposal;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
      try {
        const res = await post(`/api/work/proposals/${p.id}/decide`, { decision });
        const body = await res.json() as Proposal;
        if (!res.ok || body.status === 'failed') failed++; else applied++;
      } catch { failed++; }
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
  const consultCount = pendingConsults.length || (s?.consults?.pending ?? 0);
  const failedCount = jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length;
  const needsYou = needsReview + pendingProposals + consultCount;

  return (
    <PageSection title="Automate" actions={<GraphUpdatesLink />}>
      {/* A failed load renders as zeros everywhere below — "0 workers, 0 needs
          you" reads exactly like a healthy, idle system. Say so plainly. */}
      {summaryError && (
        <Card padding="md" className="mb-4 border-danger/40">
          <Stack gap="xs">
            <T className="text-[13px] font-semibold text-danger">Could not reach the work queue</T>
            <T wrap className="text-[12px] text-text-secondary leading-snug">
              {summaryError}. The numbers below are not zero — they are unknown.
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
        <Card padding="none" className="mb-5 overflow-hidden border-warning/40">
          <Toolbar size="sm"><SectionLabel className="text-warning">Agents waiting on you</SectionLabel></Toolbar>
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
        </Card>
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
                  <ServesItem job={j} onOpenInitiative={(id) => navigate(`/iq/projects/${id}`)} />
                  <BotOrigin job={j} />
                </Inline>
                <T className="text-[12px] text-text-secondary leading-snug">{j.result?.summary ?? 'No summary reported.'}</T>
                <T className="text-[11px] text-text-tertiary">
                  {j.result?.turns ?? 0} turns · {j.result?.toolCalls ?? 0} tools · {money(j.result?.costUsd)}
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
      {!summaryError && pendingConsults.length === 0 && needsReview === 0 && pendingProposals === 0 && (
        <InlineAlert tone="info" className="mb-5">
          Nothing needs your attention right now — agent questions and finished work awaiting review will show up here.
        </InlineAlert>
      )}

      {/* ── The queue's pulse: depth, the bots pulling from it, drain ETA ── */}
      <QueuePulse
        summary={s ? { jobs: s.jobs, busyBoxes: s.busyBoxes } : null}
        jobs={jobs}
        degraded={!!summaryError}
      />

      {/* ── The four numbers, each a door to its lane. A single StatStrip
          row, not a stack of cards — the review lane below is the page. ── */}
      <StatStrip
        aria-label="Automate summary"
        className="mt-3"
        items={[
          {
            label: 'Needs you',
            value: summaryError ? '—' : needsYou,
            tone: !summaryError && needsYou > 0 ? 'danger' : 'default',
            hint: summaryError
              ? 'unknown'
              // Short enough to fit the tile at the shell's narrowest content
              // width — the long form clipped to "0 for review · 0 graph…".
              : `${needsReview} review · ${pendingProposals} graph · ${consultCount} question${consultCount === 1 ? '' : 's'}`,
          },
          {
            label: 'Workers',
            value: summaryError ? '—' : active,
            href: '/iq/work/queue',
            hint: summaryError
              ? 'unknown'
              : active > 0
                ? `busy: ${(s?.busyBoxes ?? []).join(', ') || '—'}`
                : 'all idle · next job within ~10s',
          },
          {
            label: 'Findings + DLQ',
            value: summaryError ? '—' : (s?.findings.open ?? 0) + failedCount,
            tone: !summaryError && ((s?.findings.critical ?? 0) > 0 || failedCount > 0) ? 'danger' : 'default',
            href: '/iq/work/findings',
            hint: summaryError
              ? 'unknown'
              : `${s?.findings.open ?? 0} open finding${(s?.findings.open ?? 0) === 1 ? '' : 's'} · ${failedCount} dead-lettered job${failedCount === 1 ? '' : 's'}`,
          },
          {
            label: 'Rediscovery avoided',
            value: rediscovery ? `$${rediscovery.usdAvoided.toFixed(2)}` : '—',
            hint: rediscovery
              ? `${rediscovery.shortCircuits} short-circuits · ${rediscovery.dismissals} dismissed · ${rediscovery.windowDays}d`
              : 'unknown',
          },
        ]}
      />

      {/* `T`'s wrap mode is built on the flex-row `Inline` primitive, which
          wraps each contiguous run of JSX text in its own anonymous
          block-level flex item (CSS Flexbox §4) — a plain space at the seam
          next to an inline <Link>/<T> then lands as leading/trailing
          whitespace of that block's own line box and paints with zero
          width, so "the" and "queue" visually touch ("thequeue"). A
          non-breaking space at each seam is real, non-collapsible content
          instead of trimmable whitespace, so it always renders. */}
      <T as="div" wrap className="text-[12px] text-text-tertiary mt-3 mb-5 leading-relaxed">
        {'Bots and people put work on the'}{' '}
        <Link to="/iq/work/queue" className="text-primary no-underline hover:underline">queue</Link>
        {', computers in the'}{' '}
        {canOpenDevbox
          ? <Link to="/admin/devbox" className="text-primary no-underline hover:underline">Computer Lab</Link>
          : <T title="Not visible to this role">Computer Lab</T>}
        {' '}
        {'drain it, and anything that would change the org graph or ship code waits at the top of this page for a person.'}
      </T>
    </PageSection>
  );
}
