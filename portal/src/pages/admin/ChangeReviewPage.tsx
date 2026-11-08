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
  T,
  Button,
  Card,
  Chip,
  DiffViewer,
  EmptyState,
  Inline,
  InlineAlert,
  Link as ExternalLink,
  LoadingState,
  PageHeader,
  PageSection,
  RailLayout,
  SectionLabel,
  Stack,
  type DiffAnnotation,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { useSession } from '../../lib/auth';
import { absoluteTime } from '../../lib/relativeTime';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { sendJson } from '../../lib/writeJson';
import { STATUS_TONE, STATUS_LABEL, changeActionGate } from './changesFormat';
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
  /** Who caused the change; the server refuses their own approval (409 self-approval, DE-43). */
  requestedBy?: string | null;
  error: string | null; createdAt: string; reviews: Review[]; gates: Gate[];
}

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
  // Reading the change is ManageDevbox (sdlc.ts `readGate`); each decision
  // button asks the action its own route checks (DE-42, table in
  // changesFormat.ts): decide → DecideAgentChange, deliver →
  // DeliverAgentChange, address / rereview → RunDevboxTask.
  const { can, ready } = useCapabilities();
  const { session } = useSession();
  const { data, error, isLoading, refresh } =
    useFetch<{ change: Change }>(id ? `/api/sdlc/changes/${encodeURIComponent(id)}` : null, 15_000);
  const c = data?.change ?? null;
  const viewer = { can, ready, sub: session?.sub };
  const decide = changeActionGate('decide', c ?? {}, viewer);
  const deliver = changeActionGate('deliver', c ?? {}, viewer);
  const address = changeActionGate('address', c ?? {}, viewer);
  const rereview = changeActionGate('rereview', c ?? {}, viewer);
  const [busy, setBusy] = useState(false);

  const act = useCallback(async (path: string, verb: string, body: Record<string, unknown>) => {
    if (!id) return;
    setBusy(true);
    const tid = toastPending(verb, '');
    try {
      const out = await sendJson<{ prUrl?: string; status?: string }>(`/api/sdlc/changes/${id}/${path}`, 'POST', body);
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
    // A denial is not a missing change: reading a change request needs ManageDevbox, the same gate as the queue.
    const denied = error != null && /\b(401|403)\b|forbidden|unauthor/i.test(error);
    return (
      <Stack gap="md">
        <PageHeader density="compact" title="Change review" />
        <EmptyState
          title={denied ? 'You cannot review this change' : 'Could not load this change'}
          body={denied
            ? 'Reading change requests requires computer access, which this role does not hold. Switch to HR Admin from the identity menu, or ask an admin for the grant.'
            : (error ?? 'No such change request.')}
          actionLabel="Back to the queue"
          onAction={() => navigate('/admin/changes')}
        />
      </Stack>
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
                <T as="span" size="xs" tone="secondary" className="mt-1 border-l-2 border-border pl-2">
                  {c.decisionNote}
                </T>
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
                  <T as="span" size="xs" tone="tertiary">{r.model ?? r.reviewer}</T>
                </Inline>
                {r.summary && (
                  <T as="span" size="xs" tone="secondary">{r.summary}</T>
                )}
                {r.findings.length > 0 && (
                  <T as="span" size="xs" tone="tertiary">
                    {r.findings.length} finding{r.findings.length === 1 ? '' : 's'} — pinned in the diff.
                  </T>
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
                <T as="span" size="xs" tone="secondary">{g.detail}</T>
              </Inline>
            ))}
          </Stack>
        </Card>
      )}

      {c.error && (
        <Card padding="md">
          <T as="span" size="xs" tone="inherit" className="text-danger">{c.error}</T>
        </Card>
      )}

      {((decide.show && decidable)
        || (deliver.show && c.status === 'approved')
        || (address.show && c.status === 'changes_requested')
        || (rereview.show && (c.status === 'changes_requested' || c.status === 'failed'))) && (
        <Card padding="md">
          <Stack gap="sm">
            <SectionLabel>Decision</SectionLabel>
            {decide.show && decidable && decide.reason && (
              <InlineAlert tone="info">{decide.reason}</InlineAlert>
            )}
            <Inline gap="sm" wrap>
              {decide.show && decidable && (
                <>
                  <Button
                    variant="primary" size="sm" disabled={busy || decide.disabled}
                    title={decide.reason ?? undefined}
                    onClick={() => void act('decide', 'Approving', { decision: 'approve' })}
                  >
                    {c.status === 'changes_requested' ? 'Approve anyway' : 'Approve'}
                  </Button>
                  <Button
                    variant="secondary" size="sm" disabled={busy || decide.disabled} tone="surface"
                    title={decide.reason ?? undefined}
                    onClick={() => void act('decide', 'Rejecting', { decision: 'reject' })}
                  >
                    Reject
                  </Button>
                </>
              )}
              {deliver.show && c.status === 'approved' && (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => void act('deliver', 'Delivering', {})}>
                  Deliver as pull request
                </Button>
              )}
              {address.show && c.status === 'changes_requested' && (
                <Button
                  variant="secondary" size="sm" disabled={busy}
                  title="Send the reviewer's findings back to an agent to fix"
                  onClick={() => void act('address', 'Dispatching a fix', {})}
                >
                  Address with an agent
                </Button>
              )}
              {rereview.show && (c.status === 'changes_requested' || c.status === 'failed') && (
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
        <Link to="/admin/changes" className="whitespace-nowrap text-primary no-underline hover:underline"><T as="span" size="xs" tone="inherit">
          ← back to the queue
        </T></Link>
      }
    >
      <Inline gap="sm" wrap className="mb-4">
        <Chip tone={STATUS_TONE[c.status] ?? 'neutral'} size="xs" uppercase>{STATUS_LABEL[c.status] ?? c.status}</Chip>
        {c.orgProjectName && c.orgProjectId && (
          <Link to={`/iq/projects/${c.orgProjectId}`} className="no-underline hover:text-primary hover:underline"><T as="span" size="xs" tone="secondary">
            delivering {c.orgProjectName}
          </T></Link>
        )}
        {c.prUrl && (
          <ExternalLink external href={c.prUrl} className="text-primary no-underline hover:underline"><T as="span" size="xs" tone="inherit">
            pull request →
          </T></ExternalLink>
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
            <T as="span" size="xs" tone="tertiary">This change has no stored diff.</T>
          </Card>
        )}
      </RailLayout>
    </PageSection>
  );
}
