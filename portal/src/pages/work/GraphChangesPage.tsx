// Every change an agent proposed to the org graph, and what you decided.
//
// The write-back path's whole premise is that nothing reaches the graph
// without a human approving it. That promise is only checkable if the record
// of what WAS approved is visible — otherwise "nothing gets through without
// you" is an assertion rather than something you can audit. Eight mentions had
// already been written into the graph by approved proposals with no page that
// showed them, and a failed apply sat with its error readable only via the API.
//
// Ordered by decision time, newest first, because the question this answers is
// "what changed recently?" — not "what is pending", which is the Work page's job.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';

interface Proposal {
  id: string;
  source: string;
  jobId: string | null;
  findingId: string | null;
  kind: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
  rationale: string | null;
  evidence: Record<string, unknown> | null;
  confidence: number | null;
  status: string;
  reviewer: string | null;
  reviewNote: string | null;
  applyError: string | null;
  createdAt: string;
  decidedAt: string | null;
  appliedAt: string | null;
}

const KIND_LABELS: Record<string, string> = {
  link_document_mention: 'Linked a document to an entity',
  add_person_skill: 'Gave a person a skill',
  update_person_title: 'Changed a title',
  add_collaboration: 'Recorded a collaboration',
  add_skill: 'Added a skill',
};

const STATUS_TONE: Record<string, string> = {
  applied: 'bg-success-bg text-success',
  pending: 'bg-warning-bg text-warning',
  approved: 'bg-primary/15 text-primary',
  rejected: 'bg-surface-hover text-text-tertiary',
  failed: 'bg-danger-bg text-danger',
};

type Filter = 'all' | 'applied' | 'pending' | 'rejected' | 'failed';

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

/** What actually changed, in the graph's own vocabulary. */
function describe(p: Proposal): string {
  const pl = p.payload;
  switch (p.kind) {
    case 'link_document_mention':
      return `${String(pl['documentId'] ?? p.targetId)} → ${String(pl['entityType'] ?? '?')} ${String(pl['entityId'] ?? '?')}`;
    case 'add_person_skill':
      return `${String(pl['personId'] ?? '?')} → skill ${String(pl['skillId'] ?? '?')}`;
    case 'update_person_title':
      return `${String(pl['personId'] ?? '?')} → "${String(pl['title'] ?? '?')}"`;
    case 'add_collaboration':
      return `${String(pl['personAId'] ?? '?')} ↔ ${String(pl['personBId'] ?? '?')}`;
    case 'add_skill':
      return `${String(pl['skillId'] ?? '?')} (${String(pl['name'] ?? '?')})`;
    default:
      return JSON.stringify(pl);
  }
}

