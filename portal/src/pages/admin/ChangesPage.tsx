// Changes — the review queue for code an agent wrote.
//
// This is the human end of the SDLC governance loop. An agent changes code in
// a codebase; the change is captured, reviewed by an independent model, and run
// through the policy gates. What lands here is what the gates could not clear on
// their own — a change that touched something sensitive, or grew too large, or
// that a reviewer flagged. A person approves it, sends it back, or rejects it,
// and an approved change is delivered as a pull request.
//
// It is deliberately not a general PR viewer. It shows what governance needs a
// human to see — the verdict, why a human is required, and the diff — and
// nothing of the collaboration furniture a human-authored PR carries, because
// there is no team discussing this change, only a decision to make about it.

import { useCallback, useState } from 'react';
import { Link } from 'react-router';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { PolicyEditor } from '../../components/sdlc/PolicyEditor';

type Verdict = 'approve' | 'request_changes' | 'reject';
interface Review {
  id: string; reviewer: string; model: string | null; verdict: Verdict;
  summary: string | null;
  findings: Array<{ severity?: string; file?: string; line?: number; note: string }>;
  createdAt: string;
}
interface Gate { policyName: string; kind: string; outcome: string; detail: string }
interface Change {
  id: string; runId: string | null; projectId: string; repoFullName: string | null;
  orgProjectName: string | null;
  title: string; status: string; diff: string | null; diffTruncated: boolean;
  files: string[]; filesChanged: number; model: string | null;
  branchName: string | null; prUrl: string | null;
  decidedBy: string | null; decisionNote: string | null; error: string | null;
  createdAt: string; reviews: Review[]; gates: Gate[];
}

const STATUS_TONE: Record<string, string> = {
  needs_approval: 'bg-warning-bg text-warning',
  changes_requested: 'bg-warning-bg text-warning',
  in_review: 'bg-surface-hover text-text-tertiary',
  captured: 'bg-surface-hover text-text-tertiary',
  approved: 'bg-success-bg text-success',
  delivering: 'bg-surface-hover text-text-secondary',
  delivered: 'bg-success-bg text-success',
  blocked: 'bg-danger-bg text-danger',
  rejected: 'bg-danger-bg text-danger',
  failed: 'bg-danger-bg text-danger',
};

const STATUS_LABEL: Record<string, string> = {
  needs_approval: 'needs you', changes_requested: 'changes requested',
  in_review: 'reviewing', captured: 'captured', approved: 'approved',
  delivering: 'delivering', delivered: 'delivered', blocked: 'blocked',
  rejected: 'rejected', failed: 'failed',
};

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: 'approved', request_changes: 'requested changes', reject: 'rejected',
};

