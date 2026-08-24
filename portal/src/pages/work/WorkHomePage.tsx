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
import { useCapabilities } from '../../lib/capabilities';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';

interface Job {
  id: string; kind: string; title: string; status: string; priority: number;
  boxId: string | null; attempts: number; maxAttempts: number;
  result: { summary?: string; turns?: number; costUsd?: number; toolCalls?: number; durationMs?: number } | null;
  error: string | null; createdAt: string; finishedAt: string | null;
  /** The standing mission that enqueued this, when one did. */
  botId: string | null; botName: string | null; botTrigger: string | null;
}

/** Chip naming the bot behind a queued job. Scheduled maintenance and work a
 * person queued this morning read identically without it — and only one of
 * them is a cost of ownership someone already agreed to. */
function BotOrigin({ job }: { job: Job }) {
  if (!job.botName) return null;
  return (
    <span
      className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-secondary shrink-0 whitespace-nowrap"
      title={`Enqueued by the ${job.botName} bot (${job.botTrigger ?? 'manual'} trigger)`}
    >
      {job.botTrigger === 'cron' ? '⏱ ' : '🤖 '}{job.botName}
    </span>
  );
}
interface Finding {
  id: string; sweep: string; severity: 'critical' | 'warning' | 'info';
  title: string; detail: string | null; entityType: string | null; entityId: string | null;
  evidence: Record<string, unknown>; status: string; jobId: string | null; lastSeenAt: string;
}
interface Proposal {
  id: string; source: string; kind: string; targetId: string;
  payload: Record<string, unknown>; rationale: string | null; confidence: number | null;
  evidence: Record<string, unknown> | null;
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

const PROPOSAL_LABELS: Record<string, string> = {
  link_document_mention: 'Link this document to an entity',
  add_person_skill: 'Give a person a skill',
  update_person_title: 'Change a person\u2019s title',
  add_collaboration: 'Record a collaboration',
  add_skill: 'Add a new skill',
};

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
  // Every mutation here rides /api/work/* (ManageDevbox): queueing jobs,
  // sweeps, finding actions, job review, proposal decisions. Reads stay open.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const [findingStatus, setFindingStatus] = useState<'open' | 'promoted' | 'resolved' | 'dismissed'>('open');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const { data: summary, error: summaryError, refresh: refreshSummary } = useFetch<Summary>('/api/work/summary', 8_000);
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

  // One analysed document yields a proposal per link — seven for a news
  // article that names seven projects. Reviewed one at a time that is a
  // clicking exercise; grouped by target it is a single judgement about the
  // document, with per-link control still available underneath.
  const proposalGroups = useMemo<Array<[string, Proposal[]]>>(() => {
    const by = new Map<string, Proposal[]>();
    for (const p of proposals) {
      const list = by.get(p.targetId);
      if (list) list.push(p); else by.set(p.targetId, [p]);
    }
    return [...by.entries()];
  }, [proposals]);
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

  async function analyze(f: Finding) {
    const tid = toastPending('Reading the document', 'extracting the links it should have');
    try {
      const res = await post(`/api/work/findings/${f.id}/analyze`);
      const a = await res.json() as {
        links?: unknown[]; proposals?: unknown[]; problem?: string; candidatesConsidered?: number;
      };
      if (!res.ok) throw new Error(a.problem ?? `HTTP ${res.status}`);
      if (a.problem) { toastError(tid, 'Could not analyse', a.problem); return; }
      const n = a.proposals?.length ?? 0;
      if (n === 0) {
        toastSuccess(tid, 'No links found',
          `Nothing in the graph (${a.candidatesConsidered ?? 0} entities) is genuinely referenced.`);
      } else {
        toastSuccess(tid, `${n} link${n === 1 ? '' : 's'} proposed`, 'review them above before they touch the graph');
      }
      refreshAll();
    } catch (err) { toastError(tid, 'Analysis failed', (err as Error).message); }
  }

