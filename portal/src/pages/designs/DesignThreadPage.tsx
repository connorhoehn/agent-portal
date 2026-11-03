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
import { Link, useNavigate, useParams } from 'react-router';
import {
  Avatar,
  Button,
  Chip,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  RailSection,
  ReviewThread,
  SectionLabel,
  SignoffPanel,
  Stack, T,
} from '@connorhoehnslalom/ui-components/shared';
import { SidePane, useSidePaneHost } from '@connorhoehnslalom/ui-components';
import { useFetch } from '../../hooks/useFetch';
import { RecordNotFound, UnavailableNotice, isNotFoundError } from '../../components/UnavailableNotice';
import { useCrumbLabel } from '../../lib/crumbLabels';
import { useCapabilities } from '../../lib/capabilities';
import { relativeTime } from '../../lib/relativeTime';
import { toastError, toastPending, toastSuccess } from '../../lib/toastStore';
import { writeJson } from '../../lib/writeJson';
import { DESIGNS_SOURCE, STATUS_LABEL, STATUS_TONE, designParticipantPortrait, designParticipants, latestSignoffs, nextStep } from './designFormat';
import type { DesignThread } from './types';

interface InitiativeLite {
  ownerId: string | null;
  ownerName: string | null;
  contributors: Array<{ personId: string; name: string; role: string | null; avatarUrl?: string | null }>;
}

