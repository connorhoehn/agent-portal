// Work — the agentic loop's home, and the answer to "what are my agents doing
// right now, and what needs me?"
//
// Follows the overview pattern: current state first, the one action that
// matters next, power controls only where they apply. Three sections mirror
// the loop itself — Findings (what was noticed) → Queue (what workers are
// doing) → Proposals (what needs a human before it touches the graph).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';

interface Job {
  id: string; kind: string; title: string; status: string; priority: number;
  boxId: string | null; attempts: number; maxAttempts: number;
  result: { summary?: string; turns?: number; costUsd?: number; toolCalls?: number; durationMs?: number } | null;
  error: string | null; createdAt: string; finishedAt: string | null;
}
interface Finding {
  id: string; sweep: string; severity: 'critical' | 'warning' | 'info';
  title: string; detail: string | null; entityType: string | null; entityId: string | null;
  evidence: Record<string, unknown>; status: string; jobId: string | null; lastSeenAt: string;
}
interface Proposal {
  id: string; source: string; kind: string; targetId: string;
  payload: Record<string, unknown>; rationale: string | null; confidence: number | null;
  status: string; applyError: string | null; createdAt: string;
}
interface Summary {
  jobs: Record<string, number>;
  proposals: Record<string, number>;
  findings: { open: number; critical: number; warning: number };
  busyBoxes: string[];
  sweeps: string[];
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

/** Statuses whose detail page streams live rather than replaying a transcript. */
const LIVE_STATUSES = new Set(['claimed', 'running']);

/** Sweep ids are snake_case machine names; these are what an operator reads. */
const SWEEP_LABELS: Record<string, string> = {
  bus_factor: 'Skill coverage risk',
  stale_docs: 'Documents nothing references',
  orphan_decisions: 'Decisions with no owner',
};

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-danger-bg text-danger',
  warning: 'bg-warning-bg text-warning',
  info: 'bg-surface-hover text-text-tertiary',
};

function money(n: number | undefined): string {
  return typeof n === 'number' ? `$${n.toFixed(4)}` : '—';
}

