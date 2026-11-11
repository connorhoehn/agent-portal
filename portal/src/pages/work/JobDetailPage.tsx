// One job, end to end: what was asked, which worker took it, what it did
// while it ran, and what it produced.
//
// The queue used to be a dead list — a status pill, a title, and a box id you
// could not click. Watching a run meant knowing to open Devbox, knowing which
// box, and getting there before the run ended. This page is the click-through:
// live activity while the job is running, and a durable transcript afterwards.
//
// Two sources, deliberately:
//   running  → SSE tail of the box's fleet log, filtered to this job's segment
//   finished → the transcript persisted on the job by the dispatcher
// The fleet log is an in-memory ring buffer, so it cannot be trusted to still
// hold a run you review an hour later. The transcript can.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams, useNavigate, useSearchParams } from 'react-router';
import { usePublishPageTabs } from '../../lib/voice/pageContext';
import {
  Button, Chip, ConfirmDialog, EmptyState, ErrorState, Inline, LoadingState, PageSection,
  Stack, PageHeader, StatStrip, Tabs, WorkflowStepper,
} from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { crumbLabel, useCrumbLabel } from '../../lib/crumbLabels';
import { durationLabel } from '../../lib/relativeTime';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { JobStatusPill, LIVE_STATUSES, T, type JobToolCall } from './workShared';
import { usd } from '../../lib/format';
import { BOTS_ROLES, DEVBOX_ROLES } from './automateNav';
import { useSession } from '../../lib/auth';
import { KeyValue } from '../../components/KeyValue';
import { RecordNotFound } from '../../components/UnavailableNotice';
import { isNotFoundFetchError } from './jobFetchStatus';
import { JobConversation } from './JobConversation';
import { jobTimingSteps } from './jobTiming';
import { callScopeKey } from '../../components/shell/callShellModel';
import { UNDER_CRUMBS_BAND } from '../../components/shell/headerRhythm';

/** IqLayout leaves a run page unpadded (its composer docks flush), so the
 *  page's own states keep the section's 24px gutter. */
const RUN_GUTTER = `px-[var(--ui-page-gutter,1.5rem)] pb-[var(--ui-page-gutter,1.5rem)] ${UNDER_CRUMBS_BAND}`;

interface ActivityEntry {
  t: 'text' | 'tool' | 'error';
  name?: string;
  detail: string;
  ts: string;
}

interface Job {
  id: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: string;
  priority: number;
  boxId: string | null;
  sessionId: string | null;
  attempts: number;
  maxAttempts: number;
  result: {
    summary?: string; turns?: number; costUsd?: number;
    toolCalls?: number; durationMs?: number; transcript?: ActivityEntry[];
    toolCallList?: JobToolCall[];
  } | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  botId: string | null;
  botName: string | null;
  botTrigger: string | null;
}

/**
 * Turn a raw Claude Code stream event into an activity line.
 * Returns null for frames that carry no reviewer-visible meaning.
 */
