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
import { Link, useParams, useNavigate, useSearchParams } from 'react-router';
import {
  Button, Chip, ConfirmDialog, EmptyState, ErrorState, Inline, LoadingState, PageSection,
  Stack, PageHeader, StatStrip, Tabs, Disclosure, ChatComposer,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { crumbLabel, useCrumbLabel } from '../../lib/crumbLabels';
import { absoluteTime, durationLabel } from '../../lib/relativeTime';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { JobStatusPill, LIVE_STATUSES, T, type JobToolCall } from './workShared';
import { usd } from '../../lib/format';
import { BOTS_ROLES, DEVBOX_ROLES } from './automateNav';
import { useSession } from '../../lib/auth';
import { KeyValue } from '../../components/KeyValue';
import { isNotFoundFetchError } from './jobFetchStatus';

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

export default function JobDetailPage() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const tab = ['summary', 'activity', 'outputs', 'changes'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'summary';
  const changeTab = (value: string) => { const next = new URLSearchParams(params); next.set('tab', value); setParams(next); };
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
  const [question, setQuestion] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const isLive = !!job && LIVE_STATUSES.has(job.status);
  const stored = job?.result?.transcript ?? [];

  // Live tail of the worker's own event log, scoped to this job. The box log
  // is shared by every run that box has done, so we gate on the job_started /
  // job_finished markers the dispatcher writes with our jobId — otherwise a
  // previous run's output would appear as if it were ours.
  useEffect(() => {
    if (!job?.boxId || !isLive) return;
    let es: EventSource;
    let inOurJob = false;
    let lastSeen = Date.now();
    let disposed = false;

    const open = () => {
      if (disposed) return;
      es = new EventSource(`/api/devbox/boxes/${job.boxId}/tail`);
      inOurJob = false;
      lastSeen = Date.now();
      setTailState('open');

      // The server heartbeats every 25s (middleware lib/sse.ts) so that a quiet
      // stream can be told apart from a dead one. Without this listener the
      // watchdog below would tear down a perfectly healthy idle tail.
      es.addEventListener('heartbeat', () => { lastSeen = Date.now(); setTailState('open'); });

      es.onmessage = (msg) => {
        lastSeen = Date.now();
        let ev: Record<string, unknown>;
        try { ev = JSON.parse(msg.data) as Record<string, unknown>; } catch { return; }

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
      es.onerror = () => {
        setTailState(es.readyState === EventSource.CLOSED ? 'unavailable' : 'retrying');
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
      if (Date.now() - lastSeen > STALL_AFTER_MS) open();
    }, WATCHDOG_EVERY_MS);

    open();
    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      es?.close();
      setTailState('idle');
    };
  }, [job?.boxId, job?.id, isLive, refresh]);

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
        <PageSection title={crumbLabel(jobId) ?? 'Job'}>
          <EmptyState
            title="Job not found"
            description={<>No job with id <code>{jobId}</code> — it may have been pruned.</>}
            actionLabel="← Back to runs"
            onAction={() => navigate('/iq/work/queue')}
          />
        </PageSection>
      );
    }
    if (error) {
      return (
        <PageSection title={crumbLabel(jobId) ?? 'Job'}>
          <ErrorState
            title="Failed to load job"
            body={error}
            actionLabel="Retry"
            onAction={refresh}
          />
        </PageSection>
      );
    }
    return (
      <PageSection title={crumbLabel(jobId) ?? 'Job'}>
        <LoadingState label={`Loading job ${jobId}…`} />
      </PageSection>
    );
  }

  const prompt = String(job.payload['prompt'] ?? '');

  const changes = (proposalsData?.proposals ?? []).filter((proposal) => proposal.jobId === job.id);
  const tools = job.result?.toolCallList ?? [];
  const activityUnavailable = !isLive && activity.length === 0 && job.status !== 'queued';
  const canOpenAutomation = BOTS_ROLES.includes(session?.role ?? '');
  const canOpenWorker = DEVBOX_ROLES.includes(session?.role ?? '');
  const toolResults = tools.length > 0 ? <PageSection size="md" title="Recorded tool results">
    <Stack gap="none" className="border-t border-border">
      {tools.map((tool, i) => <Inline key={`${i}-${tool.name}`} gap="md" className="border-b border-border py-2 text-[13px]">
        <span className={tool.done ? 'text-success' : 'text-text-tertiary'} aria-label={tool.done ? 'Completed' : 'Not completed'}>{tool.done ? '✓' : '○'}</span>
        <code className="text-[12px]">{tool.name}</code>
      </Inline>)}
    </Stack>
  </PageSection> : null;
  const unavailable = activityUnavailable ? <PageSection size="md" title="Activity unavailable">
    <T className="text-[13px] text-text-tertiary">This run predates activity recording, or its worker log has expired.</T>
  </PageSection> : null;

  return (
    <Stack gap="lg" data-testid="run-detail">
      <PageHeader title={job.title} size="lg" badge={<JobStatusPill status={job.status} />}
        back={{ label: '← Back to runs', to: '/iq/work/queue', onClick: (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; e.preventDefault(); navigate('/iq/work/queue'); } }}
        description={`${job.botName ? `${job.botTrigger === 'cron' ? 'Scheduled' : 'Dispatched'} by ${job.botName}` : `Queued by ${job.createdBy ?? 'unknown'}`} · Attempt ${job.attempts} of ${job.maxAttempts}`}
        actions={<Inline gap="sm">
          {job.botId && canOpenAutomation && <Button size="sm" variant="secondary" onClick={() => navigate(`/admin/bots/${encodeURIComponent(job.botId!)}`)}>Open automation ↗</Button>}
          {canManage && (job.status === 'queued' || job.status === 'claimed') && <Button size="sm" variant="secondary" onClick={() => setConfirmCancel(true)}>Cancel</Button>}
          {canManage && job.status === 'awaiting_review' && <>
            <Button size="sm" variant="primary" onClick={() => void review('accept')}>Accept</Button>
            <Button size="sm" variant="secondary" onClick={() => void review('reject')}>Reject</Button>
          </>}
        </Inline>} />
      <StatStrip frameless aria-label="Run metrics" items={[
        { label: 'Duration', value: durationLabel(job.result?.durationMs) },
        { label: 'Cost', value: job.result?.costUsd == null ? '—' : usd(job.result.costUsd, { precision: 2 }) },
        { label: 'Turns', value: job.result?.turns ?? '—' },
        { label: 'Trigger', value: job.botTrigger === 'cron' ? 'Scheduled' : job.botTrigger ?? 'Manual' },
      ]} />
      <Tabs value={tab} onValueChange={changeTab} aria-label="Run details" items={[
        { id: 'summary', label: 'Summary' }, { id: 'activity', label: 'Activity' },
        { id: 'outputs', label: 'Outputs' }, { id: 'changes', label: 'Changes', badge: proposalCount || undefined },
      ]} />
      {tab === 'summary' && <Stack gap="lg">
        <PageSection size="md" title="Outcome">
          <T wrap className={`text-[14px] ${job.error ? 'text-danger' : 'text-text-primary'}`}>
            {job.error ?? job.result?.summary ?? (job.status === 'queued' ? 'Waiting for a worker.' : isLive ? 'This run is in progress.' : 'No outcome recorded.')}
          </T>
          {activityUnavailable && job.result && <T className="mt-1 text-[12px] text-text-tertiary">The recorded result is shown below. Detailed activity is unavailable for this run.</T>}
        </PageSection>
        <PageSection size="md" title="Task"><T wrap className="text-[14px] text-text-secondary whitespace-pre-wrap">{prompt || 'No prompt recorded.'}</T></PageSection>
        {toolResults}
        {unavailable}
        <PageSection size="md" title="Timing">
          <Stack gap="xs" className="max-w-lg">
            {([['Queued', job.createdAt], ['Claimed', job.claimedAt], ['Started', job.startedAt], ['Finished', job.finishedAt]] as const).filter(([, at]) => at).map(([label, at]) => <KeyValue key={label} layout="row" labelWidth="w-28" label={label} value={absoluteTime(at)} />)}
          </Stack>
        </PageSection>
        <Disclosure summary="Technical details" variant="plain" density="compact">
          <Stack gap="sm">
            <KeyValue label="Run ID" value={job.id} /><KeyValue label="Kind" value={job.kind} />
            <KeyValue label="Priority" value={String(job.priority)} />
            <KeyValue label="Session" value={job.sessionId ?? '—'} />
            {job.boxId && (canOpenWorker ? <Link to={`/admin/devbox?box=${encodeURIComponent(job.boxId)}`} className="text-primary text-[13px] hover:underline">Worker {job.boxId} ↗</Link> : <KeyValue label="Worker" value={job.boxId} />)}
            {typeof job.payload.findingId === 'string' && <Link to="/iq/work/findings" className="text-primary text-[13px] hover:underline">Source finding: {job.payload.findingId}</Link>}
          </Stack>
        </Disclosure>
      </Stack>}
      {tab === 'activity' && <Stack gap="sm">
        {isLive && <T className="text-[13px] text-text-secondary">{tailState === 'unavailable' ? 'Worker log unavailable' : tailState === 'retrying' ? 'Reconnecting…' : 'Live activity'}</T>}
        {unavailable}
        <Stack ref={scrollRef} gap="none" className="max-h-[520px] overflow-auto">
          {activity.map((entry, i) => <Inline key={`${entry.ts}-${i}`} align="start" gap="sm" className="border-b border-border py-3">
            <Chip size="xs" tone={entry.t === 'error' ? 'danger' : 'neutral'}>{entry.name ?? entry.t}</Chip>
            <T wrap className="min-w-0 text-[13px] whitespace-pre-wrap break-words">{entry.detail}</T>
          </Inline>)}
          {!activity.length && !activityUnavailable && <T className="text-[13px] text-text-tertiary">{job.status === 'queued' ? 'Waiting for an idle worker.' : 'Waiting for the first output…'}</T>}
        </Stack>
      </Stack>}
      {tab === 'outputs' && <Stack gap="lg">
        {job.result?.summary && <PageSection size="md" title="Recorded result"><T wrap className="text-[14px] whitespace-pre-wrap">{job.result.summary}</T></PageSection>}
        {toolResults}
        {!job.result?.summary && !tools.length && <EmptyState size="sm" title="No outputs recorded" />}
      </Stack>}
      {tab === 'changes' && <Stack gap="sm">
        {proposalsError || proposalsDegraded ? <ErrorState title="Run changes unavailable" body={proposalsError || proposalsDegraded || 'Run changes are unavailable.'} actionLabel="Retry" onAction={refreshProposals} /> : proposalsLoading && !proposalsData ? <LoadingState /> : changes.length ? changes.map((change) => <Link key={change.id} to={`/iq/work/changes?job=${encodeURIComponent(job.id)}`} className="border-b border-border py-3 text-[13px] text-primary hover:underline">{change.kind} · {change.status}{change.rationale ? ` — ${change.rationale}` : ''}</Link>) : <EmptyState size="sm" title="No graph changes recorded" />}
      </Stack>}
      <ChatComposer value={question} onChange={setQuestion} placeholder="Ask about this run…" aria-label="Ask about this run" submitAriaLabel="Ask about this run"
        onSubmit={() => { if (question.trim()) navigate(`/iq/invoke?${new URLSearchParams({ prompt: `${question.trim()}\n\nRun: ${job.title} (${job.id})\nStatus: ${job.status}\nTask: ${prompt}\nRecorded outcome: ${job.result?.summary ?? job.error ?? 'Not recorded'}` })}`); }} />
      <ConfirmDialog open={confirmCancel} tone="destructive" title="Cancel this run?"
        body={`This run is currently ${job.status}. Cancelling stops it and cannot be undone.`}
        confirmLabel={cancelling ? 'Cancelling…' : 'Cancel run'} confirmDisabled={cancelling}
        onConfirm={() => void cancel()} onCancel={() => setConfirmCancel(false)} />
    </Stack>
  );
}