export default function WorkHomePage() {
  const navigate = useNavigate();
  const [findingStatus, setFindingStatus] = useState<'open' | 'promoted' | 'resolved' | 'dismissed'>('open');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data: summary, refresh: refreshSummary } = useFetch<Summary>('/api/work/summary', 8_000);
  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: Job[] }>('/api/work/jobs?limit=25', 8_000);
  const { data: findingsData, refresh: refreshFindings } = useFetch<{ findings: Finding[] }>(
    `/api/work/findings?status=${findingStatus}&limit=200`, 20_000);
  const { data: proposalsData, refresh: refreshProposals } = useFetch<{ proposals: Proposal[] }>('/api/work/proposals?status=pending', 20_000);

  const [newTitle, setNewTitle] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const jobs = jobsData?.jobs ?? [];
  const findings = findingsData?.findings ?? [];

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
  const proposals = proposalsData?.proposals ?? [];
  const s = summary;

  const refreshAll = useCallback(() => {
    refreshSummary(); refreshJobs(); refreshFindings(); refreshProposals();
  }, [refreshSummary, refreshJobs, refreshFindings, refreshProposals]);

  // Live queue events — a job changing state should update the board without
  // waiting for the next poll.
  useEffect(() => {
    const es = new EventSource('/api/work/events');
    es.onmessage = () => refreshAll();
    return () => es.close();
  }, [refreshAll]);

  async function post(url: string, body?: unknown): Promise<Response> {
    return fetch(url, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function enqueue() {
    if (!newTitle.trim() || !newPrompt.trim() || busy) return;
    setBusy(true);
    const tid = toastPending('Queueing job', newTitle.trim());
    try {
      const res = await post('/api/work/jobs', { title: newTitle.trim(), prompt: newPrompt.trim() });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      const job = await res.json() as Job;
      toastSuccess(tid, 'Job queued', 'an idle worker picks it up within ~10s');
      setNewTitle(''); setNewPrompt('');
      refreshAll();
      navigate(`/iq/work/${job.id}`);
    } catch (err) {
      toastError(tid, 'Could not queue job', (err as Error).message);
    } finally { setBusy(false); }
  }

  async function promote(f: Finding) {
    const tid = toastPending('Putting a worker on it', f.title);
    try {
      // No prompt here on purpose: the remedy belongs to the sweep that
      // produced the finding, so the server builds it. A stale doc gets an
      // extraction diagnosis; a bus-factor risk gets a cross-training plan.
      const res = await post(`/api/work/findings/${f.id}/promote`);
      const body = await res.json() as Job & { error?: string; jobId?: string };
      if (res.status === 409 && body.jobId) {
        toastError(tid, 'Already has a worker', 'opening the existing job');
        navigate(`/iq/work/${body.jobId}`);
        return;
      }
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Worker queued', 'opening the job so you can watch it run');
      refreshAll();
      navigate(`/iq/work/${body.id}`);
    } catch (err) { toastError(tid, 'Promote failed', (err as Error).message); }
  }

  async function dismiss(f: Finding) {
    const tid = toastPending('Dismissing finding', f.title);
    try {
      const res = await post(`/api/work/findings/${f.id}/dismiss`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, 'Dismissed', 'it will stay quiet unless it changes');
      refreshAll();
    } catch (err) { toastError(tid, 'Dismiss failed', (err as Error).message); }
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

  async function runSweeps() {
    const tid = toastPending('Running org sweeps', 'scanning the graph and knowledge base…');
    try {
      const res = await post('/api/work/sweeps/run', {});
      const body = await res.json() as {
        results?: Array<{ sweep: string; found: number; created: number; resolved: number }>;
        released?: number;
      };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const results = body.results ?? [];
      const created = results.reduce((n, r) => n + r.created, 0);
      const resolved = results.reduce((n, r) => n + r.resolved, 0);
      // Report what changed, not what was looked at — "44 found" reads the
      // same whether or not anything moved.
      const parts = [
        created > 0 ? `${created} new` : null,
        resolved > 0 ? `${resolved} resolved` : null,
        body.released ? `${body.released} put back (worker never delivered)` : null,
      ].filter(Boolean);
      toastSuccess(tid, 'Sweeps complete', parts.length ? parts.join(' · ') : 'nothing changed');
      refreshAll();
    } catch (err) { toastError(tid, 'Sweep failed', (err as Error).message); }
  }

  const active = (s?.jobs['running'] ?? 0) + (s?.jobs['claimed'] ?? 0);
  const needsReview = s?.jobs['awaiting_review'] ?? 0;
  const pendingProposals = s?.proposals['pending'] ?? 0;

  return (
    <PageSection title="Work">
      <p className="text-[13px] text-text-secondary mt-1 mb-5 max-w-3xl leading-relaxed">
        Scheduled sweeps notice things, devbox workers act on them, and anything that would change
        the org graph waits for you. Queue a job and an idle box picks it up within ~10 seconds —
        watch it work in <Link to="/admin/devbox" className="text-primary no-underline hover:underline">Devbox</Link>.
      </p>

      {/* ── What's happening ── */}
      <div className="grid gap-4 mb-5 grid-cols-1 md:grid-cols-3">
        <Card padding="md" className="flex flex-col">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Workers</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold text-text-primary leading-none">{active}</span>
            <span className="text-[12px] text-text-secondary">
              running · {s?.jobs['queued'] ?? 0} queued
            </span>
          </div>
          <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
            {active > 0
              ? `Boxes busy: ${(s?.busyBoxes ?? []).join(', ') || '—'}`
              : 'All boxes idle — the next queued job dispatches within ~10s.'}
          </div>
        </Card>

        <Card padding="md" className="flex flex-col">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Needs you</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className={`text-[24px] font-bold leading-none ${needsReview + pendingProposals > 0 ? 'text-warning' : 'text-text-primary'}`}>
              {needsReview + pendingProposals}
            </span>
            <span className="text-[12px] text-text-secondary">
              {needsReview} artifact{needsReview === 1 ? '' : 's'} · {pendingProposals} graph change{pendingProposals === 1 ? '' : 's'}
            </span>
          </div>
          <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
            Nothing reaches the org graph without your approval.
          </div>
        </Card>

        <Card padding="md" className="flex flex-col">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Open findings</span>
          </div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold text-text-primary leading-none">{s?.findings.open ?? 0}</span>
            <span className="text-[12px] text-text-secondary">
              {s?.findings.critical ?? 0} critical · {s?.findings.warning ?? 0} warning
            </span>
          </div>
          <button
            onClick={() => void runSweeps()}
            className="mt-auto self-start mt-3 px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] font-semibold text-text-secondary cursor-pointer hover:text-primary hover:border-primary/50 transition-colors"
          >
            Run sweeps now
          </button>
        </Card>
      </div>

      {/* ── Queue a job ── */}
      <Card padding="none" className="mb-5 overflow-hidden">
        <div className="px-3.5 pt-3 pb-1 text-xs font-semibold text-text-secondary tracking-wide select-none">
          QUEUE A JOB
        </div>
        <div className="px-3.5 pb-2 flex flex-col gap-2">
          <input
            className="w-full text-[13px] bg-transparent text-text-primary border border-border rounded-md px-3 py-2 outline-none"
            placeholder="Title — e.g. 'Document the Cedar policy migration'"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />
          <textarea
            className="w-full min-h-[70px] text-[13px] leading-relaxed bg-transparent text-text-primary border border-border rounded-md px-3 py-2 resize-y outline-none"
            placeholder="What should the worker do? It runs as Claude Code in a microVM with a persistent workspace and git."
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void enqueue(); }}
          />
        </div>
        <div className="px-3.5 py-2.5 border-t border-border flex items-center gap-3 bg-surface-hover/40">
          <span className="text-[11px] text-text-tertiary select-none">Runs on the first idle box · ⌘⏎</span>
          <div className="flex-1" />
          <button
            onClick={() => void enqueue()}
            disabled={busy || !newTitle.trim() || !newPrompt.trim()}
            className={`px-[18px] py-1.5 rounded-md border-none text-[13px] font-semibold transition-colors ${
              busy || !newTitle.trim() || !newPrompt.trim()
                ? 'bg-surface-hover text-text-secondary cursor-not-allowed'
                : 'bg-primary text-white cursor-pointer hover:opacity-90'}`}
          >
            Queue job
          </button>
        </div>
      </Card>

      {/* ── Needs review first: it is the only thing blocking progress ── */}
      {(needsReview > 0 || pendingProposals > 0) && (
        <Card padding="none" className="mb-5 overflow-hidden border-warning/40">
          <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
            <span className="text-xs font-semibold text-warning tracking-wide select-none">NEEDS YOUR REVIEW</span>
          </div>
          {jobs.filter((j) => j.status === 'awaiting_review').map((j) => (
            <div key={j.id} className="px-3.5 py-3 border-b border-border last:border-b-0">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex-1 min-w-0">
                  <Link to={`/iq/work/${j.id}`} className="text-[13px] font-semibold text-text-primary no-underline hover:text-primary">
                    {j.title}
                  </Link>
                  <div className="text-[12px] text-text-secondary mt-1 leading-snug">{j.result?.summary ?? 'No summary reported.'}</div>
                  <div className="text-[11px] text-text-tertiary mt-1">
                    {j.result?.turns ?? 0} turns · {j.result?.toolCalls ?? 0} tools · {money(j.result?.costUsd)}
                    {' · '}
                    <Link to={`/iq/work/${j.id}`} className="text-primary no-underline hover:underline">
                      read what it did →
                    </Link>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => void reviewJob(j, 'accept')}
                    className="px-3 py-1 rounded-md border-none bg-success text-white text-[12px] font-semibold cursor-pointer">Accept</button>
                  <button onClick={() => void reviewJob(j, 'reject')}
                    className="px-3 py-1 rounded-md border border-border bg-surface text-text-secondary text-[12px] font-semibold cursor-pointer hover:text-danger">Reject</button>
                </div>
              </div>
            </div>
          ))}
          {proposals.map((p) => (
            <div key={p.id} className="px-3.5 py-3 border-b border-border last:border-b-0 bg-warning-bg/20">
              <div className="flex items-start gap-3 min-w-0">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warning-bg text-warning">graph change</span>
                    <span className="text-[13px] font-semibold text-text-primary">{p.kind}</span>
                    {p.confidence != null && (
                      <span className="text-[11px] text-text-tertiary">confidence {(p.confidence * 100).toFixed(0)}%</span>
                    )}
                  </div>
                  <div className="text-[12px] text-text-secondary mt-1 leading-snug">{p.rationale ?? '—'}</div>
                  <div className={`text-[11px] text-text-tertiary mt-1 font-["Fira_Code",monospace]`}>
                    {JSON.stringify(p.payload)}
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => void decideProposal(p, 'approve')}
                    className="px-3 py-1 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer">Approve</button>
                  <button onClick={() => void decideProposal(p, 'reject')}
                    className="px-3 py-1 rounded-md border border-border bg-surface text-text-secondary text-[12px] font-semibold cursor-pointer hover:text-danger">Reject</button>
                </div>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* ── Queue ── */}
      <Card padding="none" className="mb-5 overflow-hidden">
        <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">QUEUE</span>
          <span className="text-[11px] text-text-tertiary">{jobs.length} recent</span>
        </div>
        {jobs.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-[12.5px] text-text-tertiary">
            No jobs yet — queue one above, or promote a finding below.
          </div>
        ) : jobs.map((j) => (
          <Link
            key={j.id}
            to={`/iq/work/${j.id}`}
            className="px-3.5 py-2.5 border-b border-border last:border-b-0 flex items-center gap-3 min-w-0 no-underline hover:bg-surface-hover transition-colors group"
          >
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${STATUS_TONE[j.status] ?? 'bg-surface-hover text-text-secondary'}`}>
              {j.status.replace('_', ' ')}
            </span>
            <span className="text-[12.5px] text-text-primary truncate flex-1 min-w-0" title={j.title}>{j.title}</span>
            {j.error && <span className="text-[11px] text-danger truncate max-w-[240px]" title={j.error}>{j.error}</span>}
            <span className="text-[11px] text-text-tertiary shrink-0 hidden md:inline">
              {j.boxId ? `worker ${j.boxId}` : `priority ${j.priority}`}
            </span>
            <span className="text-[11px] text-text-tertiary shrink-0 group-hover:text-primary">
              {LIVE_STATUSES.has(j.status) ? 'watch →' : 'open →'}
            </span>
          </Link>
        ))}
      </Card>

      {/* ── Findings ──────────────────────────────────────────────────────
          Grouped by sweep. A sweep that flags 44 unlinked documents produces
          44 near-identical rows, and a flat list of those buries the one
          critical bus-factor finding underneath them. The group header is the
          unit of attention; the rows are the drill-in. */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-3.5 py-3 border-b border-border flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">FINDINGS</span>
          <span className="text-[11px] text-text-tertiary">what the scheduled sweeps noticed</span>
          <div className="flex-1" />
          <div className="flex gap-1">
            {(['open', 'promoted', 'resolved', 'dismissed'] as const).map((st) => (
              <button
                key={st}
                onClick={() => setFindingStatus(st)}
                className={`px-2 py-0.5 rounded text-[11px] font-semibold cursor-pointer border transition-colors ${
                  findingStatus === st
                    ? 'bg-primary text-white border-primary'
                    : 'bg-surface text-text-secondary border-border hover:text-primary'}`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        {findings.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-[12.5px] text-text-tertiary">
            {findingStatus === 'open'
              ? 'Nothing open. Sweeps run every 6 hours — or run them now above.'
              : findingStatus === 'resolved'
                ? 'Nothing resolved yet. A finding resolves when a later sweep stops reproducing it.'
                : `No ${findingStatus} findings.`}
          </div>
        ) : grouped.map(([sweep, items]) => {
          const open = expanded.has(sweep);
          const worst = items.some((f) => f.severity === 'critical') ? 'critical'
            : items.some((f) => f.severity === 'warning') ? 'warning' : 'info';
          return (
            <div key={sweep} className="border-b border-border last:border-b-0">
              <button
                onClick={() => setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(sweep)) next.delete(sweep); else next.add(sweep);
                  return next;
                })}
                className="w-full px-3.5 py-2.5 flex items-center gap-3 bg-transparent border-none cursor-pointer text-left hover:bg-surface-hover transition-colors"
              >
                <span className="text-[10px] text-text-tertiary w-3 shrink-0">{open ? '▾' : '▸'}</span>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${SEVERITY_TONE[worst]}`}>{worst}</span>
                <span className="text-[12.5px] font-semibold text-text-primary">{SWEEP_LABELS[sweep] ?? sweep}</span>
                <span className="text-[11px] text-text-tertiary">
                  {items.length} finding{items.length === 1 ? '' : 's'}
                </span>
                <div className="flex-1" />
                <span className="text-[11px] text-text-tertiary">{open ? 'hide' : 'show'}</span>
              </button>

              {open && items.map((f) => (
                <div key={f.id} className="px-3.5 py-2.5 pl-10 border-t border-border flex items-center gap-3 min-w-0 bg-surface-hover/30">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${SEVERITY_TONE[f.severity]}`}>{f.severity}</span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12.5px] text-text-primary truncate" title={f.title}>{f.title}</div>
                    {f.detail && <div className="text-[11px] text-text-tertiary truncate" title={f.detail}>{f.detail}</div>}
                  </div>
                  {f.jobId ? (
                    <Link to={`/iq/work/${f.jobId}`} className="text-[11px] text-primary no-underline hover:underline shrink-0">
                      see the work →
                    </Link>
                  ) : findingStatus === 'open' ? (
                    <div className="flex gap-1.5 shrink-0">
                      <button
                        onClick={() => void promote(f)}
                        className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:text-primary hover:border-primary/50 transition-colors"
                      >
                        Put a worker on it
                      </button>
                      <button
                        onClick={() => void dismiss(f)}
                        className="px-2 py-1 rounded-md border border-border bg-surface text-[11px] text-text-tertiary cursor-pointer hover:text-danger transition-colors"
                        title="Stop reporting this unless it changes"
                      >
                        Dismiss
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          );
        })}
      </Card>

    </PageSection>
  );
}
