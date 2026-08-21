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
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';

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
}

const STATUS_TONE: Record<string, string> = {
  running: 'bg-primary text-white',
  claimed: 'bg-primary/15 text-primary',
  queued: 'bg-surface-hover text-text-secondary',
  awaiting_review: 'bg-warning-bg text-warning',
  done: 'bg-success-bg text-success',
  failed: 'bg-danger-bg text-danger',
  cancelled: 'bg-surface-hover text-text-tertiary',
};

const LIVE_STATUSES = new Set(['claimed', 'running']);

function money(n: number | undefined): string {
  return typeof n === 'number' ? `$${n.toFixed(4)}` : '—';
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
    return [{ t: 'error', detail: String(ev['error'] ?? 'devbox error'), ts }];
  }
  return [];
}

export default function JobDetailPage() {
  const { jobId = '' } = useParams();
  const navigate = useNavigate();

  // Poll fast while the job is live so status transitions land quickly; the
  // SSE tail carries the activity, this carries the state machine.
  const { data: job, refresh } = useFetch<Job>(jobId ? `/api/work/jobs/${jobId}` : null, 5_000);

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
    const es = new EventSource(`/api/devbox/boxes/${job.boxId}/tail`);
    let inOurJob = false;
    setTailState('open');

    es.onmessage = (msg) => {
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

    return () => { es.close(); setTailState('idle'); };
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
    return (
      <PageSection title="Job">
        <div className="text-[13px] text-text-tertiary">Loading job {jobId}…</div>
      </PageSection>
    );
  }

  const prompt = String(job.payload['prompt'] ?? '');

  return (
    <PageSection title={job.title}>
      <div className="flex items-center gap-3 mb-5 flex-wrap">
        <button
          onClick={() => navigate('/iq/work')}
          className="text-[12px] text-text-secondary bg-transparent border-none cursor-pointer hover:text-primary p-0"
        >
          ← Work
        </button>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${STATUS_TONE[job.status] ?? 'bg-surface-hover text-text-secondary'}`}>
          {job.status.replace('_', ' ')}
        </span>
        {job.boxId && (
          <Link
            to={`/admin/devbox?box=${encodeURIComponent(job.boxId)}`}
            className="text-[12px] text-primary no-underline hover:underline"
          >
            worker {job.boxId} →
          </Link>
        )}
        <span className="text-[11px] text-text-tertiary">
          attempt {job.attempts} of {job.maxAttempts} · queued by {job.createdBy ?? 'unknown'}
        </span>
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
        <div className="flex-1" />
        {(job.status === 'queued' || job.status === 'claimed') && (
          <button
            onClick={() => void cancel()}
            className="px-3 py-1 rounded-md border border-border bg-surface text-text-secondary text-[12px] font-semibold cursor-pointer hover:text-danger"
          >
            Cancel
          </button>
        )}
        {job.status === 'awaiting_review' && (
          <div className="flex gap-2">
            <button onClick={() => void review('accept')}
              className="px-3 py-1 rounded-md border-none bg-success text-white text-[12px] font-semibold cursor-pointer">Accept</button>
            <button onClick={() => void review('reject')}
              className="px-3 py-1 rounded-md border border-border bg-surface text-text-secondary text-[12px] font-semibold cursor-pointer hover:text-danger">Reject</button>
          </div>
        )}
      </div>

      {/* ── The ask ── */}
      <Card padding="none" className="mb-5 overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-border text-xs font-semibold text-text-secondary tracking-wide select-none">
          THE ASK
        </div>
        <pre className="px-3.5 py-3 m-0 text-[12.5px] leading-relaxed text-text-secondary whitespace-pre-wrap font-sans">
          {prompt || 'No prompt recorded.'}
        </pre>
      </Card>

      {/* ── Activity ── */}
      <Card padding="none" className="mb-5 overflow-hidden">
        <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">ACTIVITY</span>
          {isLive ? (
            tailState === 'unavailable' ? (
              <span className="text-[11px] text-warning">
                worker log unavailable — this box is no longer registered
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-[11px] text-primary">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                {tailState === 'retrying' ? 'reconnecting…' : 'live'}
              </span>
            )
          ) : (
            <span className="text-[11px] text-text-tertiary">
              {activity.length > 0 ? 'recorded transcript' : 'no activity recorded'}
            </span>
          )}
          <div className="flex-1" />
          {activity.length > 0 && (
            <span className="text-[11px] text-text-tertiary">{activity.length} entries</span>
          )}
        </div>

        <div ref={scrollRef} className="max-h-[420px] overflow-auto">
          {activity.length === 0 ? (
            <div className="px-3.5 py-8 text-center text-[12.5px] text-text-tertiary">
              {job.status === 'queued'
                ? 'Waiting for an idle worker — dispatch runs every ~10s.'
                : isLive && tailState === 'unavailable'
                  ? 'The worker that had this job is gone (usually a middleware restart). It will be requeued and picked up again.'
                  : isLive
                    ? 'Worker has started; first output usually lands within a few seconds.'
                    : 'This run predates activity recording, or its worker log has rolled.'}
            </div>
          ) : activity.map((e, i) => (
            <div key={`${e.ts}-${i}`} className="px-3.5 py-2 border-b border-border last:border-b-0 flex gap-3 min-w-0">
              {e.t === 'tool' ? (
                <>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0 h-fit">
                    {e.name}
                  </span>
                  <code className="text-[11.5px] text-text-secondary font-mono break-all min-w-0 flex-1">
                    {e.detail}
                  </code>
                </>
              ) : e.t === 'error' ? (
                <>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-danger-bg text-danger shrink-0 h-fit">error</span>
                  <span className="text-[12px] text-danger min-w-0 flex-1">{e.detail}</span>
                </>
              ) : (
                <>
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-surface-hover text-text-tertiary shrink-0 h-fit">says</span>
                  <span className="text-[12.5px] text-text-primary leading-relaxed whitespace-pre-wrap min-w-0 flex-1">
                    {e.detail}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* ── Outcome ── */}
      {(job.result || job.error) && (
        <Card padding="none" className="mb-5 overflow-hidden">
          <div className="px-3.5 py-2.5 border-b border-border text-xs font-semibold text-text-secondary tracking-wide select-none">
            OUTCOME
          </div>
          {job.error && (
            <div className="px-3.5 py-3 border-b border-border text-[12.5px] text-danger">{job.error}</div>
          )}
          {job.result?.summary && (
            <div className="px-3.5 py-3 border-b border-border text-[12.5px] text-text-primary leading-relaxed whitespace-pre-wrap">
              {job.result.summary}
            </div>
          )}
          <div className="px-3.5 py-2.5 flex gap-5 flex-wrap text-[11px] text-text-tertiary">
            <span>{job.result?.turns ?? 0} turns</span>
            <span>{job.result?.toolCalls ?? 0} tool calls</span>
            <span>{duration(job.result?.durationMs)}</span>
            <span>{money(job.result?.costUsd)}</span>
          </div>
        </Card>
      )}

      {/* ── Timeline ── */}
      <Card padding="md">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">Timeline</div>
        <div className="grid gap-x-6 gap-y-1 text-[12px] grid-cols-[auto_1fr] max-w-md">
          <span className="text-text-tertiary">Queued</span><span className="text-text-secondary">{clock(job.createdAt)}</span>
          <span className="text-text-tertiary">Claimed</span><span className="text-text-secondary">{clock(job.claimedAt)}</span>
          <span className="text-text-tertiary">Started</span><span className="text-text-secondary">{clock(job.startedAt)}</span>
          <span className="text-text-tertiary">Finished</span><span className="text-text-secondary">{clock(job.finishedAt)}</span>
        </div>
      </Card>
    </PageSection>
  );
}
