// ChangeReviewPage — one change, reviewed properly.
//
// The queue (/admin/changes) answers "what is waiting on me"; this page
// answers "should THIS ship". A card-expand with a colour-coded <pre> was
// neither: no per-file navigation, no line numbers, review findings listed
// in a box far from the code they were about. This is the diff-reviewer
// shape instead:
//
//   main    the diff (ui-components DiffViewer) with every reviewer finding
//           pinned to the line it names — the note sits under the code
//   rail    authorship (who/what wrote it: model, run, branch, commit, and
//           who decided), the reviewer verdicts, the policy gates, and the
//           decision actions
//
// "Blame" here is honest to the domain: every line of a captured change was
// written by one agent run, so authorship is per-change, not per-line — the
// rail names the run, the model, and links to what the agent was asked.

import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  PageSection, Card, Chip, DiffViewer, EmptyState, LoadingState,
  type DiffAnnotation,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';

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
  orgProjectId: string | null; orgProjectName: string | null;
  title: string; status: string; diff: string | null; diffTruncated: boolean;
  files: string[]; filesChanged: number; model: string | null;
  commitSha: string | null; branchName: string | null; prUrl: string | null;
  decidedBy: string | null; decidedAt: string | null; decisionNote: string | null;
  error: string | null; createdAt: string; reviews: Review[]; gates: Gate[];
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  needs_approval: 'warning', changes_requested: 'warning', in_review: 'neutral',
  captured: 'neutral', approved: 'success', delivering: 'neutral',
  delivered: 'success', blocked: 'danger', rejected: 'danger', failed: 'danger',
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

/** Reviewer pipelines have said high/medium/low AND critical/warning/info —
 *  normalise both onto the DiffViewer's scale. */
function severityOf(s: string | undefined): 'critical' | 'warning' | 'info' {
  if (s === 'critical' || s === 'high') return 'critical';
  if (s === 'warning' || s === 'medium') return 'warning';
  return 'info';
}

function when(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function RailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0 text-[12px]">
      <span className="text-text-tertiary shrink-0 w-[72px]">{label}</span>
      <span className="text-text-primary min-w-0 truncate">{children}</span>
    </div>
  );
}

