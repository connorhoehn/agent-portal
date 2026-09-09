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
import { Link, useParams, useNavigate } from 'react-router';
import {
  Button, Card, Chip, EmptyState, ErrorState, Inline, PageSection, SectionLabel, Stack, Toolbar,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { JobStatusPill, LIVE_STATUSES, T, money } from './workShared';
import { ActivityScroll } from './ActivityFrame';
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

function duration(ms: number | undefined): string {
  if (typeof ms !== 'number' || ms <= 0) return '—';
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s`
    : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}
function clock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
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
  // Cancel/review ride /api/work (ManageDevbox).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');

  // Poll fast while the job is live so status transitions land quickly; the
  // SSE tail carries the activity, this carries the state machine.
  const { data: job, error, refresh } = useFetch<Job>(jobId ? `/api/work/jobs/${jobId}` : null, 5_000);

  // What this job produced downstream: graph proposals carry the jobId that
  // raised them, so the job page can point at its own output instead of
  // ending at a transcript.
  const { data: proposalsData } = useFetch<{ proposals: Array<{ id: string; jobId: string | null }> }>(
    jobId ? '/api/work/proposals' : null, 30_000);
  const proposalCount = (proposalsData?.proposals ?? []).filter((p) => p.jobId === jobId).length;

  const [live, setLive] = useState<ActivityEntry[]>([]);
  const [tailState, setTailState] = useState<'idle' | 'open' | 'retrying' | 'unavailable'>('idle');
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
    const tid = toastPending('Cancelling job', job.title);
    try {
      const res = await fetch(`/api/work/jobs/${job.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Cancelled');
      void refresh();
    } catch (err) { toastError(tid, 'Cancel failed', (err as Error).message); }
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
        <PageSection title="Job">
          <EmptyState
            title="Job not found"
            description={<>No job with id <code>{jobId}</code> — it may have been pruned.</>}
            actionLabel="← Back to queue"
            onAction={() => navigate('/iq/work')}
          />
        </PageSection>
      );
    }
    if (error) {
      return (
        <PageSection title="Job">
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
      <PageSection title="Job">
        <T className="text-[13px] text-text-tertiary">Loading job {jobId}…</T>
      </PageSection>
    );
  }

  const prompt = String(job.payload['prompt'] ?? '');

  return (
    <PageSection title={job.title}>
      <Inline align="center" justify="between" wrap gap="sm" className="mb-5">
        <Inline align="center" wrap gap="sm">
          <Button variant="ghost" size="sm" onClick={() => navigate('/iq/work')}>← Work</Button>
          <JobStatusPill status={job.status} />
          {job.boxId && (
            <Link
              to={`/admin/devbox?box=${encodeURIComponent(job.boxId)}`}
              className="text-[12px] text-primary no-underline hover:underline"
            >
              worker {job.boxId} →
            </Link>
          )}
          <T className="text-[11px] text-text-tertiary">
            attempt {job.attempts} of {job.maxAttempts} · queued by {job.createdBy ?? 'unknown'}
          </T>
          {/* Provenance: a standing mission put this here, not a person. */}
          {job.botId && job.botName && (
            <Link
              to={`/admin/bots/${job.botId}`}
              className="text-[12px] text-primary no-underline hover:underline"
              title={`${job.botTrigger ?? 'manual'} trigger`}
            >
              {job.botTrigger === 'cron' ? 'scheduled by' : 'dispatched by'} {job.botName} →
            </Link>
          )}
          {/* Provenance: this job exists because a sweep found something. */}
          {typeof job.payload['findingId'] === 'string' && (
            <Link
              to="/iq/work"
              title="This job was promoted from a sweep finding"
              className="text-[11px] text-text-tertiary no-underline hover:text-primary hover:underline"
            >
              from a finding
            </Link>
          )}
          {proposalCount > 0 && (
            <Link
              to={`/iq/work/changes?job=${job.id}`}
              className="text-[12px] text-primary no-underline hover:underline"
            >
              {proposalCount} graph proposal{proposalCount === 1 ? '' : 's'} →
            </Link>
          )}
        </Inline>
        <Inline gap="sm">
          {canManage && (job.status === 'queued' || job.status === 'claimed') && (
            <Button variant="secondary" size="sm" onClick={() => void cancel()}>Cancel</Button>
          )}
          {canManage && job.status === 'awaiting_review' && (
            <>
              <Button variant="primary" size="sm" onClick={() => void review('accept')}>Accept</Button>
              <Button variant="secondary" size="sm" onClick={() => void review('reject')}>Reject</Button>
            </>
          )}
        </Inline>
      </Inline>

      {/* ── The ask ── */}
      <Card padding="none" className="mb-5 overflow-hidden">
        <Toolbar size="sm"><SectionLabel>The ask</SectionLabel></Toolbar>
        <T as="div" wrap className="px-3.5 py-3 text-[12.5px] leading-relaxed text-text-secondary whitespace-pre-wrap">
          {prompt || 'No prompt recorded.'}
        </T>
      </Card>

      {/* ── Activity ── */}
      <Card padding="none" className="mb-5 overflow-hidden">
        <Toolbar
          size="sm"
          end={activity.length > 0 ? <T className="text-[11px] text-text-tertiary">{activity.length} entries</T> : undefined}
        >
          <SectionLabel>Activity</SectionLabel>
          {isLive ? (
            tailState === 'unavailable' ? (
              <T className="text-[11px] text-warning">
                worker log unavailable — this box is no longer registered
              </T>
            ) : (
              <Inline gap="xs" align="center" className="text-[11px] text-primary">
                <T className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                {tailState === 'retrying' ? 'reconnecting…' : 'live'}
              </Inline>
            )
          ) : (
            <T className="text-[11px] text-text-tertiary">
              {activity.length > 0 ? 'recorded transcript' : 'no activity recorded'}
            </T>
          )}
        </Toolbar>

        <ActivityScroll ref={scrollRef} className="max-h-[420px] overflow-auto">
          {activity.length === 0 ? (
            <T as="div" wrap className="px-3.5 py-8 text-center text-[12.5px] text-text-tertiary">
              {job.status === 'queued'
                ? 'Waiting for an idle worker — dispatch runs every ~10s.'
                : isLive && tailState === 'unavailable'
                  ? 'The worker that had this job is gone (usually a middleware restart). It will be requeued and picked up again.'
                  : isLive
                    ? 'Worker has started; first output usually lands within a few seconds.'
                    : 'This run predates activity recording, or its worker log has rolled.'}
            </T>
          ) : activity.map((e, i) => (
            <Inline key={`${e.ts}-${i}`} gap="sm" className="px-3.5 py-2 border-b border-border last:border-b-0 min-w-0">
              {e.t === 'tool' ? (
                <>
                  <Chip tone="accent" size="xs" className="shrink-0 h-fit">{e.name}</Chip>
                  <T as="div" className="text-[11.5px] text-text-secondary font-mono break-all min-w-0 flex-1">
                    {e.detail}
                  </T>
                </>
              ) : e.t === 'error' ? (
                <>
                  <Chip tone="danger" size="xs" className="shrink-0 h-fit">error</Chip>
                  <T as="div" className="text-[12px] text-danger min-w-0 flex-1">{e.detail}</T>
                </>
              ) : (
                <>
                  <Chip tone="neutral" size="xs" className="shrink-0 h-fit">says</Chip>
                  <T as="div" wrap className="text-[12.5px] text-text-primary leading-relaxed whitespace-pre-wrap min-w-0 flex-1">
                    {e.detail}
                  </T>
                </>
              )}
            </Inline>
          ))}
        </ActivityScroll>
      </Card>

      {/* ── Outcome ── */}
      {(job.result || job.error) && (
        <Card padding="none" className="mb-5 overflow-hidden">
          <Toolbar size="sm"><SectionLabel>Outcome</SectionLabel></Toolbar>
          {job.error && (
            <T as="div" wrap className="px-3.5 py-3 border-b border-border text-[12.5px] text-danger">{job.error}</T>
          )}
          {job.result?.summary && (
            <T as="div" wrap className="px-3.5 py-3 border-b border-border text-[12.5px] text-text-primary leading-relaxed whitespace-pre-wrap">
              {job.result.summary}
            </T>
          )}
          <Inline gap="lg" wrap className="px-3.5 py-2.5 text-[11px] text-text-tertiary">
            <span>{job.result?.turns ?? 0} turns</span>
            <span>{job.result?.toolCalls ?? 0} tool calls</span>
            <span>{duration(job.result?.durationMs)}</span>
            <span>{money(job.result?.costUsd)}</span>
          </Inline>
        </Card>
      )}

      {/* ── Timeline ── */}
      <Card padding="md">
        <SectionLabel as="div" className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">
          Timeline
        </SectionLabel>
        <Stack as="dl" gap="xs" className="grid gap-x-6 gap-y-1 text-[12px] grid-cols-[auto_1fr] max-w-md">
          <T as="div" className="text-text-tertiary">Queued</T><T as="div" className="text-text-secondary">{clock(job.createdAt)}</T>
          <T as="div" className="text-text-tertiary">Claimed</T><T as="div" className="text-text-secondary">{clock(job.claimedAt)}</T>
          <T as="div" className="text-text-tertiary">Started</T><T as="div" className="text-text-secondary">{clock(job.startedAt)}</T>
          <T as="div" className="text-text-tertiary">Finished</T><T as="div" className="text-text-secondary">{clock(job.finishedAt)}</T>
        </Stack>
      </Card>
    </PageSection>
  );
}