function toEntries(ev: Record<string, unknown>): ActivityEntry[] {
  const ts = new Date().toISOString();
  const type = String(ev['type'] ?? '');

  if (type === 'assistant') {
    const content = ((ev['message'] as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
    const out: ActivityEntry[] = [];
    for (const block of content) {
      if (block['type'] === 'tool_use') {
        const input = block['input'] as Record<string, unknown> | undefined;
        const target = input?.['command'] ?? input?.['file_path'] ?? input?.['path']
          ?? input?.['pattern'] ?? input?.['prompt'] ?? input;
        out.push({
          t: 'tool',
          name: String(block['name'] ?? 'tool'),
          detail: typeof target === 'string' ? target : JSON.stringify(target ?? ''),
          ts,
        });
      } else if (block['type'] === 'text') {
        const text = String(block['text'] ?? '').trim();
        if (text) out.push({ t: 'text', detail: text, ts });
      }
    }
    return out;
  }
  if (type === 'devbox_error') {
    return [{ t: 'error', detail: String(ev['error'] ?? 'computer error'), ts }];
  }
  return [];
}

/** No heartbeat for this long means the tail is dead, whatever the socket says. */
const STALL_AFTER_MS = 60_000;
const WATCHDOG_EVERY_MS = 10_000;

/**
 * Why a local worker last turned this queued job away (`payload.claimRefusal`,
 * routes/local-compute.ts): the run controls' own reason, and when it is tried
 * again. Null when nothing refused it.
 */
function claimRefusalLine(payload: Record<string, unknown>): string | null {
  const r = payload['claimRefusal'];
  if (!r || typeof r !== 'object') return null;
  const { reason, until } = r as { reason?: unknown; until?: unknown };
  if (typeof reason !== 'string' || !reason) return null;
  const when = typeof until === 'string' && Number.isFinite(Date.parse(until))
    ? ` Tried again after ${new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
    : '';
  return `Held back: ${reason.replace(/\.?$/, '.')}${when}`;
}

export default function JobDetailPage() {
  const { jobId = '' } = useParams();
  const { session } = useSession();
  // useFetch retains data while a new URL loads. A new actor or route owns a
  // fresh reader and tail, so the previous run cannot appear during that wait.
  return <JobDetailContent key={JSON.stringify([callScopeKey(session), jobId])} />;
}

function JobDetailContent() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = ['summary', 'activity', 'outputs', 'changes'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'summary';
  const changeTab = (value: string) => { const next = new URLSearchParams(params); next.set('tab', value); setParams(next); };
  // G49: the job's tabs for the voice ("open outputs" is this page's tab).
  const { pathname } = useLocation();
  usePublishPageTabs({ path: pathname, tabs: ['summary', 'activity', 'outputs', 'changes'], tab });
  // Cancel/review ride /api/work (ManageDevbox).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  // Poll fast while the job is live so status transitions land quickly; the
  // SSE tail carries the activity, this carries the state machine.
  const { data: job, error, refresh } = useFetch<Job>(jobId ? `/api/work/jobs/${jobId}` : null, 5_000);
  // The trail reads the job's title once it loads, not "Job 3f9a…".
  useCrumbLabel(jobId, job?.title);

  // What this job produced downstream: graph proposals carry the jobId that
  // raised them, so the job page can point at its own output instead of
  // ending at a transcript.
  const { data: proposalsData, error: proposalsError, degraded: proposalsDegraded, isLoading: proposalsLoading, refresh: refreshProposals } = useFetch<{ proposals: Array<{ id: string; jobId: string | null; kind: string; status: string; rationale: string | null }> }>(
    jobId ? '/api/work/proposals' : null, 30_000);
  const proposalCount = (proposalsData?.proposals ?? []).filter((p) => p.jobId === jobId).length;

  const [live, setLive] = useState<ActivityEntry[]>([]);
  const [tailState, setTailState] = useState<'idle' | 'open' | 'retrying' | 'unavailable'>('idle');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isLive = !!job && LIVE_STATUSES.has(job.status);
  const stored = job?.result?.transcript ?? [];
  const tailScope = JSON.stringify([callScopeKey(session), jobId, job?.id ?? null, job?.boxId ?? null, isLive]);
  const latestTailScope = useRef(tailScope); latestTailScope.current = tailScope;

  // Live tail of the worker's own event log, scoped to this job. The box log
  // is shared by every run that box has done, so we gate on the job_started /
  // job_finished markers the dispatcher writes with our jobId — otherwise a
  // previous run's output would appear as if it were ours.
  useEffect(() => {
    setLive([]); setTailState('idle');
    if (!session || !job?.boxId || job.id !== jobId || !isLive) return;
    let es: EventSource | null = null;
    let inOurJob = false;
    let lastSeen = Date.now();
    let disposed = false;
    const current = (stream?: EventSource) => !disposed && latestTailScope.current === tailScope && (!stream || es === stream);
    const close = () => { const previous = es; es = null; previous?.close(); };

    const open = () => {
      if (!current()) return;
      // Retire the old connection before replacing it; late callbacks keep
      // their own stream identity and cannot become the replacement's output.
      close();
      const stream = new EventSource(`/api/devbox/boxes/${encodeURIComponent(job.boxId!)}/tail`);
      es = stream;
      inOurJob = false;
      lastSeen = Date.now();
      setTailState('open');

      // The server heartbeats every 25s (middleware lib/sse.ts) so that a quiet
      // stream can be told apart from a dead one. Without this listener the
      // watchdog below would tear down a perfectly healthy idle tail.
      stream.addEventListener('heartbeat', () => { if (!current(stream)) return; lastSeen = Date.now(); setTailState('open'); });

      stream.onmessage = (msg) => {
        if (!current(stream)) return;
        lastSeen = Date.now();
        let ev: Record<string, unknown>;
        try { const parsed: unknown = JSON.parse(msg.data); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
          ev = parsed as Record<string, unknown>; } catch { return; }

        const type = String(ev['type'] ?? '');
        if (type === 'job_started') {
          inOurJob = ev['jobId'] === job.id;
          if (inOurJob) setLive([]);   // replayed buffer may hold an earlier attempt
          return;
        }
        if (type === 'job_finished') {
          if (ev['jobId'] === job.id) { inOurJob = false; void refresh(); }
          return;
        }
        if (!inOurJob) return;

        const entries = toEntries(ev);
        if (entries.length) setLive((prev) => [...prev, ...entries]);
      };
      // EventSource hides the HTTP status, but not the outcome: the browser
      // gives up and closes on a 404 (the box is no longer registered — its log
      // died with a middleware restart), whereas a transient blip goes back to
      // CONNECTING and retries on its own. Saying "retrying" for a log that is
      // never coming back is the kind of lie that costs someone ten minutes.
      stream.onerror = () => {
        if (!current(stream)) return;
        setTailState(stream.readyState === EventSource.CLOSED ? 'unavailable' : 'retrying');
      };
    };

    // A stream can die without the socket breaking — Vite's dev proxy keeps
    // the browser side open after the upstream goes away, so `onerror` never
    // fires and this page would sit on 'open' forever showing a transcript
    // that stopped growing. Missing heartbeats is the only evidence, so a
    // drought means rebuild. Reconnecting is safe here: the server replays the
    // box's buffer, and `inOurJob` is re-derived from the replayed
    // job_started marker rather than carried across.
    const watchdog = window.setInterval(() => {
      if (current() && Date.now() - lastSeen > STALL_AFTER_MS) open();
    }, WATCHDOG_EVERY_MS);

    open();
    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      close();
      setTailState('idle');
    };
  }, [tailScope, job?.boxId, job?.id, jobId, isLive, refresh]);

  // Follow the tail as it grows, but only while live — nobody wants a stored
  // transcript yanking itself to the bottom on every poll.
  useEffect(() => {
    if (isLive && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [live, isLive]);

  const activity = useMemo<ActivityEntry[]>(
    () => (isLive && live.length ? live : stored),
    [isLive, live, stored],
  );

  async function review(decision: 'accept' | 'reject') {
    if (!job) return;
    const tid = toastPending(decision === 'accept' ? 'Accepting work' : 'Rejecting work', job.title);
    try {
      const res = await fetch(`/api/work/jobs/${job.id}/review`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, decision === 'accept' ? 'Accepted' : 'Rejected');
      void refresh();
    } catch (err) { toastError(tid, 'Review failed', (err as Error).message); }
  }

  async function cancel() {
    if (!job) return;
    setCancelling(true);
    const tid = toastPending('Cancelling job', job.title);
    try {
      const res = await fetch(`/api/work/jobs/${job.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Cancelled');
      void refresh();
    } catch (err) { toastError(tid, 'Cancel failed', (err as Error).message); }
    finally { setCancelling(false); setConfirmCancel(false); }
  }

  if (!job) {
    // useFetch never clears stale data on a poll error, so reaching here with
    // `error` set means the very first fetch for this id failed — not a
    // transient hiccup mid-poll. A 404 gets its own explained state (this is
    // exactly the "job → " link from a bot's run history landing on an id
    // nothing ever minted); anything else is a real fetch failure, not an
    // infinite spinner.
    if (error && isNotFoundFetchError(error)) {
      return (
        <Stack gap="none" className={RUN_GUTTER}>
          <RecordNotFound heading={crumbLabel(jobId) ?? 'Job'} title="Job not found" body={`No job with id ${jobId} — it may have been pruned.`} backLabel="Back to runs" onBack={() => navigate('/iq/work/queue')} />
        </Stack>
      );
    }
    if (error) {
      return (
        <Stack gap="none" className={RUN_GUTTER}><PageSection title={crumbLabel(jobId) ?? 'Job'}>
          <ErrorState
            title="Failed to load job"
            body={/internal server error/i.test(error) ? "The run could not be loaded. Try again." : error}
            actionLabel="Retry"
            onAction={refresh}
          />
        </PageSection></Stack>
      );
    }
    return (
      <Stack gap="none" className={RUN_GUTTER}><PageSection title={crumbLabel(jobId) ?? 'Job'}>
        <LoadingState label={`Loading job ${jobId}…`} />
      </PageSection></Stack>
    );
  }

  const prompt = String(job.payload['prompt'] ?? '');

  const changes = (proposalsData?.proposals ?? []).filter((proposal) => proposal.jobId === job.id);
  const tools = job.result?.toolCallList ?? [];
  const activityUnavailable = !isLive && activity.length === 0 && job.status !== 'queued';
  const canOpenAutomation = BOTS_ROLES.includes(session?.role ?? '');
  const canOpenWorker = DEVBOX_ROLES.includes(session?.role ?? '');
  const toolResults = tools.length > 0 ? <PageSection size="sm" title="Recorded tool results">
    <Stack gap="none" className="border-t border-border">
      {tools.map((tool, i) => <Inline key={`${i}-${tool.name}`} gap="md" className="border-b border-border py-2 text-sm">
        <T className={tool.done ? 'text-success' : 'text-text-tertiary'} aria-label={tool.done ? 'Completed' : 'Not completed'}>{tool.done ? '✓' : '○'}</T>
        <T size="xs" className="font-mono">{tool.name}</T>
      </Inline>)}
    </Stack>
  </PageSection> : null;
  const unavailable = activityUnavailable ? <PageSection size="sm" title="Activity unavailable">
    <T size="sm" className="text-text-tertiary">This run predates activity recording, or its worker log has expired.</T>
  </PageSection> : null;

  return (
    <Stack gap="none" className="h-full min-h-0" data-testid="run-detail">
      {/* IqLayout leaves a run page unpadded so the composer below spans the
          content column flush; the scrolling body keeps the 24px gutter. */}
      <Stack gap="lg" className={`min-h-0 flex-1 overflow-auto px-[var(--ui-page-gutter,1.5rem)] pb-4 ${UNDER_CRUMBS_BAND}`} data-testid="run-detail-scroll">
      {/* The 20px heading every Org page has, 16px under the trail — and no
          back link: the trail's "Runs" crumb already is the way back, and a
          back row above the title pushed it 30px under the trail. */}
      <PageHeader title={job.title} badge={<JobStatusPill status={job.status} />}
        description={`${job.botName ? `${job.botTrigger === 'cron' ? 'Scheduled' : 'Dispatched'} by ${job.botName}` : `Queued by ${job.createdBy ?? 'unknown'}`} · Attempt ${job.attempts} of ${job.maxAttempts}`}
        actions={<Inline gap="sm">
          {job.boxId && canOpenWorker && <Button size="sm" variant="secondary" onClick={() => navigate(`/admin/devbox?box=${encodeURIComponent(job.boxId!)}`)}>Open computer ↗</Button>}
          {typeof job.payload.initiativeId === 'string' && <Button size="sm" variant="secondary" onClick={() => navigate(`/iq/projects/${encodeURIComponent(String(job.payload.initiativeId))}${typeof job.payload.workItemId === 'string' ? `?${new URLSearchParams({ tab: 'work', item: job.payload.workItemId })}` : ''}`)}>{typeof job.payload.workItemId === 'string' ? 'Open work item' : 'Open initiative'} ↗</Button>}
          {job.botId && canOpenAutomation && <Button size="sm" variant="secondary" onClick={() => navigate(`/admin/bots/${encodeURIComponent(job.botId!)}`)}>Open automation ↗</Button>}
          {canManage && (job.status === 'queued' || job.status === 'claimed') && <Button size="sm" variant="secondary" onClick={() => setConfirmCancel(true)}>Cancel</Button>}
          {canManage && job.status === 'awaiting_review' && <>
            <Button size="sm" variant="primary" onClick={() => void review('accept')}>Accept</Button>
            <Button size="sm" variant="secondary" onClick={() => void review('reject')}>Reject</Button>
          </>}
        </Inline>} />
        <PageSection size="sm" title="Timing">
          <WorkflowStepper steps={jobTimingSteps(job)} size="compact" aria-label="Run timing" data-testid="job-timing" />
        </PageSection>
      <StatStrip variant="line" aria-label="Run metrics" items={[
        { label: 'Duration', value: durationLabel(job.result?.durationMs) },
        { label: 'Cost', value: job.result?.costUsd == null ? '—' : usd(job.result.costUsd, { precision: 2 }) },
        { label: 'Turns', value: job.result?.turns ?? '—' },
        { label: 'Trigger', value: job.botTrigger === 'cron' ? 'Scheduled' : job.botTrigger ?? 'Manual' },
      ]} />
      {/* shrink-0: the tab strip clips its own overflow, so in this scrolling column it is the one child
          a long summary squeezes to its 1px border. */}
      <Stack gap="none" className="shrink-0">
        <Tabs badgeStyle="plain" value={tab} onValueChange={changeTab} aria-label="Run details" items={[
          { id: 'summary', label: 'Summary' }, { id: 'activity', label: 'Activity' },
          { id: 'outputs', label: 'Outputs', badge: tools.length || undefined }, { id: 'changes', label: 'Changes', badge: proposalCount || undefined },
        ]} />
      </Stack>
      {tab === 'summary' && <Stack gap="lg" className="max-w-4xl">
        <PageSection size="sm" title="Outcome">
          <T wrap className={`text-sm ${job.error ? 'text-danger' : 'text-text-primary'}`}>
            {job.error ?? job.result?.summary ?? (job.status === 'queued' ? (claimRefusalLine(job.payload) ?? 'Waiting for a worker.') : isLive ? 'This run is in progress.' : 'No outcome recorded.')}
          </T>
        </PageSection>
        <PageSection size="sm" title="Task"><T size="sm" wrap className="text-text-secondary whitespace-pre-wrap">{prompt || 'No prompt recorded.'}</T></PageSection>
        <PageSection size="sm" title="Technical details">
          <Stack gap="sm">
            <KeyValue mono label="Run ID" value={job.id} /><KeyValue mono label="Kind" value={job.kind} />
            <KeyValue label="Priority" value={String(job.priority)} />
            <KeyValue mono label="Session" value={job.sessionId ?? '—'} />
            {job.boxId && (canOpenWorker ? <Link to={`/admin/devbox?box=${encodeURIComponent(job.boxId)}`} className="text-primary text-sm hover:underline">Worker {job.boxId} ↗</Link> : <KeyValue label="Worker" value={job.boxId} />)}
            {typeof job.payload.findingId === 'string' && <Link to="/iq/work/findings" className="text-primary text-sm hover:underline">Source finding: {job.payload.findingId}</Link>}
          </Stack>
        </PageSection>
      </Stack>}
      {tab === 'activity' && <Stack gap="sm">
        {isLive && <T size="sm" className="text-text-secondary">{tailState === 'unavailable' ? 'Worker log unavailable' : tailState === 'retrying' ? 'Reconnecting…' : 'Live activity'}</T>}
        {unavailable}
        <Stack ref={scrollRef} gap="none" className="max-h-[520px] overflow-auto">
          {activity.map((entry, i) => <Inline key={`${entry.ts}-${i}`} align="start" gap="sm" className="border-b border-border py-3">
            <Chip size="xs" tone={entry.t === 'error' ? 'danger' : 'neutral'}>{entry.name ?? entry.t}</Chip>
            <T size="sm" wrap className="min-w-0 whitespace-pre-wrap break-words">{entry.detail}</T>
          </Inline>)}
          {!activity.length && !activityUnavailable && <T size="sm" className="text-text-tertiary">{job.status === 'queued' ? 'Waiting for an idle worker.' : 'Waiting for the first output…'}</T>}
        </Stack>
      </Stack>}
      {tab === 'outputs' && <Stack gap="lg">
        {job.result?.summary && <PageSection size="sm" title="Recorded result"><T size="sm" wrap className="whitespace-pre-wrap">{job.result.summary}</T></PageSection>}
        {toolResults}
        {!job.result?.summary && !tools.length && <EmptyState title="No outputs recorded" />}
      </Stack>}
      {tab === 'changes' && <Stack gap="sm">
        {proposalsError || proposalsDegraded ? <ErrorState title="Run changes unavailable" body={proposalsError || proposalsDegraded || 'Run changes are unavailable.'} actionLabel="Retry" onAction={refreshProposals} /> : proposalsLoading && !proposalsData ? <LoadingState /> : changes.length ? changes.map((change) => <Link key={change.id} to={`/iq/work/changes?job=${encodeURIComponent(job.id)}`} className="border-b border-border py-3 text-sm text-primary hover:underline">{change.kind} · {change.status}{change.rationale ? ` — ${change.rationale}` : ''}</Link>) : <EmptyState title="No graph changes recorded" />}
      </Stack>}
      </Stack>
      <JobConversation key={`${callScopeKey(session)}:${job.id}`} job={job} />
      <ConfirmDialog open={confirmCancel} tone="destructive" title="Cancel this run?"
        body={`This run is currently ${job.status}. Cancelling stops it and cannot be undone.`}
        confirmLabel={cancelling ? 'Cancelling…' : 'Cancel run'} confirmDisabled={cancelling}
        onConfirm={() => void cancel()} onCancel={() => setConfirmCancel(false)} />
    </Stack>
  );
}
