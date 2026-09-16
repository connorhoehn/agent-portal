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

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  ErrorState,
  Inline,
  InlineAlert,
  Link as ExternalLink,
  LoadingState,
  MetaLine,
  PageSection,
  SectionLabel,
  Stack,
  Tabs,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { parsePgTimestampAsUtc } from '../../lib/pgTimestamp';
import { relativeTime } from '../../lib/relativeTime';
import { toastPending, toastSuccess, toastError } from '../../lib/toastStore';
import { STATUS_TONE, STATUS_LABEL } from './changesFormat';
import { sendJson } from '../../lib/writeJson';
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
  orgProjectId: string | null; orgProjectName: string | null;
  title: string; status: string; diff: string | null; diffTruncated: boolean;
  files: string[]; filesChanged: number; model: string | null;
  branchName: string | null; prUrl: string | null;
  decidedBy: string | null; decisionNote: string | null; error: string | null;
  createdAt: string; reviews: Review[]; gates: Gate[];
}

const VERDICT_LABEL: Record<Verdict, string> = {
  approve: 'approved', request_changes: 'requested changes', reject: 'rejected',
};
const VERDICT_TONE: Record<Verdict, 'success' | 'danger' | 'warning'> = {
  approve: 'success', reject: 'danger', request_changes: 'warning',
};

/** Parse a DB timestamp — naive, `+00`-zoned or proper ISO — to millis. */
function tsOf(iso: string): number {
  return parsePgTimestampAsUtc(iso)?.getTime() ?? Number.NaN;
}

/** Terminal states — a real final outcome, never "superseded" even if older. */
const TERMINAL = new Set(['delivered', 'rejected', 'blocked']);

export default function ChangesPage() {
  const [tab, setTab] = useState<'queue' | 'policies'>('queue');
  // The WHOLE surface rides /api/sdlc, which is mounted requireAction
  // ('ManageDevbox') — the list included, not just the decisions and policy
  // edits. Without that authority there is no readable queue: the fetch 403s
  // and this page knows nothing about what is waiting. So ManageDevbox gates
  // the decision buttons and the Policies tab, and a denied list is reported
  // as a denial below rather than being rendered as an empty queue.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageDevbox');
  const { data, error, isLoading, refresh } = useFetch<{ changes: Change[] }>('/api/sdlc/changes', 15_000);
  // A denial and an outage are different facts and get different words. The
  // one thing neither may be reported as is "no changes yet".
  const denied = error != null && /\b(401|403)\b|forbidden|unauthor/i.test(error);
  const unreachable = error != null && !denied;
  const [busy, setBusy] = useState<string | null>(null);

  const act = useCallback(async (
    id: string, path: string, verb: string, body: Record<string, unknown>,
  ) => {
    setBusy(id);
    const tid = toastPending(verb, '');
    try {
      const out = await sendJson<{ prUrl?: string; status?: string }>(`/api/sdlc/changes/${id}/${path}`, 'POST', body);
      toastSuccess(tid, 'Done', out.prUrl ? `Pull request opened.` : (out.status ?? 'updated'));
      refresh();
    } catch (err) {
      toastError(tid, `Could not ${verb.toLowerCase()}`, (err as Error).message);
    } finally { setBusy(null); }
  }, [refresh]);

  const changes = data?.changes ?? [];

  // Delivery ships the live workspace, and a project has one workspace, so only
  // the newest change for a project matches what is on disk — the backend
  // refuses to deliver any older one. Mirror that here: a non-terminal change
  // that a newer capture has overtaken is superseded, and we suppress its
  // forward actions so nobody approves a change they then cannot deliver.
  const supersededIds = useMemo(() => {
    const latestAt = new Map<string, number>();
    for (const c of changes) {
      const t = tsOf(c.createdAt);
      const prev = latestAt.get(c.projectId);
      if (prev === undefined || t > prev) latestAt.set(c.projectId, t);
    }
    const ids = new Set<string>();
    for (const c of changes) {
      if (TERMINAL.has(c.status)) continue;
      if (tsOf(c.createdAt) < (latestAt.get(c.projectId) ?? 0)) ids.add(c.id);
    }
    return ids;
  }, [changes]);

  // A superseded change is not something the reviewer still needs to act on —
  // the action moved to the newer capture — so keep it out of the "needs you"
  // queue even while its row still reads needs_approval/changes_requested.
  const needsYou = changes.filter(
    (c) => (c.status === 'needs_approval' || c.status === 'changes_requested') && !supersededIds.has(c.id),
  );
  const rest = changes.filter((c) => !needsYou.includes(c));

  const tabItems = canManage
    ? [
        { id: 'queue', label: `Review queue${needsYou.length ? ` (${needsYou.length})` : ''}` },
        { id: 'policies', label: 'Policies' },
      ]
    : [{ id: 'queue', label: `Review queue${needsYou.length ? ` (${needsYou.length})` : ''}` }];

  return (
    <PageSection
      title="Changes"
      description="Code agents wrote, and the decision each one is waiting on. Every agent change is reviewed and gated before it can ship."
    >
      <Tabs items={tabItems} value={tab} onValueChange={(id) => setTab(id as 'queue' | 'policies')} size="sm" className="mb-4" />

      {tab === 'policies' && canManage ? <PolicyEditor /> : (
        <Stack gap="md">
          {/* The list is stale, not gone — rows below are from the last good
              fetch, and the queue may have moved since. */}
          {error && changes.length > 0 && (
            <InlineAlert tone="warning">
              {denied
                ? 'These rows are from before your role changed — the review queue is no longer readable to this role, so nothing here is refreshing.'
                : `Showing the last queue this page could load — refreshes are failing (${error}). Newer changes may be missing.`}
            </InlineAlert>
          )}

          {needsYou.length > 0 && (
            <Stack gap="sm">
              <SectionLabel className="text-warning">Needs you</SectionLabel>
              <Stack gap="sm">
                {needsYou.map((c) => (
                  <ChangeCard key={c.id} change={c}
                    busy={busy === c.id} act={act} superseded={supersededIds.has(c.id)} />
                ))}
              </Stack>
            </Stack>
          )}

          {rest.length > 0 && (
            <Stack gap="sm">
              <SectionLabel>Recent</SectionLabel>
              <Stack gap="sm">
                {rest.map((c) => (
                  <ChangeCard key={c.id} change={c}
                    busy={busy === c.id} act={act} superseded={supersededIds.has(c.id)} />
                ))}
              </Stack>
            </Stack>
          )}

          {/* Three different facts, three different cards. An empty queue is
              an all-clear; a denial and an outage are not, and rendering
              either as "No changes yet" tells a reviewer their review queue is
              clear when the truth is that this page cannot see it. */}
          {changes.length === 0 && denied && (
            <ErrorState
              title="You cannot see the review queue"
              description={
                <>
                  Reading change requests requires the <code>ManageDevbox</code> authority,
                  which this role does not hold — so this page cannot say whether anything is waiting.
                  It is not empty; it is unreadable. Dispatch rights
                  (<code>DispatchAgentRun</code>) let you start governed runs but not review
                  what they produce. Switch to HR Admin from the identity menu, top right, or ask an admin for the
                  grant.
                </>
              }
            />
          )}

          {changes.length === 0 && unreachable && (
            <ErrorState
              title="Review queue unreachable"
              description={`This list is unknown, not empty — there may be changes waiting for a decision. ${error}`}
              actionLabel="Try again"
              onAction={refresh}
            />
          )}

          {changes.length === 0 && isLoading && !error && (
            <LoadingState label="Loading the review queue…" />
          )}

          {changes.length === 0 && !isLoading && !error && (
            <EmptyState
              title="No changes yet"
              description={
                <>
                  When an agent changes code in a{' '}
                  <Link to="/admin/projects" className="text-primary no-underline hover:underline">codebase</Link>,
                  the change is captured, reviewed, and gated — and shows up here for whatever decision it needs.
                </>
              }
            />
          )}
        </Stack>
      )}
    </PageSection>
  );
}