export default function ChangeReviewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canDecide = ready && can('ManageDevbox');
  const { data, error, isLoading, refresh } =
    useFetch<{ change: Change }>(id ? `/api/sdlc/changes/${encodeURIComponent(id)}` : null, 15_000);
  const c = data?.change ?? null;
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (path: string, verb: string, body: Record<string, unknown>) => {
    if (!id) return;
    setBusy(true);
    const tid = toastPending(verb, '');
    try {
      const res = await fetch(`/api/sdlc/changes/${id}/${path}`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await res.json() as { error?: string; prUrl?: string; status?: string };
      if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Done', out.prUrl ? 'Pull request opened.' : (out.status ?? 'updated'));
      refresh();
    } catch (err) {
      toastError(tid, `Could not ${verb.toLowerCase()}`, (err as Error).message);
    } finally { setBusy(false); }
  }, [id, refresh]);

  // Every reviewer finding becomes a note pinned in the diff. The author line
  // names which review said it — two reviews disagreeing about one line
  // should read as two voices, not one.
  const annotations = useMemo<DiffAnnotation[]>(() => {
    if (!c) return [];
    return c.reviews.flatMap((r) =>
      r.findings
        .filter((f) => f.file)
        .map((f) => ({
          file: f.file!,
          ...(f.line != null ? { line: f.line } : {}),
          severity: severityOf(f.severity),
          note: f.note,
          author: `reviewer · ${r.model ?? r.reviewer}`,
        })));
  }, [c]);

  if (isLoading && !c) return <LoadingState label="Loading change…" />;
  if (error || !c) {
    return (
      <EmptyState
        title="Could not load this change"
        body={error ?? 'No such change request.'}
        actionLabel="Back to the queue"
        onAction={() => navigate('/admin/changes')}
      />
    );
  }

  const decidable = c.status === 'needs_approval' || c.status === 'changes_requested';

  return (
    <PageSection
      title={c.title}
      description={`${c.repoFullName ?? 'unknown repo'} — every agent change is reviewed and gated before it can ship.`}
      actions={
        <Link to="/admin/changes" className="text-[12px] text-primary no-underline hover:underline whitespace-nowrap">
          ← back to the queue
        </Link>
      }
    >
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Chip tone={STATUS_TONE[c.status] ?? 'neutral'} size="xs" uppercase>{STATUS_LABEL[c.status] ?? c.status}</Chip>
        {c.orgProjectName && c.orgProjectId && (
          <Link to={`/iq/projects/${c.orgProjectId}`} className="text-[11px] text-text-secondary no-underline hover:text-primary hover:underline">
            delivering {c.orgProjectName}
          </Link>
        )}
        {c.prUrl && (
          <a href={c.prUrl} target="_blank" rel="noreferrer" className="text-[11px] text-primary no-underline hover:underline">
            pull request →
          </a>
        )}
      </div>

      <div className="grid gap-4 items-start" style={{ gridTemplateColumns: 'minmax(0, 1fr) 300px' }}>
        {/* ── The diff, findings pinned in place ── */}
        <div className="min-w-0">
          {c.diff ? (
            <DiffViewer
              diff={c.diff}
              annotations={annotations}
              {...(c.diffTruncated ? { truncatedNote: 'Diff truncated for size — the full change is in the branch once delivered.' } : {})}
            />
          ) : (
            <Card padding="md">
              <div className="text-[12px] text-text-tertiary">This change has no stored diff.</div>
            </Card>
          )}
        </div>

        {/* ── The rail: authorship, verdicts, gates, decision ── */}
        <div className="flex flex-col gap-3">
          <Card padding="md" className="flex flex-col gap-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">Authorship</div>
            <RailRow label="Written by">{c.model ?? 'unknown model'}</RailRow>
            {c.runId && (
              <RailRow label="Run">
                <Link
                  to={`/admin/projects?project=${c.projectId}&run=${c.runId}`}
                  title="What the agent was asked, and what it did"
                  className="text-primary no-underline hover:underline font-mono"
                >
                  {c.runId.slice(0, 8)}
                </Link>
              </RailRow>
            )}
            {c.branchName && <RailRow label="Branch"><span className="font-mono">{c.branchName}</span></RailRow>}
            {c.commitSha && <RailRow label="Commit"><span className="font-mono">{c.commitSha.slice(0, 10)}</span></RailRow>}
            <RailRow label="Captured">{when(c.createdAt)}</RailRow>
            {c.decidedBy && (
              <>
                <RailRow label="Decided by">{c.decidedBy}</RailRow>
                {c.decidedAt && <RailRow label="Decided">{when(c.decidedAt)}</RailRow>}
                {c.decisionNote && (
                  <div className="text-[11.5px] text-text-secondary leading-snug border-l-2 border-border pl-2 mt-1">
                    {c.decisionNote}
                  </div>
                )}
              </>
            )}
          </Card>

          {c.reviews.length > 0 && (
            <Card padding="md" className="flex flex-col gap-2.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Reviews</div>
              {c.reviews.map((r) => (
                <div key={r.id} className="flex flex-col gap-0.5">
                  <div className="text-[12px]">
                    <span className={
                      r.verdict === 'approve' ? 'text-success font-semibold'
                        : r.verdict === 'reject' ? 'text-danger font-semibold' : 'text-warning font-semibold'}>
                      {VERDICT_LABEL[r.verdict]}
                    </span>
                    <span className="text-text-tertiary"> · {r.model ?? r.reviewer}</span>
                  </div>
                  {r.summary && <div className="text-[11.5px] text-text-secondary leading-snug">{r.summary}</div>}
                  {r.findings.length > 0 && (
                    <div className="text-[10.5px] text-text-tertiary">
                      {r.findings.length} finding{r.findings.length === 1 ? '' : 's'} — pinned in the diff.
                    </div>
                  )}
                </div>
              ))}
            </Card>
          )}

          {c.gates.length > 0 && (
            <Card padding="md" className="flex flex-col gap-1.5">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Policy gates</div>
              {c.gates.map((g, i) => (
                <div key={i} className="text-[11.5px] leading-snug">
                  <span className={
                    g.outcome === 'pass' ? 'text-success'
                      : g.outcome === 'block' ? 'text-danger' : 'text-warning'}>●</span>{' '}
                  <span className="text-text-primary font-medium">{g.policyName}</span>
                  <span className="text-text-secondary"> — {g.detail}</span>
                </div>
              ))}
            </Card>
          )}

          {c.error && (
            <Card padding="md">
              <div className="text-[11.5px] text-danger leading-snug">{c.error}</div>
            </Card>
          )}

          {canDecide && (decidable || c.status === 'approved' || c.status === 'failed') && (
            <Card padding="md" className="flex flex-col gap-2">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Decision</div>
              <div className="flex items-center gap-2 flex-wrap">
                {decidable && (
                  <>
                    <button disabled={busy} onClick={() => void act('decide', 'Approving', { decision: 'approve' })}
                      className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-50">
                      {c.status === 'changes_requested' ? 'Approve anyway' : 'Approve'}
                    </button>
                    <button disabled={busy} onClick={() => void act('decide', 'Rejecting', { decision: 'reject' })}
                      className="px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-secondary cursor-pointer hover:border-danger hover:text-danger transition-colors disabled:opacity-50">
                      Reject
                    </button>
                  </>
                )}
                {c.status === 'approved' && (
                  <button disabled={busy} onClick={() => void act('deliver', 'Delivering', {})}
                    className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-50">
                    Deliver as pull request
                  </button>
                )}
                {c.status === 'changes_requested' && (
                  <button disabled={busy} onClick={() => void act('address', 'Dispatching a fix', {})}
                    title="Send the reviewer's findings back to an agent to fix"
                    className="px-3 py-1.5 rounded-md border border-primary/50 bg-surface text-[12px] font-semibold text-primary cursor-pointer hover:bg-primary hover:text-white transition-colors disabled:opacity-50">
                    Address with an agent
                  </button>
                )}
                {(c.status === 'changes_requested' || c.status === 'failed') && (
                  <button disabled={busy} onClick={() => void act('rereview', 'Re-reviewing', {})}
                    className="px-3 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors disabled:opacity-50">
                    Re-review
                  </button>
                )}
              </div>
            </Card>
          )}
        </div>
      </div>
    </PageSection>
  );
}