export default function GraphChangesPage() {
  const [filter, setFilter] = useState<Filter>('all');
  // Retry/reject POST /api/work/proposals/:id/decide (ManageDevbox).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  // ?job=<id> narrows the audit log to one job's proposals — the landing view
  // for "what did this worker propose?" links from the job detail page.
  const [searchParams, setSearchParams] = useSearchParams();
  const jobFilter = searchParams.get('job');
  const { data, refresh } = useFetch<{ proposals: Proposal[] }>(
    filter === 'all' ? '/api/work/proposals' : `/api/work/proposals?status=${filter}`,
    15_000,
  );

  // A failed apply is actionable, not just history: retry it once its cause is
  // fixed, or reject it off the board. Without this a single bad row sat here
  // permanently with nothing a reviewer could do about it.
  async function decide(p: Proposal, decision: 'approve' | 'reject') {
    const tid = toastPending(decision === 'approve' ? 'Retrying' : 'Rejecting', p.rationale ?? p.kind);
    try {
      const res = await fetch(`/api/work/proposals/${p.id}/decide`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const body = await res.json() as Proposal;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (body.status === 'failed') toastError(tid, 'Still failing', body.applyError ?? 'unknown error');
      else toastSuccess(tid, body.status === 'applied' ? 'Applied to the graph' : 'Rejected');
      void refresh();
    } catch (err) { toastError(tid, 'Could not decide', (err as Error).message); }
  }

  const proposals = useMemo(() => {
    const list = (data?.proposals ?? []).filter((p) => !jobFilter || p.jobId === jobFilter);
    // Decided work first by recency; anything still undecided sorts by when it
    // was raised, so a pending row never hides below month-old history.
    return list.sort((a, b) =>
      (b.decidedAt ?? b.createdAt).localeCompare(a.decidedAt ?? a.createdAt));
  }, [data, jobFilter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of data?.proposals ?? []) c[p.status] = (c[p.status] ?? 0) + 1;
    return c;
  }, [data]);

  // "Graph updates", not "Graph changes" — /admin/changes is the CODE review
  // queue, and two queues one word apart kept getting confused.
  return (
    <PageSection title="Graph updates">
      <p className="text-[13px] text-text-secondary mt-1 mb-5 max-w-3xl leading-relaxed">
        Every change an agent proposed to the org graph and what you decided about it.
        Nothing here was written without an approval — this is the record that makes
        that checkable. Raise new ones from <Link to="/iq/work" className="text-primary no-underline hover:underline">Work</Link>.
      </p>

      {jobFilter && (
        <div className="flex items-center gap-2 mb-3 text-[12px] text-text-secondary">
          <span>
            Showing proposals from job{' '}
            <Link to={`/iq/work/${jobFilter}`} className="text-primary no-underline hover:underline font-mono">
              {jobFilter.slice(0, 8)}
            </Link>
          </span>
          <button
            onClick={() => setSearchParams({}, { replace: true })}
            className="text-[11px] text-text-tertiary bg-transparent border border-border rounded px-1.5 py-0.5 cursor-pointer hover:text-primary"
          >
            clear
          </button>
        </div>
      )}

      <div className="flex gap-1.5 mb-4 flex-wrap">
        {(['all', 'applied', 'pending', 'rejected', 'failed'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2.5 py-1 rounded text-[12px] font-semibold cursor-pointer border transition-colors ${
              filter === f
                ? 'bg-primary text-white border-primary'
                : 'bg-surface text-text-secondary border-border hover:text-primary'}`}
          >
            {f}
            {filter === 'all' && f !== 'all' && counts[f] ? ` (${counts[f]})` : ''}
          </button>
        ))}
      </div>

      <Card padding="none" className="overflow-hidden">
        {proposals.length === 0 ? (
          <div className="px-3.5 py-10 text-center text-[12.5px] text-text-tertiary">
            {filter === 'all'
              ? 'No agent has proposed a graph change yet. Analyse a document finding in Work to produce some.'
              : `No ${filter} changes.`}
          </div>
        ) : proposals.map((p) => (
          <div key={p.id} className="px-3.5 py-3 border-b border-border last:border-b-0">
            <div className="flex items-start gap-3 min-w-0">
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${STATUS_TONE[p.status] ?? 'bg-surface-hover text-text-secondary'}`}>
                {p.status}
              </span>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] font-semibold text-text-primary">
                    {KIND_LABELS[p.kind] ?? p.kind}
                  </span>
                  <code className="text-[11.5px] text-text-secondary font-mono">{describe(p)}</code>
                </div>

                {p.rationale && (
                  <div className="text-[12px] text-text-secondary mt-1 leading-snug">{p.rationale}</div>
                )}

                {typeof p.evidence?.['quote'] === 'string' && (
                  <div className="text-[12px] text-text-primary mt-1.5 pl-2.5 border-l-2 border-primary/40 italic">
                    “{String(p.evidence['quote'])}”
                  </div>
                )}

                {/* A failed apply is the most useful row on this page: it says
                    the graph did NOT change and exactly why. */}
                {p.applyError && (
                  <div className="text-[12px] text-danger mt-1.5">
                    Did not apply — {p.applyError}
                  </div>
                )}

                {canManage && p.status === 'failed' && (
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => void decide(p, 'approve')}
                      className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:text-primary hover:border-primary/50">
                      Retry
                    </button>
                    <button onClick={() => void decide(p, 'reject')}
                      className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] text-text-tertiary cursor-pointer hover:text-danger">
                      Reject it out
                    </button>
                  </div>
                )}

                <div className="text-[11px] text-text-tertiary mt-1.5 flex gap-3 flex-wrap">
                  <span>{p.source}</span>
                  {p.confidence != null && <span>confidence {(p.confidence * 100).toFixed(0)}%</span>}
                  <span>{p.reviewer ? `decided by ${p.reviewer}` : 'undecided'}</span>
                  <span>{when(p.decidedAt ?? p.createdAt)}</span>
                  {p.jobId && (
                    <Link to={`/iq/work/${p.jobId}`} className="text-primary no-underline hover:underline">
                      from a job →
                    </Link>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}
      </Card>
    </PageSection>
  );
}