function when(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

/** Colour a unified diff by line. The diff is real git output, so no parsing
 *  beyond the leading character is needed. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n').slice(0, 600);
  return (
    <pre className="text-[11px] font-mono leading-relaxed overflow-x-auto max-h-[420px] overflow-y-auto bg-[#0d1117] rounded-md p-3">
      {lines.map((l, i) => {
        const c = l[0];
        const tone = l.startsWith('@@') ? 'text-[#a5a5ff]'
          : c === '+' && !l.startsWith('+++') ? 'text-[#7ee787]'
          : c === '-' && !l.startsWith('---') ? 'text-[#f85149]'
          : l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('+++') || l.startsWith('---')
            ? 'text-[#8b949e]' : 'text-[#c9d1d9]';
        return <div key={i} className={tone}>{l || ' '}</div>;
      })}
    </pre>
  );
}

export default function ChangesPage() {
  const [tab, setTab] = useState<'queue' | 'policies'>('queue');
  const { data, refresh } = useFetch<{ changes: Change[] }>('/api/sdlc/changes', 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const act = useCallback(async (
    id: string, path: string, verb: string, body: Record<string, unknown>,
  ) => {
    setBusy(id);
    const tid = toastPending(verb, '');
    try {
      const res = await fetch(`/api/sdlc/changes/${id}/${path}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json() as { error?: string; prUrl?: string; status?: string };
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Done', out.prUrl ? `Pull request opened.` : (out.status ?? 'updated'));
      refresh();
    } catch (err) {
      toastError(tid, `Could not ${verb.toLowerCase()}`, (err as Error).message);
    } finally { setBusy(null); }
  }, [refresh]);

  const changes = data?.changes ?? [];
  const needsYou = changes.filter((c) => c.status === 'needs_approval' || c.status === 'changes_requested');
  const rest = changes.filter((c) => !needsYou.includes(c));

  return (
    <PageSection
      title="Changes"
      description="Code agents wrote, and the decision each one is waiting on. Every agent change is reviewed and gated before it can ship."
    >
      <div className="flex items-center gap-1 mb-4">
        {(['queue', 'policies'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-md text-[12px] font-semibold cursor-pointer border ${
              tab === t ? 'bg-primary text-white border-primary' : 'bg-surface text-text-secondary border-border hover:border-primary/50'}`}
          >
            {t === 'queue' ? `Review queue${needsYou.length ? ` (${needsYou.length})` : ''}` : 'Policies'}
          </button>
        ))}
      </div>

      {tab === 'policies' ? <PolicyEditor /> : (
        <>
          {needsYou.length > 0 && (
            <div className="mb-5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-warning mb-2">Needs you</div>
              <div className="flex flex-col gap-3">
                {needsYou.map((c) => (
                  <ChangeCard key={c.id} change={c} open={openId === c.id}
                    onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                    busy={busy === c.id} act={act} />
                ))}
              </div>
            </div>
          )}

          {rest.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-2">Recent</div>
              <div className="flex flex-col gap-3">
                {rest.map((c) => (
                  <ChangeCard key={c.id} change={c} open={openId === c.id}
                    onToggle={() => setOpenId(openId === c.id ? null : c.id)}
                    busy={busy === c.id} act={act} />
                ))}
              </div>
            </div>
          )}

          {changes.length === 0 && (
            <Card padding="md">
              <div className="text-[13px] font-semibold text-text-primary">No changes yet</div>
              <div className="text-[12px] text-text-secondary mt-1 leading-snug">
                When an agent changes code in a{' '}
                <Link to="/admin/projects" className="text-primary no-underline hover:underline">codebase</Link>,
                the change is captured, reviewed, and gated — and shows up here for whatever decision it needs.
              </div>
            </Card>
          )}
        </>
      )}
    </PageSection>
  );
}

function ChangeCard({ change: c, open, onToggle, busy, act }: {
  change: Change; open: boolean; onToggle: () => void; busy: boolean;
  act: (id: string, path: string, verb: string, body: Record<string, unknown>) => void;
}) {
  const review = c.reviews[0] ?? null;
  const blockingGates = c.gates.filter((g) => g.outcome !== 'pass');

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${STATUS_TONE[c.status] ?? 'bg-surface-hover text-text-tertiary'}`}>
          {STATUS_LABEL[c.status] ?? c.status}
        </span>
        <span className="text-[13px] font-semibold text-text-primary truncate">{c.title}</span>
        <div className="flex-1" />
        {c.repoFullName && <span className="text-[11px] font-mono text-text-tertiary shrink-0">{c.repoFullName}</span>}
      </div>

      <div className="px-3.5 py-2.5">
        <div className="text-[11px] text-text-tertiary">
          {c.filesChanged} {c.filesChanged === 1 ? 'file' : 'files'} · {c.model ?? 'unknown model'} · {when(c.createdAt)}
          {/* The initiative this code serves — the thread from org intent to a
              delivered change, which is the whole reason codebases join the
              org graph. */}
          {c.orgProjectName && <span> · delivering <span className="text-text-secondary">{c.orgProjectName}</span></span>}
        </div>

        {/* Why a human is here — the gates that did not pass. */}
        {blockingGates.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {blockingGates.map((g, i) => (
              <div key={i} className="text-[11px] text-text-secondary leading-snug">
                <span className={g.outcome === 'block' ? 'text-danger' : 'text-warning'}>●</span>{' '}
                {g.detail}
              </div>
            ))}
          </div>
        )}

        {/* What the reviewer said. */}
        {review && (
          <div className="mt-2.5 rounded-md border border-border p-2.5">
            <div className="text-[11px]">
              <span className={`font-semibold ${
                review.verdict === 'approve' ? 'text-success'
                  : review.verdict === 'reject' ? 'text-danger' : 'text-warning'}`}>
                Reviewer {VERDICT_LABEL[review.verdict]}
              </span>
              <span className="text-text-tertiary"> · {review.model ?? 'model'}</span>
            </div>
            {review.summary && <div className="text-[12px] text-text-secondary mt-1 leading-snug">{review.summary}</div>}
            {review.findings.length > 0 && (
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {review.findings.slice(0, 6).map((f, i) => (
                  <li key={i} className="text-[11px] text-text-tertiary leading-snug">
                    <span className={f.severity === 'high' ? 'text-danger' : f.severity === 'low' ? 'text-text-tertiary' : 'text-warning'}>
                      {f.severity ?? 'note'}
                    </span>
                    {f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''} — {f.note}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {c.error && <div className="mt-2 text-[11px] text-danger leading-snug">{c.error}</div>}
        {c.prUrl && (
          <a href={c.prUrl} target="_blank" rel="noreferrer"
            className="inline-block mt-2 text-[12px] text-primary no-underline hover:underline">
            View pull request →
          </a>
        )}

        {/* Actions, by state. */}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {(c.status === 'needs_approval' || c.status === 'changes_requested') && (
            <>
              <button disabled={busy} onClick={() => act(c.id, 'decide', 'Approving', { decision: 'approve' })}
                className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-50">
                {c.status === 'changes_requested' ? 'Approve anyway' : 'Approve'}
              </button>
              <button disabled={busy} onClick={() => act(c.id, 'decide', 'Rejecting', { decision: 'reject' })}
                className="px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-secondary cursor-pointer hover:border-danger hover:text-danger transition-colors disabled:opacity-50">
                Reject
              </button>
            </>
          )}
          {c.status === 'approved' && (
            <button disabled={busy} onClick={() => act(c.id, 'deliver', 'Delivering', {})}
              className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-50">
              {busy ? 'delivering…' : 'Deliver as pull request'}
            </button>
          )}
          {c.status === 'changes_requested' && (
            <button disabled={busy} onClick={() => act(c.id, 'address', 'Dispatching a fix', {})}
              title="Send the reviewer's findings back to an agent to fix"
              className="px-3 py-1.5 rounded-md border border-primary/50 bg-surface text-[12px] font-semibold text-primary cursor-pointer hover:bg-primary hover:text-white transition-colors disabled:opacity-50">
              Address with an agent
            </button>
          )}
          {(c.status === 'changes_requested' || c.status === 'failed') && (
            <button disabled={busy} onClick={() => act(c.id, 'rereview', 'Re-reviewing', {})}
              className="px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors disabled:opacity-50">
              Re-review
            </button>
          )}
          {c.diff && (
            <button onClick={onToggle}
              className="px-2.5 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors">
              {open ? 'Hide diff' : 'View diff'}
            </button>
          )}
        </div>

        {open && c.diff && (
          <div className="mt-3">
            {c.diffTruncated && (
              <div className="text-[11px] text-warning mb-1">Diff truncated for size — the full change is in the branch once delivered.</div>
            )}
            <DiffView diff={c.diff} />
          </div>
        )}
      </div>
    </Card>
  );
}
