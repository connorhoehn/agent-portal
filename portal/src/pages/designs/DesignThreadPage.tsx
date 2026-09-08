// One design review, in full — built on the library's review-thread family:
// the threaded agent/human discussion (ReviewThread) in the main column, and
// a context rail (RailLayout) carrying what the thread alone cannot say —
// which initiative this steers, who is involved, what gates it and what it
// gates, and the state of the record. Sign-off rides SignoffPanel.
//
// The ADR rules, per the canon: approval is refused while questions are open
// or a dependency is unapproved (enforced server-side — the gate is
// structural, not prompt-deep), and an APPROVED review is immutable — a
// change of direction is a new design that supersedes this one.

import { useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  Avatar,
  Button,
  Card,
  Chip,
  DetailHeader,
  Divider,
  EmptyState,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  PageSection,
  RailLayout,
  RailSection,
  ReviewThread,
  SignoffPanel,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { STATUS_LABEL, STATUS_TONE, latestSignoffs, nextStep } from './designFormat';
import { T } from './Text';
import type { DesignThread } from './types';

interface InitiativeLite {
  ownerName: string | null;
  contributors: Array<{ personId: string; name: string; role: string | null }>;
}

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export default function DesignThreadPage() {
  const { id } = useParams();
  const { can, ready } = useCapabilities();
  const canSteer = ready && can('DispatchAgentRun');
  const [busy, setBusy] = useState(false);

  const { data: thread, isLoading, error, refresh } =
    useFetch<DesignThread>(id ? `/api/designs/${encodeURIComponent(id)}` : null, 20_000);
  // The rail's people: the initiative's governance, not just whoever posted.
  const { data: initiative } = useFetch<InitiativeLite>(
    thread ? `/api/graph/projects/${encodeURIComponent(thread.orgProjectId)}` : null, 60_000);

  async function answer(questionPostId: string, body: string) {
    if (!id || busy) return;
    setBusy(true);
    const tid = toastPending('Answering the agent', 'the loop continues from here');
    try {
      const res = await post(`/api/designs/${encodeURIComponent(id)}/answer`, { questionPostId, body });
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Question resolved', 'the agent posted a revision — review it below');
      refresh();
    } catch (err) {
      toastError(tid, 'Could not answer', (err as Error).message);
    } finally { setBusy(false); }
  }

  async function signoff(decision: 'approve' | 'reject') {
    if (!id || busy) return;
    setBusy(true);
    const tid = toastPending(decision === 'approve' ? 'Signing off' : 'Rejecting', thread?.title ?? '');
    try {
      const res = await post(`/api/designs/${encodeURIComponent(id)}/signoff`, { decision });
      const body = await res.json() as DesignThread & { error?: string; blockingId?: string };
      if (!res.ok) {
        throw new Error(body.blockingId
          ? `${body.error} — see the blocking design`
          : body.error ?? `HTTP ${res.status}`);
      }
      toastSuccess(tid, decision === 'approve'
        ? (body.status === 'approved' ? 'Approved — logged to the knowledge base' : 'Sign-off recorded')
        : 'Rejected');
      refresh();
    } catch (err) {
      toastError(tid, 'Sign-off refused', (err as Error).message);
    } finally { setBusy(false); }
  }

  if (error) return <EmptyState title="Could not load this design" description={error} />;
  if (isLoading || !thread) return <LoadingState label="Loading design review…" />;

  const signoffs = latestSignoffs(thread.signoffs);
  const isTerminal = thread.status === 'approved' || thread.status === 'rejected' || thread.status === 'superseded';

  // Everyone who actually spoke in the thread — humans and the agents.
  const participants = [...new Map(thread.posts.map((p) => [p.authorName, p.authorKind])).entries()];
  const owner = initiative?.ownerName ?? null;
  const smes = (initiative?.contributors ?? []).filter((c) => (c.role ?? '').toLowerCase() === 'sme');

  const rail = (
    <>
      <RailSection title="Initiative">
        <Link to={`/iq/projects/${encodeURIComponent(thread.orgProjectId)}`} className="text-primary no-underline hover:underline">
          {thread.orgProjectName}
        </Link>
        <T as="div" className="text-text-tertiary" wrap>This decision steers the initiative’s design — approved, it binds the work built on it.</T>
      </RailSection>

      <RailSection title="People">
        {owner && (
          <Inline align="center" gap="xs">
            <Avatar name={owner} size={18} />
            <T>{owner}</T>
            <Chip tone="accent" size="xs">owner</Chip>
          </Inline>
        )}
        {smes.map((c) => (
          <Inline key={c.personId} align="center" gap="xs">
            <Avatar name={c.name} size={18} />
            <T>{c.name}</T>
            <Chip tone="info" size="xs">SME</Chip>
          </Inline>
        ))}
        {participants.length > 0 && (
          <>
            <T as="div" className="mt-1 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">In this thread</T>
            {participants.map(([name, kind]) => (
              <Inline key={name} align="center" gap="xs">
                {kind === 'human' ? <Avatar name={name} size={18} /> : <T role="img" aria-label="agent">🤖</T>}
                <T className="truncate">{name}</T>
              </Inline>
            ))}
          </>
        )}
      </RailSection>

      {(thread.dependsOn.length > 0 || thread.gates.length > 0) && (
        <RailSection title="Gates">
          {thread.dependsOn.length > 0 && (
            <Stack gap="xs">
              <T as="div" className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Gated by</T>
              {thread.dependsOn.map((d) => (
                <Link key={d} to={`/iq/designs/${d}`} className="text-primary no-underline hover:underline">{d}</Link>
              ))}
            </Stack>
          )}
          {thread.gates.length > 0 && (
            <Stack gap="xs">
              <T as="div" className="text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Unlocks</T>
              {thread.gates.map((g) => (
                <Link key={g.id} to={`/iq/designs/${g.id}`} className="text-primary no-underline hover:underline">
                  {g.title}
                </Link>
              ))}
            </Stack>
          )}
        </RailSection>
      )}

      <RailSection title="Record">
        <T>{thread.postCount} posts · {thread.openQuestions} open question{thread.openQuestions === 1 ? '' : 's'}</T>
        <T>opened {relativeTime(thread.createdAt)} · updated {relativeTime(thread.updatedAt)}</T>
        {thread.kbSynced
          ? <Chip tone="success" size="xs">in the knowledge base</Chip>
          : <T className="text-text-tertiary">logs to the knowledge base on approval</T>}
      </RailSection>
    </>
  );

  return (
    <PageSection
      title=""
      actions={
        <Link to="/iq/designs" className="text-[12px] text-primary no-underline hover:underline">← All designs</Link>
      }
    >
      <Stack gap="md">
        <DetailHeader
          title={thread.title}
          badge={
            <Chip tone={STATUS_TONE[thread.status]} size="sm" dot="static">
              {STATUS_LABEL[thread.status]}
            </Chip>
          }
          meta={
            <MetaLine
              size="sm"
              items={[
                thread.orgProjectName,
                `${thread.postCount} posts`,
                thread.openQuestions > 0 ? `${thread.openQuestions} open question${thread.openQuestions === 1 ? '' : 's'}` : null,
              ]}
            />
          }
        />

        {/* ── The summary band — what the thread decides, where it stands,
               and its blast radius, BEFORE a single post is read. ── */}
        <Card padding="md">
          <Stack gap="md" className="lg:flex-row">
            <Stack gap="none" className="min-w-0 flex-[2]">
              <T as="div" className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">Summary</T>
              <T as="div" className="m-0 text-[13px] leading-relaxed text-text-secondary" wrap>{thread.summary}</T>
              <Inline align="start" gap="sm" className="mt-2.5">
                <T className="text-[13px]" role="img" aria-label="next step">👉</T>
                <T className="text-[12.5px] font-medium text-text-primary">{nextStep(thread, undefined, canSteer)}</T>
              </Inline>
            </Stack>
            <Stack gap="none" className="min-w-0 lg:hidden">
              {/* Stacked below lg, the two halves of the band have no boundary
                  at all — the border-l only exists side by side. */}
              <Divider spacing="sm" />
            </Stack>
            <Stack gap="none" className="min-w-0 flex-1 lg:border-l lg:border-border lg:pl-4">
              <T as="div" className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                Initiatives affected
              </T>
              <Stack gap="xs">
                {thread.affected.map((a) => (
                  <Stack gap="none" key={a.orgProjectId} className="min-w-0">
                    <Link to={`/iq/projects/${encodeURIComponent(a.orgProjectId)}`} className="text-[12.5px] font-medium text-primary no-underline hover:underline">
                      {a.orgProjectName}
                    </Link>
                    <T as="div" className="text-[11px] text-text-tertiary">{a.impact}</T>
                  </Stack>
                ))}
                {thread.affected.length === 0 && (
                  <T className="text-[12px] text-text-tertiary">only its home initiative</T>
                )}
              </Stack>
            </Stack>
          </Stack>
        </Card>

        {thread.status === 'approved' && (
          <InlineAlert tone="success">
            Approved ADR — immutable and logged to the knowledge base. A change of direction is a
            new design that supersedes this one, not an edit.
          </InlineAlert>
        )}

        <RailLayout rail={rail}>
          <Stack gap="md">
            <ReviewThread
              posts={thread.posts.map((p) => ({
                id: p.id,
                authorKind: p.authorKind,
                authorName: p.authorName,
                kind: p.kind,
                body: p.body,
                resolved: p.resolvedBy != null,
                artifact: p.artifact ? { name: p.artifact.name, type: p.artifact.type, url: p.artifact.url } : null,
                timeLabel: relativeTime(p.createdAt),
              }))}
              {...(canSteer && !isTerminal ? { onAnswer: (postId: string, body: string) => void answer(postId, body) } : {})}
              answerBusy={busy}
            />

            <SignoffPanel
              signoffs={signoffs.map((s) => ({ name: s.personName, role: s.role, decision: s.decision }))}
              required={2}
              {...(canSteer && !isTerminal ? {
                actions: (
                  <Inline gap="sm">
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void signoff('approve')}>
                      Approve
                    </Button>
                    <Button size="sm" variant="secondary" disabled={busy} onClick={() => void signoff('reject')}>
                      Reject
                    </Button>
                  </Inline>
                ),
              } : {})}
            />
          </Stack>
        </RailLayout>
      </Stack>
    </PageSection>
  );
}
