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
  Button,
  Card,
  Chip,
  DiffViewer,
  EmptyState,
  Inline,
  Link as ExternalLink,
  LoadingState,
  PageSection,
  RailLayout,
  SectionLabel,
  Stack,
  type DiffAnnotation,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { absoluteTime } from '../../lib/relativeTime';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { KeyValue } from '../../components/KeyValue';

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
const VERDICT_TONE: Record<Verdict, 'success' | 'danger' | 'warning'> = {
  approve: 'success', reject: 'danger', request_changes: 'warning',
};
const GATE_TONE: Record<string, 'success' | 'danger' | 'warning'> = {
  pass: 'success', block: 'danger',
};

/** Reviewer pipelines have said high/medium/low AND critical/warning/info —
 *  normalise both onto the DiffViewer's scale. */
function severityOf(s: string | undefined): 'critical' | 'warning' | 'info' {
  if (s === 'critical' || s === 'high') return 'critical';
  if (s === 'warning' || s === 'medium') return 'warning';
  return 'info';
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

  const rail = (
    <Stack gap="sm">
      <Card padding="md">
        <Stack gap="xs">
          <SectionLabel>Authorship</SectionLabel>
          <KeyValue layout="row" labelWidth="w-[72px]" label="Written by" value={c.model ?? 'unknown model'} />
          {c.runId && (
            <KeyValue layout="row" labelWidth="w-[72px]" label="Run">
              <Link
                to={`/admin/projects?project=${c.projectId}&run=${c.runId}`}
                title="What the agent was asked, and what it did"
                className="font-mono text-primary no-underline hover:underline"
              >
                {c.runId.slice(0, 8)}
              </Link>
            </KeyValue>
          )}
          {c.branchName && (
            <KeyValue layout="row" labelWidth="w-[72px]" label="Branch" value={c.branchName} mono />
          )}
          {c.commitSha && (
            <KeyValue layout="row" labelWidth="w-[72px]" label="Commit" value={c.commitSha.slice(0, 10)} mono />
          )}
          <KeyValue layout="row" labelWidth="w-[72px]" label="Captured" value={absoluteTime(c.createdAt)} />
          {c.decidedBy && (
            <>
              <KeyValue layout="row" labelWidth="w-[72px]" label="Decided by" value={c.decidedBy} />
              {c.decidedAt && <KeyValue layout="row" labelWidth="w-[72px]" label="Decided" value={absoluteTime(c.decidedAt)} />}
              {c.decisionNote && (
                <Inline as="span" gap="none" className="mt-1 border-l-2 border-border pl-2 text-[11.5px] leading-snug text-text-secondary">
                  {c.decisionNote}
                </Inline>
              )}
            </>
          )}
        </Stack>
      </Card>

      {c.reviews.length > 0 && (
        <Card padding="md">
          <Stack gap="sm">
            <SectionLabel>Reviews</SectionLabel>
            {c.reviews.map((r) => (
              <Stack key={r.id} gap="none">
                <Inline gap="xs" align="baseline">
                  <Chip tone={VERDICT_TONE[r.verdict]} size="xs">{VERDICT_LABEL[r.verdict]}</Chip>
                  <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">{r.model ?? r.reviewer}</Inline>
                </Inline>
                {r.summary && (
                  <Inline as="span" gap="none" className="text-[11.5px] leading-snug text-text-secondary">{r.summary}</Inline>
                )}
                {r.findings.length > 0 && (
                  <Inline as="span" gap="none" className="text-[10.5px] text-text-tertiary">
                    {r.findings.length} finding{r.findings.length === 1 ? '' : 's'} — pinned in the diff.
                  </Inline>
                )}
              </Stack>
            ))}
          </Stack>
        </Card>
      )}

      {c.gates.length > 0 && (
        <Card padding="md">
          <Stack gap="xs">
            <SectionLabel>Policy gates</SectionLabel>
            {c.gates.map((g, i) => (
              <Inline key={i} gap="xs" align="baseline" wrap>
                <Chip tone={GATE_TONE[g.outcome] ?? 'warning'} size="xs" dot="static">{g.policyName}</Chip>
                <Inline as="span" gap="none" className="text-[11.5px] text-text-secondary">{g.detail}</Inline>
              </Inline>
            ))}
          </Stack>
        </Card>
      )}

      {c.error && (
        <Card padding="md">
          <Inline as="span" gap="none" className="text-[11.5px] leading-snug text-danger">{c.error}</Inline>
        </Card>
      )}

      {canDecide && (decidable || c.status === 'approved' || c.status === 'failed') && (
        <Card padding="md">
          <Stack gap="sm">
            <SectionLabel>Decision</SectionLabel>
            <Inline gap="sm" wrap>
              {decidable && (
                <>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => void act('decide', 'Approving', { decision: 'approve' })}>
                    {c.status === 'changes_requested' ? 'Approve anyway' : 'Approve'}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} tone="surface" onClick={() => void act('decide', 'Rejecting', { decision: 'reject' })}>
                    Reject
                  </Button>
                </>
              )}
              {c.status === 'approved' && (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void act('deliver', 'Delivering', {})}>
                  Deliver as pull request
                </Button>
              )}
              {c.status === 'changes_requested' && (
                <Button
                  variant="secondary" size="sm" disabled={busy}
                  title="Send the reviewer's findings back to an agent to fix"
                  onClick={() => void act('address', 'Dispatching a fix', {})}
                >
                  Address with an agent
                </Button>
              )}
              {(c.status === 'changes_requested' || c.status === 'failed') && (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act('rereview', 'Re-reviewing', {})}>
                  Re-review
                </Button>
              )}
            </Inline>
          </Stack>
        </Card>
      )}
    </Stack>
  );

  return (
    <PageSection
      title={c.title}
      description={`${c.repoFullName ?? 'unknown repo'} — every agent change is reviewed and gated before it can ship.`}
      actions={
        <Link to="/admin/changes" className="whitespace-nowrap text-[12px] text-primary no-underline hover:underline">
          ← back to the queue
        </Link>
      }
    >
      <Inline gap="sm" wrap className="mb-4">
        <Chip tone={STATUS_TONE[c.status] ?? 'neutral'} size="xs" uppercase>{STATUS_LABEL[c.status] ?? c.status}</Chip>
        {c.orgProjectName && c.orgProjectId && (
          <Link to={`/iq/projects/${c.orgProjectId}`} className="text-[11px] text-text-secondary no-underline hover:text-primary hover:underline">
            delivering {c.orgProjectName}
          </Link>
        )}
        {c.prUrl && (
          <ExternalLink external href={c.prUrl} className="text-[11px] text-primary no-underline hover:underline">
            pull request →
          </ExternalLink>
        )}
      </Inline>

      <RailLayout rail={rail} railWidth="sm">
        {c.diff ? (
          <DiffViewer
            diff={c.diff}
            annotations={annotations}
            {...(c.diffTruncated ? { truncatedNote: 'Diff truncated for size — the full change is in the branch once delivered.' } : {})}
          />
        ) : (
          <Card padding="md">
            <Inline as="span" gap="none" className="text-[12px] text-text-tertiary">This change has no stored diff.</Inline>
          </Card>
        )}
      </RailLayout>
    </PageSection>
  );
}