export default function DesignThreadPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, ready } = useCapabilities();
  const canSteer = ready && can('DispatchAgentRun');
  const [busy, setBusy] = useState(false);
  const infoPane = useSidePaneHost();

  const { data: thread, isLoading, error, refresh } =
    useFetch<DesignThread>(id ? `/api/designs/${encodeURIComponent(id)}` : null, 20_000);
  // The trail reads the design's title, not "des-auth…".
  useCrumbLabel(id, thread?.title);
  // The rail's people: the initiative's governance, not just whoever posted.
  const { data: initiative } = useFetch<InitiativeLite>(
    thread ? `/api/graph/projects/${encodeURIComponent(thread.orgProjectId)}` : null, 60_000);

  async function answer(questionPostId: string, body: string) {
    if (!id || busy) return;
    setBusy(true);
    const tid = toastPending('Answering the agent', 'the loop continues from here');
    try {
      const res = await writeJson(`/api/designs/${encodeURIComponent(id)}/answer`, 'POST', { questionPostId, body });
      if (!res.ok) throw new Error(res.error ?? 'unknown error');
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
      const res = await writeJson<DesignThread & { blockingId?: string }>(`/api/designs/${encodeURIComponent(id)}/signoff`, 'POST', { decision });
      if (!res.ok) {
        throw new Error(res.data?.blockingId
          ? `${res.error} — see the blocking design`
          : res.error ?? 'unknown error');
      }
      toastSuccess(tid, decision === 'approve'
        ? (res.data?.status === 'approved' ? 'Approved — logged to the knowledge base' : 'Sign-off recorded')
        : 'Rejected');
      refresh();
    } catch (err) {
      toastError(tid, 'Sign-off refused', (err as Error).message);
    } finally { setBusy(false); }
  }

  if (error && isNotFoundError(error)) {
    return <RecordNotFound heading="Design" size="md" title="Design not found" body={`No design review has the id "${id}".`} backLabel="All designs" onBack={() => navigate('/iq/designs')} />;
  }
  if (error) return <UnavailableNotice error={error} what="this design" source={DESIGNS_SOURCE} onRetry={refresh} />;
  if (isLoading || !thread) return <LoadingState label="Loading design review…" />;

  const signoffs = latestSignoffs(thread.signoffs);
  const isTerminal = thread.status === 'approved' || thread.status === 'rejected' || thread.status === 'superseded';

  // Everyone who actually spoke in the thread — humans and the agents.
  const participants = designParticipants(thread.posts);
  const owner = initiative?.ownerName ?? null;
  const ownerPhoto = initiative?.contributors.find(person => person.personId === initiative.ownerId)?.avatarUrl ?? undefined;
  const photoFor = (name: string, identity?: string) => designParticipantPortrait(name, thread, initiative?.contributors ?? [], identity);
  const smes = (initiative?.contributors ?? []).filter((c) => (c.role ?? '').toLowerCase() === 'sme');

  const rail = (
    <>
      <RailSection variant="plain" title="Initiative">
        <Link to={`/iq/projects/${encodeURIComponent(thread.orgProjectId)}`} className="text-primary no-underline hover:underline">
          {thread.orgProjectName}
        </Link>
        <T as="div" className="text-text-tertiary" wrap>This decision steers the initiative’s design — approved, it binds the work built on it.</T>
      </RailSection>

      <RailSection variant="plain" title="Initiatives affected">
        <Stack gap="xs">
          {thread.affected.map((a) => (
            <Stack gap="none" key={a.orgProjectId} className="min-w-0">
              <Link to={`/iq/projects/${encodeURIComponent(a.orgProjectId)}`} className="text-xs font-medium text-primary no-underline hover:underline">
                {a.orgProjectName}
              </Link>
              <T size="xs" as="div" className="text-text-tertiary">{a.impact}</T>
            </Stack>
          ))}
          {thread.affected.length === 0 && (
            <T size="xs" className="text-text-tertiary">only its home initiative</T>
          )}
        </Stack>
      </RailSection>

      <RailSection variant="plain" title="People">
        {owner && (
          <Inline align="center" gap="xs">
            <Avatar name={owner} src={ownerPhoto} size={24} />
            <T>{owner}</T>
            <Chip tone="accent" size="xs">owner</Chip>
          </Inline>
        )}
        {smes.map((c) => (
          <Inline key={c.personId} align="center" gap="xs">
            <Avatar name={c.name} src={c.avatarUrl ?? undefined} size={24} />
            <T>{c.name}</T>
            <Chip tone="info" size="xs">SME</Chip>
          </Inline>
        ))}
        {participants.length > 0 && (
          <>
            <SectionLabel as="div" className="mt-1">In this thread</SectionLabel>
            {participants.map(({ authorName: name, authorKind: kind, authorId, id }) => (
              <Inline key={authorId ?? id} align="center" gap="xs">
                {kind === 'human' ? <Avatar name={name} src={photoFor(name, authorId)} size={24} /> : <T role="img" aria-label="agent">🤖</T>}
                <T className="truncate">{name}</T>
              </Inline>
            ))}
          </>
        )}
      </RailSection>

      {(thread.dependsOn.length > 0 || thread.gates.length > 0) && (
        <RailSection variant="plain" title="Gates">
          {thread.dependsOn.length > 0 && (
            <Stack gap="xs">
              <SectionLabel as="div">Gated by</SectionLabel>
              {thread.dependsOn.map((d) => (
                <Link key={d} to={`/iq/designs/${d}`} className="text-primary no-underline hover:underline">{d}</Link>
              ))}
            </Stack>
          )}
          {thread.gates.length > 0 && (
            <Stack gap="xs">
              <SectionLabel as="div">Unlocks</SectionLabel>
              {thread.gates.map((g) => (
                <Link key={g.id} to={`/iq/designs/${g.id}`} className="text-primary no-underline hover:underline">
                  {g.title}
                </Link>
              ))}
            </Stack>
          )}
        </RailSection>
      )}

      <RailSection variant="plain" title="Record">
        <T>{thread.postCount} posts · {thread.openQuestions} open question{thread.openQuestions === 1 ? '' : 's'}</T>
        <T>opened {relativeTime(thread.createdAt)} · updated {relativeTime(thread.updatedAt)}</T>
        {thread.kbSynced
          ? <Chip tone="success" size="xs">in the knowledge base</Chip>
          : <T className="text-text-tertiary">logs to the knowledge base on approval</T>}
      </RailSection>
    </>
  );

  return (
    <Stack gap="none" data-testid="design-thread">
      <Stack gap="md" className="max-w-4xl">
        <Inline align="center" gap="sm">
          <Chip tone={STATUS_TONE[thread.status]} size="sm" dot="static">
            {STATUS_LABEL[thread.status]}
          </Chip>
          <MetaLine
            size="sm"
            items={[
              thread.orgProjectName,
              `${thread.postCount} posts`,
              thread.openQuestions > 0 ? `${thread.openQuestions} open question${thread.openQuestions === 1 ? '' : 's'}` : null,
            ]}
          />
          <Button size="sm" variant="secondary" className="ml-auto" aria-expanded={infoPane.shown && !infoPane.folded}
            onClick={() => infoPane.shown && !infoPane.folded ? infoPane.collapse() : infoPane.reveal()}>Design details</Button>
        </Inline>

        <Stack gap="sm" className="border-y border-border py-4">
          <SectionLabel as="div">Summary</SectionLabel>
          <T size="sm" as="div" className="m-0 leading-relaxed text-text-secondary" wrap>{thread.summary}</T>
          <T size="xs" weight="medium" tone="primary" wrap>{nextStep(thread, undefined, canSteer)}</T>
        </Stack>

        {thread.status === 'approved' && (
          <InlineAlert tone="success">
            Approved ADR — immutable and logged to the knowledge base. A change of direction is a
            new design that supersedes this one, not an edit.
          </InlineAlert>
        )}

        <SidePane title="Design details" subtitle={thread.title} paneId="design-details" explores widthPx={{ min: 360, max: 440 }} data-testid="design-details-pane">
          <Stack gap="none" className="min-h-0 flex-1 overflow-y-auto p-4">{rail}</Stack>
        </SidePane>
        <Stack gap="md">
          <ReviewThread
            variant="inline"
            posts={thread.posts.map((p) => ({
              id: p.id,
              authorKind: p.authorKind,
              authorName: p.authorName,
              avatarUrl: p.authorKind === 'human' ? (p.avatarUrl === undefined ? photoFor(p.authorName, p.authorId) : p.avatarUrl ?? undefined) : undefined,
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
            variant="inline"
            signoffs={signoffs.map((s) => ({ name: s.personName, avatarUrl: s.avatarUrl === undefined ? photoFor(s.personName, s.signerId) : s.avatarUrl ?? undefined, role: s.role, decision: s.decision }))}
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
      </Stack>
    </Stack>
  );
}
