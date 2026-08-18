// Work — the agentic loop's home, and the answer to "what are my agents doing
// right now, and what needs me?"
//
// Follows the overview pattern: current state first, the one action that
// matters next, power controls only where they apply. Three sections mirror
// the loop itself — Findings (what was noticed) → Queue (what workers are
// doing) → Proposals (what needs a human before it touches the graph).

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
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

const SEVERITY_TONE: Record<string, string> = {
  critical: 'bg-danger-bg text-danger',
  warning: 'bg-warning-bg text-warning',
  info: 'bg-surface-hover text-text-tertiary',
};

function money(n: number | undefined): string {
  return typeof n === 'number' ? `$${n.toFixed(4)}` : '—';
}

export default function WorkHomePage() {
  const { data: summary, refresh: refreshSummary } = useFetch<Summary>('/api/work/summary', 8_000);
  const { data: jobsData, refresh: refreshJobs } = useFetch<{ jobs: Job[] }>('/api/work/jobs?limit=25', 8_000);
  const { data: findingsData, refresh: refreshFindings } = useFetch<{ findings: Finding[] }>('/api/work/findings?status=open&limit=50', 20_000);
  const { data: proposalsData, refresh: refreshProposals } = useFetch<{ proposals: Proposal[] }>('/api/work/proposals?status=pending', 20_000);

  const [newTitle, setNewTitle] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const jobs = jobsData?.jobs ?? [];
  const findings = findingsData?.findings ?? [];
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
      toastSuccess(tid, 'Job queued', 'an idle box will pick it up within ~10s');
      setNewTitle(''); setNewPrompt('');
      refreshAll();
    } catch (err) {
      toastError(tid, 'Could not queue job', (err as Error).message);
    } finally { setBusy(false); }
  }

  async function promote(f: Finding) {
    const tid = toastPending('Promoting finding', f.title);
    try {
      const res = await post('/api/work/jobs', {
        title: `Mitigate: ${f.title}`,
        findingId: f.id,
        priority: f.severity === 'critical' ? 10 : 50,
        prompt: `Investigate and address this org finding, then commit your work.\n\nFinding: ${f.title}\nDetail: ${f.detail ?? ''}\nEvidence: ${JSON.stringify(f.evidence)}\n\nWrite a short markdown plan file in the workspace and commit it with git.`,
      });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Queued from finding', 'tracked back to this finding');
      refreshAll();
    } catch (err) { toastError(tid, 'Promote failed', (err as Error).message); }
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
      const body = await res.json() as { results?: Array<{ sweep: string; found: number; created: number; resolved: number }> };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const detail = (body.results ?? []).map((r) => `${r.sweep}: ${r.found} found`).join(' · ');
      toastSuccess(tid, 'Sweeps complete', detail);
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
                  <div className="text-[13px] font-semibold text-text-primary">{j.title}</div>
                  <div className="text-[12px] text-text-secondary mt-1 leading-snug">{j.result?.summary ?? 'No summary reported.'}</div>
                  <div className="text-[11px] text-text-tertiary mt-1">
                    {j.result?.turns ?? 0} turns · {j.result?.toolCalls ?? 0} tools · {money(j.result?.costUsd)} · box {j.boxId ?? '—'}
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
          <div key={j.id} className="px-3.5 py-2.5 border-b border-border last:border-b-0 flex items-center gap-3 min-w-0">
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${STATUS_TONE[j.status] ?? 'bg-surface-hover text-text-secondary'}`}>
              {j.status.replace('_', ' ')}
            </span>
            <span className="text-[12.5px] text-text-primary truncate flex-1 min-w-0" title={j.title}>{j.title}</span>
            {j.error && <span className="text-[11px] text-danger truncate max-w-[240px]" title={j.error}>{j.error}</span>}
            <span className="text-[11px] text-text-tertiary shrink-0 hidden md:inline">
              {j.boxId ? `box ${j.boxId}` : `priority ${j.priority}`}
            </span>
          </div>
        ))}
      </Card>

      {/* ── Findings ── */}
      <Card padding="none" className="overflow-hidden">
        <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">FINDINGS</span>
          <span className="text-[11px] text-text-tertiary">from scheduled sweeps · promote one to put a worker on it</span>
        </div>
        {findings.length === 0 ? (
          <div className="px-3.5 py-8 text-center text-[12.5px] text-text-tertiary">
            Nothing open. Sweeps run every 6 hours — or run them now above.
          </div>
        ) : findings.slice(0, 12).map((f) => (
          <div key={f.id} className="px-3.5 py-2.5 border-b border-border last:border-b-0 flex items-center gap-3 min-w-0">
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${SEVERITY_TONE[f.severity]}`}>{f.severity}</span>
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] text-text-primary truncate" title={f.title}>{f.title}</div>
              {f.detail && <div className="text-[11px] text-text-tertiary truncate" title={f.detail}>{f.detail}</div>}
            </div>
            <span className="text-[10px] text-text-tertiary shrink-0 hidden lg:inline">{f.sweep}</span>
            <button
              onClick={() => void promote(f)}
              className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:text-primary hover:border-primary/50 transition-colors shrink-0"
            >
              Put a worker on it
            </button>
          </div>
        ))}
      </Card>
    </PageSection>
  );
}
