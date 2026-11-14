// /iq/meetings/:callId — what the meeting assistant left behind: who was there, the summary, decisions, action items
// and the transcript. Only the people who were in the call can read it; everyone else, admins included, gets the
// same "not found" the server gives them. The inviter can delete the record (minutes and transcript together).
// Proposals (docs/meeting-consent-design.md, package 6): each one is drawn with the call chat's own read-only card; someone who
// still owes an answer is asked with the call's own deck prompt in the page's composer deck. A person a proposal names who was
// not in the call sees only that section. A consent that completes one runs it in the executor's browser here (MeetingTurnRunner).
import { useCallback, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Button, DataTable, DetailPage, DetailSection, EmptyState, Inline, LoadingState, MetaLine, Stack, T,
  type DataTableColumn,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { TranscriptPanel } from '@connorhoehn/ui-components/video';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { sendJson } from '../../lib/writeJson';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { newWorkItemHref } from '../projects/initiativeNavigation';
import { ProposalCard } from '../../components/chat/AssistantMessageExtras';
import { proposalPrompt } from '../../components/shell/NovaProposalAsk';
import { MeetingTurnRunner } from '../../components/shell/MeetingTurnRunner';
import { deckQueue, parseProposals } from '../../lib/meetingProposals';
import {
  canCreateFor, durationLabel, peopleLabel, transcriptSegments, whenLabel, minutesUrl, proposalsLive, proposalsUrl,
  type MinutesActionItem, type MinutesView,
} from './meetingsModel';
import { useMeetingTranscript } from './useMeetingTranscript';

export default function MeetingPage() {
  const { callId = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  const minutes = useFetch<MinutesView>(callId ? minutesUrl(callId) : null);
  const transcript = useMeetingTranscript(minutes.data ? callId : null);
  // The call's proposals this person may see; asked again every few seconds while an answer or a run can still change one.
  const [live, setLive] = useState(false);
  const proposalsFetch = useFetch<unknown>(callId ? proposalsUrl(callId) : null, live ? 3000 : undefined);
  const proposals = useMemo(() => parseProposals(proposalsFetch.data), [proposalsFetch.data]);
  const nowLive = proposalsLive(proposals.map((p) => p.state));
  if (nowLive !== live) setLive(nowLive);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const keep = useCallback((key: string) => setKept((k) => new Set([...k, key])), []);
  const head = deckQueue(proposals, kept)[0] ?? null;
  const headInitiative = useFetch<{ name?: string }>(head?.outcome.kind === 'decision' && head.outcome.initiativeId ? `/api/graph/projects/${encodeURIComponent(head.outcome.initiativeId)}` : null);
  const refreshProposals = proposalsFetch.refresh;
  const proposalAsk = useMemo<ComposerPrompt | null>(() => {
    if (!head || !callId) return null;
    const prompt = proposalPrompt(callId, head, headInitiative.data?.name?.trim() || null, { inCall: false, scope: `meeting-proposal:${callId}`, keep });
    // The page's list is read again after every answer, so the card and the next question follow at once.
    return { ...prompt, onAnswer: async (a) => { const out = await prompt.onAnswer(a); refreshProposals(); return out; } };
  }, [head, callId, headInitiative.data?.name, keep, refreshProposals]);
  const me = session?.sub ?? null;
  const mayRunHere = proposals.some((p) => p.executor.userId === me && (p.state === 'consented' || p.state === 'running'));
  // The delete question rides the page's docked composer as a deck prompt; `asked` counts the times it was raised so Delete reopens a hidden one.
  const [asked, setAsked] = useState(0);
  const [answered, setAnswered] = useState(0);
  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'meeting' }, {
    id: 'meeting-commands', label: 'Meeting', placeholder: 'Refresh this meeting…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: () => minutes.refresh(),
    scopeNote: 'Refresh reloads the minutes. Deleting the record is asked here and never done by a typed command.',
  }), [minutes.refresh]);
  const deletePrompt = useMemo<ComposerPrompt | null>(() => asked > answered && minutes.data ? {
    id: `meeting-delete:${callId}:${asked}`, scope: `meeting-delete:${callId}`, kind: 'choice', eyebrow: 'Delete the record', title: minutes.data.callName,
    question: 'Delete the minutes and the transcript for everyone who was in the call? Nova will not write them again, and this cannot be undone. Work items created from them stay.',
    options: [{ id: 'delete', label: 'Delete the record', emphasis: 'danger' }, { id: 'keep', label: 'Keep it' }],
    onAnswer: async (a) => {
      if (!('optionId' in a) || a.optionId !== 'delete') { setAnswered(asked); return; }
      try { await sendJson(`/api/calls/${encodeURIComponent(callId)}/assistant/minutes`, 'DELETE'); navigate('/iq/meetings'); } catch (err) {
        return { error: `Could not delete this record: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  } : null, [asked, answered, callId, minutes.data?.callName, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (minutes.isLoading && !minutes.data) return <LoadingState label="Loading the meeting…" />;
  const m = minutes.data;
  const prompts = [...(proposalAsk ? [proposalAsk] : []), ...(deletePrompt ? [deletePrompt] : [])];
  const runner = callId && mayRunHere ? <MeetingTurnRunner afterCall={{ callId, initiativeId: m?.initiativeId ?? null, active: true }} /> : null;
  // Drawn only when the call had proposals: a call without them keeps the page as it was.
  const proposalSection = (first: boolean) => (proposals.length ? (
    <DetailSection title="Proposals" as="h2" hint={String(proposals.length)} first={first}>
      <Stack gap="sm" data-testid="meeting-proposals">{proposals.map((p) => <ProposalCard key={p.id} proposalId={p.id} state={p.state} statement={p.statement} view={p} />)}</Stack>
    </DetailSection>
  ) : null);
  // A person a proposal names who was not in the call: no minutes for them, only the proposals that need them.
  if (!m && proposals.length) {
    return (
      <>
        <DetailPage data-testid="meeting-page" title="Proposals from a meeting"
          meta={<MetaLine size="sm" items={['You were named in a proposal from a call you were not in', 'Only the proposals that need you are shown']} />}>
          <Stack gap="md" className="pb-6">{proposalSection(true)}</Stack>
        </DetailPage>
        {runner}
        {prompts.length > 0 && <CollectionCommandHost key="dialogue" adapter={adapter} prompts={prompts} />}
      </>
    );
  }
  if (!m && minutes.failure && minutes.failure.status !== 404) {
    return <EmptyState testId="meeting-error" title="This meeting could not be loaded"
      description={minutes.failure.message} action={<Button size="sm" variant="secondary" data-testid="meeting-retry" onClick={minutes.refresh}>Try again</Button>} />;
  }
  if (!m) {
    return <EmptyState testId="meeting-not-found" title="Meeting not found"
      description="There is no meeting record here, or you were not in that call. Only the people who were in a call can read its minutes." />;
  }

  const viewer = session?.sub ?? null;
  const names = m.attendees.map((a) => a.name);
  const columns: DataTableColumn<MinutesActionItem>[] = [
    { key: 'text', header: 'Action item', render: (i) => <T size="sm">{i.text}</T> },
    { key: 'owner', header: 'Owner', width: '208px', render: (i) => <T size="sm">{i.ownerName ?? 'Nobody named'}</T> },
    { key: 'create', header: '', width: '176px', render: (i) => (m.initiativeId && canCreateFor(i, viewer)
      ? <Link to={newWorkItemHref(m.initiativeId, i.text)} data-testid="meeting-create-work-item" className="no-underline"><T size="sm" tone="primary" className="hover:underline">Create work item</T></Link>
      : i.done ? <T size="sm" tone="secondary">Done in the call</T> : null) },
  ];

  return (
    <>
      <DetailPage
        data-testid="meeting-page"
        title={m.callName}
        meta={<MetaLine size="sm" items={[whenLabel(m.startedAt), durationLabel(m.startedAt, m.endedAt), peopleLabel(names), `Nova invited by ${m.invitedByName}`]} />}
        actions={m.youAreInviter
          ? <Button variant="danger" size="sm" data-testid="meeting-delete" onClick={() => setAsked((n) => Math.max(n, answered) + 1)}>Delete this record</Button> : undefined}
      >
        <Stack gap="md" className="pb-6">
          <DetailSection title="Summary" as="h2" first>
            <T size="sm" data-testid="meeting-summary">{m.summary}</T>
          </DetailSection>
          <DetailSection title="Decisions" as="h2" hint={String(m.decisions.length)}>
            {m.decisions.length
              ? <Stack gap="xs" data-testid="meeting-decisions">{m.decisions.map((d, i) => <T key={i} size="sm">{d}</T>)}</Stack>
              : <T size="sm" tone="secondary">No decisions were recorded.</T>}
          </DetailSection>
          {proposalSection(false)}
          <DetailSection title="Action items" as="h2" hint={String(m.actionItems.length)}>
            {m.actionItems.length
              ? <DataTable data={m.actionItems} columns={columns} keyField={(i) => `${i.text}|${i.ownerUserId ?? ''}`} narrow data-testid="meeting-action-items" />
              : <T size="sm" tone="secondary">No action items were recorded.</T>}
          </DetailSection>
          <DetailSection title="Transcript" as="h2" hint={`${m.lineCount} ${m.lineCount === 1 ? 'line' : 'lines'}`}>
            <TranscriptPanel
              title="By speaker"
              status={transcript.error ? 'failed' : transcript.lines.length || !transcript.loading ? 'ready' : 'processing'}
              segments={transcriptSegments(transcript.lines, m.attendees, m.startedAt)}
              {...(transcript.error ? { errorMessage: transcript.error } : {})}
              idleState={<T size="sm" tone="secondary">Nothing was transcribed.</T>}
            />
            {transcript.hasMore && (
              <Inline justify="center" className="pt-2">
                <Button size="sm" variant="secondary" data-testid="meeting-more-transcript" disabled={transcript.loading} onClick={transcript.loadMore}>Load more lines</Button>
              </Inline>
            )}
          </DetailSection>
        </Stack>
      </DetailPage>

      {runner}
      {prompts.length > 0 && <CollectionCommandHost key="dialogue" adapter={adapter} prompts={prompts} />}
    </>
  );
}