  async function analyzeBatch(sweep: string, count: number) {
    const n = Math.min(count, 10);
    const tid = toastPending(`Reading ${n} documents`, 'extracting the links each one should have');
    try {
      const res = await post('/api/work/findings/analyze-batch', { sweep, limit: n });
      const r = await res.json() as {
        analysed: number; proposed: number; alreadyKnown: number;
        noLinks: number; failed: number; remaining: number;
      };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parts = [
        r.proposed > 0 ? `${r.proposed} links proposed` : null,
        r.noLinks > 0 ? `${r.noLinks} had nothing to link` : null,
        r.alreadyKnown > 0 ? `${r.alreadyKnown} already proposed` : null,
        r.failed > 0 ? `${r.failed} failed` : null,
        r.remaining > 0 ? `${r.remaining} still to go` : null,
      ].filter(Boolean);
      toastSuccess(tid, `Analysed ${r.analysed} documents`, parts.join(' · ') || 'nothing to do');
      refreshAll();
    } catch (err) { toastError(tid, 'Batch analysis failed', (err as Error).message); }
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
      {/* A failed load renders as zeros everywhere below — "0 workers, 0 needs
          you, 0 open findings" reads exactly like a healthy, idle system. Say
          so plainly instead of letting every card quietly lie. */}
      {summaryError && (
        <Card padding="md" className="mb-4 border-danger/40">
          <div className="text-[13px] font-semibold text-danger">Could not reach the work queue</div>
          <div className="text-[12px] text-text-secondary mt-1 leading-snug">
            {summaryError}. The numbers below are not zero — they are unknown. Findings,
            jobs and proposals live in Aurora, so this usually means the database is
            unavailable rather than that there is no work.
          </div>
        </Card>
      )}

      <p className="text-[13px] text-text-secondary mt-1 mb-5 max-w-3xl leading-relaxed">
        Scheduled sweeps notice things, computer workers act on them, and anything that would change
        the org graph waits for you. Queue a job and an idle computer picks it up within ~10 seconds —
        watch it work in <Link to="/admin/devbox" className="text-primary no-underline hover:underline">Computers</Link>.
      </p>

      {/* ── What's happening ── */}
      <div className="grid gap-4 mb-5 grid-cols-1 md:grid-cols-3">
        <Card padding="md" className="flex flex-col">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Workers</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-[24px] font-bold text-text-primary leading-none">{summaryError ? '—' : active}</span>
            <span className="text-[12px] text-text-secondary">
              {summaryError ? 'unknown' : `running · ${s?.jobs['queued'] ?? 0} queued`}
            </span>
          </div>
          <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
            {summaryError
              ? 'Cannot tell what the workers are doing.'
              : active > 0
                ? `Boxes busy: ${(s?.busyBoxes ?? []).join(', ') || '—'}`
                : 'All boxes idle — the next queued job dispatches within ~10s.'}
          </div>
        </Card>

        <Card padding="md" className="flex flex-col">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Needs you</div>
          <div className="flex items-baseline gap-2 mt-1">
            <span className={`text-[24px] font-bold leading-none ${!summaryError && needsReview + pendingProposals > 0 ? 'text-warning' : 'text-text-primary'}`}>
              {summaryError ? '—' : needsReview + pendingProposals}
            </span>
            <span className="text-[12px] text-text-secondary">
              {summaryError
                ? 'unknown'
                : `${needsReview} artifact${needsReview === 1 ? '' : 's'} · ${pendingProposals} graph change${pendingProposals === 1 ? '' : 's'}`}
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
            <span className="text-[24px] font-bold text-text-primary leading-none">{summaryError ? '—' : s?.findings.open ?? 0}</span>
            <span className="text-[12px] text-text-secondary">
              {summaryError ? 'unknown' : `${s?.findings.critical ?? 0} critical · ${s?.findings.warning ?? 0} warning`}
            </span>
          </div>
          {canManage && (
            <button
              onClick={() => void runSweeps()}
              disabled={!!summaryError}
              title={summaryError ? 'Sweeps read the graph from Aurora, which is unreachable' : undefined}
              className={`mt-auto self-start mt-3 px-3 py-1.5 rounded-md border text-[12px] font-semibold transition-colors ${
                summaryError
                  ? 'border-border bg-surface-hover text-text-tertiary cursor-not-allowed'
                  : 'border-border bg-surface text-text-secondary cursor-pointer hover:text-primary hover:border-primary/50'}`}
            >
              Run sweeps now
            </button>
          )}
        </Card>
      </div>

      {/* ── Queue a job — POST /api/work/jobs (ManageDevbox) ── */}
      {canManage && (
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
            disabled={busy || !!summaryError || !newTitle.trim() || !newPrompt.trim()}
            className={`px-[18px] py-1.5 rounded-md border-none text-[13px] font-semibold transition-colors ${
              busy || summaryError || !newTitle.trim() || !newPrompt.trim()
                ? 'bg-surface-hover text-text-secondary cursor-not-allowed'
                : 'bg-primary text-white cursor-pointer hover:opacity-90'}`}
          >
            Queue job
          </button>
        </div>
      </Card>
      )}

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
                  <div className="flex items-center gap-2 min-w-0">
                    <Link to={`/iq/work/${j.id}`} className="text-[13px] font-semibold text-text-primary no-underline hover:text-primary truncate">
                      {j.title}
                    </Link>
                    <BotOrigin job={j} />
                  </div>
                  <div className="text-[12px] text-text-secondary mt-1 leading-snug">{j.result?.summary ?? 'No summary reported.'}</div>
                  <div className="text-[11px] text-text-tertiary mt-1">
                    {j.result?.turns ?? 0} turns · {j.result?.toolCalls ?? 0} tools · {money(j.result?.costUsd)}
                    {' · '}
                    <Link to={`/iq/work/${j.id}`} className="text-primary no-underline hover:underline">
                      read what it did →
                    </Link>
                  </div>
                </div>
                {canManage && (
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => void reviewJob(j, 'accept')}
                      className="px-3 py-1 rounded-md border-none bg-success text-white text-[12px] font-semibold cursor-pointer">Accept</button>
                    <button onClick={() => void reviewJob(j, 'reject')}
                      className="px-3 py-1 rounded-md border border-border bg-surface text-text-secondary text-[12px] font-semibold cursor-pointer hover:text-danger">Reject</button>
                  </div>
                )}
              </div>
            </div>
          ))}
          {proposalGroups.map(([targetId, group]) => (
            <div key={targetId} className="border-b border-border last:border-b-0 bg-warning-bg/20">
              <div className="px-3.5 py-2.5 flex items-center gap-3 flex-wrap">
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-warning-bg text-warning">
                  graph change{group.length === 1 ? '' : 's'}
                </span>
                <span className="text-[12.5px] font-semibold text-text-primary">
                  {group.length} proposed for {targetId}
                </span>
                <div className="flex-1" />
                {canManage && (
                  <div className="flex gap-2">
                    <button onClick={() => void decideAll(group, 'approve')}
                      className="px-3 py-1 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer">
                      Approve all {group.length}
                    </button>
                    <button onClick={() => void decideAll(group, 'reject')}
                      className="px-3 py-1 rounded-md border border-border bg-surface text-text-secondary text-[12px] font-semibold cursor-pointer hover:text-danger">
                      Reject all
                    </button>
                  </div>
                )}
              </div>

              {group.map((p) => (
                <div key={p.id} className="px-3.5 py-2.5 pl-8 border-t border-border flex items-start gap-3 min-w-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[12.5px] font-semibold text-text-primary">
                        {PROPOSAL_LABELS[p.kind] ?? p.kind}
                      </span>
                      {p.confidence != null && (
                        <span className="text-[11px] text-text-tertiary">confidence {(p.confidence * 100).toFixed(0)}%</span>
                      )}
                    </div>
                    <div className="text-[12px] text-text-secondary mt-1 leading-snug">{p.rationale ?? '\u2014'}</div>
                    {/* The quote is the reviewable part: it is verified to
                        appear verbatim in the source document, so approving is
                        a judgement about relevance, not about whether the
                        extractor invented it. */}
                    {typeof p.evidence?.['quote'] === 'string' && (
                      <div className="text-[12px] text-text-primary mt-1.5 pl-2.5 border-l-2 border-primary/40 italic">
                        “{String(p.evidence['quote'])}”
                      </div>
                    )}
                    <div className="text-[11px] text-text-tertiary mt-1.5">{p.source}</div>
                  </div>
                  {canManage && (
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => void decideProposal(p, 'approve')}
                        className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:text-primary">Approve</button>
                      <button onClick={() => void decideProposal(p, 'reject')}
                        className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] text-text-tertiary cursor-pointer hover:text-danger">Reject</button>
                    </div>
                  )}
                </div>
              ))}
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
            {summaryError
              ? 'Queue unreachable — this list is unknown, not empty.'
              : canManage
                ? 'No jobs yet — queue one above, or promote a finding below.'
                : 'No jobs yet.'}
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
            <BotOrigin job={j} />
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

              {/* Forty-one documents reviewed one click at a time is not a
                  workflow. Bounded to ten per press so the cost of a click
                  stays predictable, and the toast says how many remain. */}
              {canManage && findingStatus === 'open' && items.some((f) => f.entityType === 'document') && (
                <div className="px-3.5 pb-2.5 pl-10 -mt-1">
                  <button
                    onClick={(e) => { e.stopPropagation(); void analyzeBatch(sweep, items.length); }}
                    className="px-2.5 py-1 rounded-md border border-primary/50 bg-surface text-[11px] font-semibold text-primary cursor-pointer hover:bg-primary hover:text-white transition-colors"
                  >
                    Find links in {Math.min(items.length, 10)} of these
                  </button>
                </div>
              )}

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
                  ) : canManage && findingStatus === 'open' ? (
                    <div className="flex gap-1.5 shrink-0">
                      {f.entityType === 'document' && (
                        <button
                          onClick={() => void analyze(f)}
                          className="px-2.5 py-1 rounded-md border border-primary/50 bg-surface text-[11px] font-semibold text-primary cursor-pointer hover:bg-primary hover:text-white transition-colors"
                          title="Read the document and propose the graph links it is missing"
                        >
                          Find the links
                        </button>
                      )}
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