function ChangeCard({ change: c, busy, act, superseded }: {
  change: Change; busy: boolean;
  act: (id: string, path: string, verb: string, body: Record<string, unknown>) => void;
  superseded: boolean;
}) {
  const { can, ready } = useCapabilities();
  const canDecide = ready && can('ManageDevbox');
  const review = c.reviews[0] ?? null;
  const blockingGates = c.gates.filter((g) => g.outcome !== 'pass');

  return (
    <Card padding="none">
      <Inline align="center" gap="sm" wrap justify="between" className="border-b border-border px-3.5 py-2.5">
        <Inline align="center" gap="sm" wrap>
          <Chip tone={STATUS_TONE[c.status] ?? 'neutral'} size="xs">{STATUS_LABEL[c.status] ?? c.status}</Chip>
          {superseded && (
            <Chip tone="neutral" size="xs" title="A newer change has been captured for this codebase">superseded</Chip>
          )}
          <Inline as="span" gap="none" className="min-w-0 truncate text-[13px] font-semibold text-text-primary">{c.title}</Inline>
        </Inline>
        {c.repoFullName && (
          <Link
            to={`/admin/projects?project=${c.projectId}`}
            title="Open this codebase"
            className="shrink-0 font-mono text-[11px] text-text-tertiary no-underline hover:text-primary hover:underline"
          >
            {c.repoFullName}
          </Link>
        )}
      </Inline>

      <Stack gap="sm" className="px-3.5 py-2.5">
        <MetaLine
          size="xs"
          items={[
            `${c.filesChanged} ${c.filesChanged === 1 ? 'file' : 'files'}`,
            c.model ?? 'unknown model',
            relativeTime(c.createdAt),
            // The run that wrote this change — jumps to the codebase with that
            // run highlighted, so a reviewer can read what the agent was asked
            // before judging what it did.
            c.runId && (
              <Link
                key="run"
                to={`/admin/projects?project=${c.projectId}&run=${c.runId}`}
                title="Open the run that produced this change"
                className="text-text-secondary no-underline hover:text-primary hover:underline"
              >
                run {c.runId.slice(0, 8)}
              </Link>
            ),
            // The initiative this code serves — the thread from org intent to a
            // delivered change, which is the whole reason codebases join the
            // org graph.
            c.orgProjectName && (
              c.orgProjectId ? (
                <Link
                  key="proj"
                  to={`/iq/projects/${c.orgProjectId}`}
                  title="Open this initiative"
                  className="text-text-secondary no-underline hover:text-primary hover:underline"
                >
                  delivering {c.orgProjectName}
                </Link>
              ) : (
                <span key="proj">delivering {c.orgProjectName}</span>
              )
            ),
          ]}
        />

        {/* Why a human is here — the gates that did not pass. */}
        {blockingGates.length > 0 && (
          <Stack gap="xs">
            {blockingGates.map((g, i) => (
              <Chip key={i} tone={g.outcome === 'block' ? 'danger' : 'warning'} size="xs" dot="static">
                {g.detail}
              </Chip>
            ))}
          </Stack>
        )}

        {/* What the reviewer said. */}
        {review && (
          <Card padding="sm">
            <Stack gap="xs">
              <Inline gap="xs" align="baseline">
                <Chip tone={VERDICT_TONE[review.verdict]} size="xs">Reviewer {VERDICT_LABEL[review.verdict]}</Chip>
                <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">{review.model ?? 'model'}</Inline>
              </Inline>
              {review.summary && (
                <Inline as="span" gap="none" className="text-[12px] leading-snug text-text-secondary">{review.summary}</Inline>
              )}
              {review.findings.length > 0 && (
                <Stack gap="none" className="mt-0.5">
                  {review.findings.slice(0, 6).map((f, i) => (
                    <Inline key={i} gap="xs" wrap>
                      <Chip
                        size="xs"
                        tone={f.severity === 'high' ? 'danger' : f.severity === 'low' ? 'neutral' : 'warning'}
                      >
                        {f.severity ?? 'note'}
                      </Chip>
                      <Inline as="span" gap="none" className="text-[11px] leading-snug text-text-tertiary">
                        {f.file ? `${f.file}${f.line ? `:${f.line}` : ''} — ` : ''}{f.note}
                      </Inline>
                    </Inline>
                  ))}
                </Stack>
              )}
            </Stack>
          </Card>
        )}

        {c.error && <Inline as="span" gap="none" className="text-[11px] leading-snug text-danger">{c.error}</Inline>}
        {c.prUrl && (
          <ExternalLink external href={c.prUrl} className="inline-block text-[12px] text-primary no-underline hover:underline">
            View pull request →
          </ExternalLink>
        )}

        {/* Actions, by state. A superseded change has been overtaken by a newer
            capture on the same codebase; its forward actions are gone because
            delivery would ship the newer change's content — act on that one. */}
        <Inline gap="sm" align="center" wrap>
          {superseded ? (
            <Inline as="span" gap="none" className="text-[11px] italic text-text-tertiary">
              A newer change supersedes this one — decide and deliver the latest change for this codebase instead.
            </Inline>
          ) : !canDecide ? null : (
            <>
              {(c.status === 'needs_approval' || c.status === 'changes_requested') && (
                <>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => act(c.id, 'decide', 'Approving', { decision: 'approve' })}>
                    {c.status === 'changes_requested' ? 'Approve anyway' : 'Approve'}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(c.id, 'decide', 'Rejecting', { decision: 'reject' })}>
                    Reject
                  </Button>
                </>
              )}
              {c.status === 'approved' && (
                <Button variant="primary" size="sm" disabled={busy} onClick={() => act(c.id, 'deliver', 'Delivering', {})}>
                  {busy ? 'delivering…' : 'Deliver as pull request'}
                </Button>
              )}
              {c.status === 'changes_requested' && (
                <Button
                  variant="secondary" size="sm" disabled={busy}
                  title="Send the reviewer's findings back to an agent to fix"
                  onClick={() => act(c.id, 'address', 'Dispatching a fix', {})}
                >
                  Address with an agent
                </Button>
              )}
              {(c.status === 'changes_requested' || c.status === 'failed') && (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => act(c.id, 'rereview', 'Re-reviewing', {})}>
                  Re-review
                </Button>
              )}
            </>
          )}
          {c.diff && (
            <Link
              to={`/admin/changes/${c.id}`}
              className="rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-text-secondary no-underline hover:border-primary hover:text-primary transition-colors"
              title="Per-file diff with the reviewer's findings pinned to lines"
            >
              Review diff →
            </Link>
          )}
        </Inline>
      </Stack>
    </Card>
  );
}
