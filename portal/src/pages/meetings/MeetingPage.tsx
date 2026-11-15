// /iq/meetings/:callId — what Nova left behind, read at a glance: who was there, what came out of it and what waits on the viewer.
// Only the people who were in the call can read it; everyone else, admins included, gets the same "not found" the server gives them;
// someone who was there is told when it was deleted or expired. The inviter can delete the meeting (minutes and transcript together)
// from the header's menu. Failed minutes can be written again from the same menu, within the server's cap.
// Layout: one meta line, "Needs you" (only when something waits on the viewer), a short summary, then the outcomes as tables
// (Decisions, Action items, Proposals), and the transcript last, collapsed. A proposal row opens its detail in a drawer; someone who
// still owes an answer is asked with the call's own deck prompt in the page's composer deck ("Answer" brings that proposal to the
// front). A person a proposal names who was not in the call sees only the proposals. A consent that completes one runs it in the
// executor's browser here (MeetingTurnRunner).
import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router';
import {
  Button, ChevronIcon, DataTable, DetailPage, DetailSection, Disclosure, Drawer, DropdownMenu, EmptyState, Inline, Link, LoadingState, MetaLine,
  IconButton, MoreIcon, Prose, Stack, StatusPill, T,
  type DataTableColumn, type DropdownMenuItem,
} from '@connorhoehn/ui-components/shared';
import type { ComposerPrompt } from '@connorhoehn/ui-components/social/rich-composer';
import { TranscriptPanel } from '@connorhoehn/ui-components/video';
import { useSession } from '../../lib/auth';
import { useFetch } from '../../hooks/useFetch';
import { sendJson } from '../../lib/writeJson';
import { CollectionCommandHost } from '../../components/collections/CollectionCommandHost';
import { collectionCommandAdapter } from '../../components/collections/collectionCommands';
import { proposalPrompt } from '../../components/shell/NovaProposalAsk';
import { MeetingTurnRunner } from '../../components/shell/MeetingTurnRunner';
import { answerProposal, raiseProposalAgain } from '../../lib/meetingAssistant';
import { bumpProposalPrompt } from '../../lib/proposalDeckState';
import {
  blockedLine, deckQueue, eyebrowOf, expiryLine, heardText, isAnswerable, needsLine, optionalFor, outcomeLine, parseProposals, personChips,
  recordsLine, resultHref, stateLine, waitingOnYou, RUN_NOW, type ProposalView,
} from '../../lib/meetingProposals';
import {
  actionStatus, actionWaitsOn, canCreateFor, decisionRows, goneCopy, headerMeta, minutesWritten, orderProposals, proposalClosed, proposalPill,
  quietMeta, summaryOf, actionText, facesFor, outcomeShort, transcriptSegments, minutesUrl, proposalsLive, proposalsUrl, rewriteUrl, createWorkItemUrl, workItemLink,
  MINUTES_UNAVAILABLE, type DecisionRow, type MinutesActionItem, type MinutesView,
} from './meetingsModel';
import { useMeetingTranscript } from './useMeetingTranscript';
import { Faces, PersonName } from './Faces';

/** A link inside the portal that navigates in place on a plain click, at the size of the text it sits in. */
function PortalLink({ href, children, testId }: { href: string; children: ReactNode; testId?: string }) {
  const navigate = useNavigate();
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } };
  return <T size="sm"><Link href={href} onClick={onClick} {...(testId ? { 'data-testid': testId } : {})}>{children}</Link></T>;
}

/**
 * "Create work item" on an action item: the server makes it on the meeting's initiative and records it, so the row then says so with
 * its link. A refusal is said beside the button.
 */
function CreateWorkItem({ callId, index, onDone, testId }: { callId: string; index: number; onDone: () => void; testId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = (e: MouseEvent) => {
    e.stopPropagation();
    if (busy) return;
    setBusy(true); setError(null);
    void sendJson(createWorkItemUrl(callId, index), 'POST').then(onDone, (err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false));
  };
  return (
    <Inline gap="xs" align="center" wrap={false} className="min-w-0">
      <Button variant="link" size="sm" disabled={busy} onClick={create} data-testid={testId}>Create work item</Button>
      {error && <T size="sm" tone="danger" truncate title={error} role="alert">{error}</T>}
    </Inline>
  );
}

/** The initiative's name, read once per id; "—" until known or when there is none. */
function InitiativeName({ id }: { id: string | null }) {
  const named = useFetch<{ name?: string }>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : null);
  return <T size="sm" tone="secondary" truncate>{named.data?.name?.trim() || '—'}</T>;
}

/**
 * What a proposal does: in the table, short ("Decision · Observability Platform"); in its detail, the full sentence ("Record as a
 * decision on Observability Platform"). The target is the decision's initiative, else the meeting's.
 */
function OutcomeWords({ p, full = false, meetingInitiativeId = null }: { p: ProposalView; full?: boolean; meetingInitiativeId?: string | null }) {
  const id = (p.outcome.kind === 'decision' ? p.outcome.initiativeId : null) ?? meetingInitiativeId;
  const named = useFetch<{ name?: string }>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : null);
  const name = named.data?.name?.trim() || null;
  if (full) return <T size="sm" tone="secondary" wrap>{outcomeLine(p.outcome, p.outcome.kind === 'decision' ? name : null)}</T>;
  return <T size="sm" tone="secondary">{outcomeShort(p.outcome, name)}</T>;
}

/** The empty line of an outcome table: "No … were recorded.", or for failed minutes the rule that they are not available. */
function EmptyLine({ written, none, testId }: { written: boolean; none: string; testId: string }) {
  return <T size="sm" tone="secondary" data-testid={testId}>{written ? none : MINUTES_UNAVAILABLE}</T>;
}

export default function MeetingPage() {
  const { callId = '' } = useParams();
  const navigate = useNavigate();
  const { session } = useSession();
  // Asked again every few seconds while Nova writes the minutes (the first write, or "Write the minutes again").
  const [writing, setWriting] = useState(false);
  const minutes = useFetch<MinutesView>(callId ? minutesUrl(callId) : null, writing ? 3000 : undefined);
  const nowWriting = minutes.data ? minutes.data.rewrite?.writing === true : goneCopy(minutes.failure).writing;
  if (nowWriting !== writing && !minutes.isLoading) setWriting(nowWriting);
  const [rewriteError, setRewriteError] = useState<string | null>(null);
  const writeAgain = useCallback(async () => {
    setRewriteError(null);
    try { await sendJson(rewriteUrl(callId), 'POST'); setWriting(true); minutes.refresh(); } catch (err) {
      setRewriteError(err instanceof Error ? err.message : String(err));
    }
  }, [callId, minutes.refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  const transcript = useMeetingTranscript(minutes.data ? callId : null);
  // The call's proposals this person may see; asked again every few seconds while an answer or a run can still change one.
  const [live, setLive] = useState(false);
  const proposalsFetch = useFetch<unknown>(callId ? proposalsUrl(callId) : null, live ? 3000 : undefined);
  const proposals = useMemo(() => parseProposals(proposalsFetch.data), [proposalsFetch.data]);
  const nowLive = proposalsLive(proposals.map((p) => p.state));
  if (nowLive !== live) setLive(nowLive);
  const [kept, setKept] = useState<ReadonlySet<string>>(new Set());
  const keep = useCallback((key: string) => setKept((k) => new Set([...k, key])), []);
  // "Answer" / "Run it now" on a row brings that proposal to the front of the deck; `n` gives the prompt a new id so a hidden deck shows again.
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const focused = focus ? proposals.find((p) => p.id === focus.id && (waitingOnYou(p) || optionalFor(p))) ?? null : null;
  const head = focused ?? deckQueue(proposals, kept)[0] ?? null;
  const ask = useCallback((p: ProposalView) => {
    setKept((k) => new Set([...k].filter((key) => !key.startsWith(`${p.id}:`))));
    setFocus((f) => ({ id: p.id, n: (f?.n ?? 0) + 1 }));
  }, []);
  const headInitiative = useFetch<{ name?: string }>(head?.outcome.kind === 'decision' && head.outcome.initiativeId ? `/api/graph/projects/${encodeURIComponent(head.outcome.initiativeId)}` : null);
  const refreshProposals = proposalsFetch.refresh;
  const focusN = focused ? focus?.n ?? 0 : 0;
  const proposalAsk = useMemo<ComposerPrompt | null>(() => {
    if (!head || !callId) return null;
    const prompt = proposalPrompt(callId, head, headInitiative.data?.name?.trim() || null, { inCall: false, scope: `meeting-proposal:${callId}`, keep });
    // The page's list is read again after every answer, so the row and the next question follow at once.
    return {
      ...prompt, ...(focusN ? { id: `${prompt.id}:again-${focusN}` } : {}),
      onAnswer: async (a) => { const out = await prompt.onAnswer(a); setFocus(null); refreshProposals(); return out; },
    };
  }, [head, callId, headInitiative.data?.name, keep, refreshProposals, focusN]);
  const me = session?.sub ?? null;
  const mayRunHere = proposals.some((p) => p.executor.userId === me && (p.state === 'consented' || p.state === 'running'));
  // The delete question rides the page's docked composer as a deck prompt; `asked` counts the times it was raised so Delete reopens a hidden one.
  const [asked, setAsked] = useState(0);
  const [answered, setAnswered] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const adapter = useMemo(() => collectionCommandAdapter({ noun: 'meeting' }, {
    id: 'meeting-commands', label: 'Meeting', placeholder: 'Refresh this meeting…',
    setQuery: () => { throw new Error('This page has nothing to search. No changes were made.'); },
    refresh: () => minutes.refresh(),
    scopeNote: 'Refresh reloads the minutes. Deleting the meeting is asked here and never done by a typed command.',
  }), [minutes.refresh]);
  const deletePrompt = useMemo<ComposerPrompt | null>(() => asked > answered && minutes.data ? {
    id: `meeting-delete:${callId}:${asked}`, scope: `meeting-delete:${callId}`, kind: 'choice', eyebrow: 'Delete the meeting', title: minutes.data.callName,
    question: 'Delete this meeting\'s minutes and transcript for everyone who was in the call? Nova will not write them again, and this cannot be undone. Work items created from them stay.',
    options: [{ id: 'delete', label: 'Delete the meeting', emphasis: 'danger' }, { id: 'keep', label: 'Keep it' }],
    onAnswer: async (a) => {
      if (!('optionId' in a) || a.optionId !== 'delete') { setAnswered(asked); return; }
      try { await sendJson(`/api/calls/${encodeURIComponent(callId)}/assistant/minutes`, 'DELETE'); navigate('/iq/meetings'); } catch (err) {
        return { error: `Could not delete this meeting: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  } : null, [asked, answered, callId, minutes.data?.callName, navigate]); // eslint-disable-line react-hooks/exhaustive-deps

  if (minutes.isLoading && !minutes.data) return <LoadingState label="Loading the meeting…" />;
  const m = minutes.data;
  // A delete the inviter just asked for is asked first; the proposal waits behind it.
  const prompts = [...(deletePrompt ? [deletePrompt] : []), ...(proposalAsk ? [proposalAsk] : [])];
  const runner = callId && mayRunHere ? <MeetingTurnRunner afterCall={{ callId, initiativeId: m?.initiativeId ?? null, active: true }} /> : null;
  const detail = detailId ? proposals.find((p) => p.id === detailId) ?? null : null;
  // Portraits come with the meeting's people from the server; anyone else draws initials.
  const people = m?.attendees ?? [];
  const drawer = <ProposalDrawer people={people} meetingInitiativeId={m?.initiativeId ?? null} p={detail} onClose={() => setDetailId(null)} onAsk={(p) => { setDetailId(null); ask(p); }} afterAct={refreshProposals} />;

  // The proposals table: statement · what it does · status · people with their answers · the row's one action. Open ones first.
  const proposalColumns: DataTableColumn<ProposalView>[] = [
    { key: 'statement', header: 'Proposal', truncate: true, wrap: 'two-lines', getFilterText: (p) => p.statement,
      render: (p) => <T size="sm" tone={proposalClosed(p.state) ? 'secondary' : 'primary'}>{p.statement}</T> },
    { key: 'does', header: 'What it does', width: '28%', priority: 2, truncate: true, wrap: 'two-lines', render: (p) => <OutcomeWords p={p} meetingInitiativeId={m?.initiativeId ?? null} /> },
    { key: 'status', header: 'Status', width: '168px', render: (p) => { const pill = proposalPill(p); return <StatusPill tone={pill.tone} label={pill.label} size="sm" data-testid="meeting-proposal-status" />; } },
    { key: 'people', header: 'People', width: '120px', priority: 1, render: (p) => {
      const chips = personChips(p);
      return <Faces faces={facesFor(chips.map((c) => c.name), people)} max={3} label={chips.map((c) => (c.runsIt ? `${c.label} · runs it` : c.label)).join(', ')} />;
    } },
    // The row opens its detail (Answer, Run it now, Undo and Raise it again are there and under "Needs you"): a cell holds one icon control.
    { key: 'act', header: '', width: '56px', align: 'right', render: (p) => (
      <IconButton size="sm" variant="ghost" icon={<ChevronIcon dir="right" />} aria-label={`Open the proposal "${p.statement}"`} title="Open"
        onClick={(e: MouseEvent) => { e.stopPropagation(); setDetailId(p.id); }} data-testid="meeting-proposal-row" data-proposal-id={p.id} data-state={p.state} />
    ) },
  ];
  const proposalTable = (testId: string) => (
    <DataTable data={orderProposals(proposals)} columns={proposalColumns} keyField={(p) => p.id} narrow pageSize={1000}
      onRowClick={(p) => setDetailId(p.id)} data-testid={testId} aria-label="Proposals" />
  );

  // A person a proposal names who was not in the call: no minutes for them, only the proposals that need them.
  if (!m && proposals.length) {
    return (
      <>
        <DetailPage data-testid="meeting-page" title="Proposals from a meeting"
          meta={<MetaLine size="sm" items={['You were named in a proposal from this meeting, or asked to run it', 'Only the proposals that need you are shown']} />}>
          <Stack gap="md" className="pb-6">
            <DetailSection title="Proposals" as="h2" hint={String(proposals.length)} first>{proposalTable('meeting-proposals')}</DetailSection>
          </Stack>
        </DetailPage>
        {drawer}
        {runner}
        {prompts.length > 0 && <CollectionCommandHost key="dialogue" adapter={adapter} prompts={prompts} />}
      </>
    );
  }
  if (!m && minutes.failure && minutes.failure.status !== 404 && minutes.failure.status !== 410) {
    return <EmptyState testId="meeting-error" title="This meeting could not be loaded"
      description={minutes.failure.message} action={<Button size="sm" variant="secondary" data-testid="meeting-retry" onClick={minutes.refresh}>Try again</Button>} />;
  }
  if (!m) {
    // Only someone who was in the call hears that it was deleted or expired; everyone else gets the same neutral sentence.
    const gone = goneCopy(minutes.failure);
    return <EmptyState testId={gone.writing ? 'meeting-writing' : 'meeting-not-found'} title={gone.title} description={gone.description} />;
  }

  const viewer = session?.sub ?? null;
  const written = minutesWritten(m);
  const rewrite = m.rewrite;
  const summary = summaryOf(m);
  const meta = headerMeta(m);
  const quiet = quietMeta(m);
  const decisions = decisionRows(m, proposals);
  const waitingProposals = proposals.filter(waitingOnYou);
  const waitingItems = m.initiativeId ? m.actionItems.filter((i) => actionWaitsOn(i, viewer)) : [];

  const menu: DropdownMenuItem[] = [
    ...(!written && rewrite?.possible && !rewrite.writing && rewrite.attemptsLeft > 0
      ? [{ label: 'Write the minutes again', onSelect: () => { void writeAgain(); }, 'data-testid': 'meeting-rewrite-button' }] : []),
    ...(m.youAreInviter ? [{ label: 'Delete this meeting', danger: true, onSelect: () => setAsked((n) => Math.max(n, answered) + 1), 'data-testid': 'meeting-delete' }] : []),
  ];

  const decisionColumns: DataTableColumn<DecisionRow>[] = [
    { key: 'text', header: 'Decision', truncate: true, wrap: 'two-lines', render: (d) => <T size="sm">{d.text}</T> },
    { key: 'initiative', header: 'Initiative', width: '200px', priority: 2, render: (d) => <InitiativeName id={d.initiativeId} /> },
    { key: 'agreed', header: 'Agreed by', width: '120px', priority: 1, render: (d) => (d.agreedBy.length ? <Faces faces={facesFor(d.agreedBy, people)} max={3} label={`Agreed by ${d.agreedBy.join(', ')}`} /> : null) },
    { key: 'open', header: '', width: '120px', render: (d) => (d.href ? <PortalLink href={d.href} testId="meeting-decision-link">Open</PortalLink> : null) },
  ];
  const actionColumns: DataTableColumn<MinutesActionItem>[] = [
    { key: 'text', header: 'Action', truncate: true, wrap: 'two-lines', render: (i) => <T size="sm">{actionText(i.text)}</T> },
    { key: 'owner', header: 'Owner', width: '200px', render: (i) => (i.ownerName ? <PersonName face={facesFor([i.ownerName], people)[0]!} /> : <T size="sm" tone="secondary">Nobody named</T>) },
    { key: 'status', header: 'Status', width: '168px', render: (i) => { const s = actionStatus(i); return <StatusPill tone={s.tone} label={s.label} size="sm" data-testid="meeting-action-status" />; } },
    { key: 'create', header: '', width: '160px', render: (i) => {
      const href = workItemLink(i);
      if (href) return <PortalLink href={href} testId="meeting-work-item-link">Open work item</PortalLink>;
      return m.initiativeId && canCreateFor(i, viewer) && !i.workItemCreated
        ? <CreateWorkItem callId={callId} index={m.actionItems.indexOf(i)} onDone={minutes.refresh} testId="meeting-create-work-item" /> : null;
    } },
  ];

  return (
    <>
      <DetailPage
        data-testid="meeting-page"
        title={m.callName}
        meta={(
          <Stack gap="xs">
            <MetaLine size="sm" data-testid="meeting-meta" items={[
              meta.when, ...(meta.listened ? [meta.listened] : []),
              <Faces key="people" faces={facesFor(m.attendees.map((a) => a.name), people)} testId="meeting-people" />,
              meta.invitedBy,
            ]} />
            {quiet.length > 0 && <MetaLine size="sm" tone="tertiary" data-testid="meeting-kept" items={quiet} />}
          </Stack>
        )}
        actions={menu.length ? (
          <DropdownMenu align="end" trigger={<MoreIcon size={16} aria-hidden="true" />} triggerLabel="Meeting actions" triggerTestId="meeting-actions" sections={[{ items: menu }]} />
        ) : undefined}
      >
        <Stack gap="md" className="pb-6">
          {(waitingProposals.length > 0 || waitingItems.length > 0) && (
            <DetailSection title="Needs you" as="h2" hint={String(waitingProposals.length + waitingItems.length)} first>
              <Stack gap="xs" data-testid="meeting-needs-you">
                {waitingProposals.map((p) => (
                  <Inline key={p.id} gap="sm" justify="between" wrap={false} data-testid="meeting-needs-row">
                    <T size="sm" truncate className="min-w-0" title={p.statement}>{p.statement}</T>
                    <ProposalRowAction p={p} onAsk={ask} onOpen={() => setDetailId(p.id)} />
                  </Inline>
                ))}
                {waitingItems.map((i) => (
                  <Inline key={`${i.text}|${i.ownerUserId ?? ''}`} gap="sm" justify="between" wrap={false} data-testid="meeting-needs-row">
                    <T size="sm" truncate className="min-w-0" title={actionText(i.text)}>{actionText(i.text)}</T>
                    <CreateWorkItem callId={callId} index={m.actionItems.indexOf(i)} onDone={minutes.refresh} testId="meeting-needs-create" />
                  </Inline>
                ))}
              </Stack>
            </DetailSection>
          )}
          <DetailSection title="Summary" as="h2" first={!waitingProposals.length && !waitingItems.length}>
            <Prose size="sm" data-testid="meeting-summary">
              <p>{summary.lead}</p>
              {summary.points.length > 0 && <ul>{summary.points.map((point, i) => <li key={i}>{point}</li>)}</ul>}
            </Prose>
            {!written && rewrite?.possible && (rewrite.writing || rewrite.attemptsLeft === 0 || rewriteError) && (
              <Inline gap="sm" wrap className="pt-2" data-testid="meeting-rewrite">
                {rewrite.writing && <T size="sm" tone="secondary" data-testid="meeting-rewrite-status">Nova is writing the minutes…</T>}
                {!rewrite.writing && rewrite.attemptsLeft === 0 && <T size="sm" tone="secondary" data-testid="meeting-rewrite-status">Nova has tried to write these minutes five times and will not try again. The transcript is below.</T>}
                {rewriteError && <T size="sm" tone="danger" data-testid="meeting-rewrite-error">{rewriteError}</T>}
              </Inline>
            )}
          </DetailSection>
          <DetailSection title="Decisions" as="h2" {...(written || decisions.length ? { hint: String(decisions.length) } : {})}>
            {decisions.length
              ? <DataTable data={decisions} columns={decisionColumns} keyField={(d) => d.key} narrow pageSize={1000} data-testid="meeting-decisions" aria-label="Decisions" />
              : <EmptyLine written={written} none="No decisions were recorded." testId="meeting-decisions-empty" />}
          </DetailSection>
          <DetailSection title="Action items" as="h2" {...(written ? { hint: String(m.actionItems.length) } : {})}>
            {m.actionItems.length
              ? <DataTable data={m.actionItems} columns={actionColumns} keyField={(i) => `${i.text}|${i.ownerUserId ?? ''}`} narrow pageSize={1000} data-testid="meeting-action-items" aria-label="Action items" />
              : <EmptyLine written={written} none="No action items were recorded." testId="meeting-action-items-empty" />}
          </DetailSection>
          {proposals.length > 0 && (
            <DetailSection title="Proposals" as="h2" hint={String(proposals.length)}>{proposalTable('meeting-proposals')}</DetailSection>
          )}
          <Disclosure variant="plain" summary={<T size="sm" weight="medium">{`Transcript · ${m.lineCount} ${m.lineCount === 1 ? 'line' : 'lines'}`}</T>} data-testid="meeting-transcript">
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
          </Disclosure>
        </Stack>
      </DetailPage>

      {drawer}
      {runner}
      {prompts.length > 0 && <CollectionCommandHost key="dialogue" adapter={adapter} prompts={prompts} />}
    </>
  );
}

/** A "Needs you" row's one action: Run it now (theirs to run), Answer (waiting on the viewer, or optional), else Details. */
function ProposalRowAction({ p, onAsk, onOpen }: { p: ProposalView; onAsk: (p: ProposalView) => void; onOpen: () => void }) {
  const stop = (run: () => void) => (e: MouseEvent) => { e.stopPropagation(); run(); };
  if (p.state === 'consented' && p.you.canRun) return <Button variant="link" size="sm" onClick={stop(() => onAsk(p))} data-testid="meeting-proposal-run">{RUN_NOW}</Button>;
  if (waitingOnYou(p) || optionalFor(p)) return <Button variant="link" size="sm" onClick={stop(() => onAsk(p))} data-testid="meeting-proposal-answer">Answer</Button>;
  return <Button variant="link" size="sm" onClick={stop(onOpen)} data-testid="meeting-proposal-details">Details</Button>;
}

/**
 * A proposal's detail, opened from its row: the lines Nova heard (the server sends them only to people who were in the call), what it
 * does, who it needs and what they answered (objection reasons included), how it ended with its link, and the quiet actions.
 */
function ProposalDrawer({ p, people, meetingInitiativeId, onClose, onAsk, afterAct }: {
  p: ProposalView | null; people: ReadonlyArray<{ name: string; avatarUrl?: string | null }>; meetingInitiativeId: string | null;
  onClose: () => void; onAsk: (p: ProposalView) => void; afterAct: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = (run: (callId: string) => Promise<string | null>) => {
    if (!p?.callId || busy) return;
    setBusy(true); setError(null);
    void run(p.callId).then((why) => { setError(why); setBusy(false); afterAct(); });
  };
  const href = p ? resultHref(p) : null;
  const pill = p ? proposalPill(p) : null;
  const withdraw = p && p.you.response !== null && isAnswerable(p);
  const closing = p ? stateLine(p) : null;
  const lines = p ? [recordsLine(p), p.state === 'open' ? needsLine(p) : null, blockedLine(p), expiryLine(p)].filter((l): l is string => !!l) : [];
  return (
    <Drawer open={!!p} onClose={() => { setError(null); onClose(); }} title={p?.statement ?? ''} subtitle={p ? eyebrowOf(p) : ''} width={440} data-testid="meeting-proposal-detail" closeTestId="meeting-proposal-detail-close">
      {p && pill && (
        <Stack gap="md">
          <Inline gap="sm" align="center" wrap><StatusPill tone={pill.tone} label={pill.label} size="sm" /></Inline>
          <DetailSection title="What it does" first><OutcomeWords p={p} full meetingInitiativeId={meetingInitiativeId} />{lines.map((l, i) => <T key={i} size="sm" tone="secondary" wrap>{l}</T>)}</DetailSection>
          {p.heard.length > 0 && (
            <DetailSection title="What Nova heard">
              <Stack gap="xs" data-testid="meeting-proposal-heard">{p.heard.map((line, i) => <T key={i} size="sm" tone="secondary" wrap>{heardText(line)}</T>)}</Stack>
            </DetailSection>
          )}
          <DetailSection title="People">
            <Stack gap="xs">
              {personChips(p).map((c) => (
                <Inline key={c.userId} gap="sm" align="center" wrap={false}>
                  <PersonName face={facesFor([c.name], people)[0]!} />
                  <T size="sm" tone={c.state === 'objected' ? 'danger' : 'secondary'} wrap>{`${c.label.slice(c.name.length + 3)}${c.runsIt ? ' · runs it' : ''}`}</T>
                </Inline>
              ))}
            </Stack>
          </DetailSection>
          {(closing || href) && (
            <DetailSection title="Result">
              {closing && <T size="sm" tone={p.state === 'failed' ? 'danger' : 'secondary'} wrap data-testid="meeting-proposal-closing">{closing}</T>}
              {href && <PortalLink href={href} testId="meeting-proposal-result-link">{p.outcome.kind === 'decision' ? 'Open the decision' : 'Open what was made'}</PortalLink>}
            </DetailSection>
          )}
          <Inline gap="sm" align="center" wrap>
            {(waitingOnYou(p) || optionalFor(p)) && <Button size="sm" variant="primary" onClick={() => onAsk(p)} data-testid="meeting-proposal-detail-answer">{p.state === 'consented' ? RUN_NOW : 'Answer'}</Button>}
            {p.you.canReopen && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act((c) => { bumpProposalPrompt(c, p.id); return answerProposal(c, p.id, 'reopen'); })} data-testid="meeting-proposal-undo">Undo</Button>}
            {p.you.canRaiseAgain && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act((c) => raiseProposalAgain(c, p.id))} data-testid="meeting-proposal-raise">Raise it again</Button>}
            {withdraw && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => act((c) => { bumpProposalPrompt(c, p.id); return answerProposal(c, p.id, 'withdraw'); })} data-testid="meeting-proposal-withdraw">
                {p.you.response === 'consent' ? 'Withdraw my consent' : 'Withdraw my objection'}
              </Button>
            )}
          </Inline>
          {error && <T size="sm" tone="danger" wrap role="alert">{error}</T>}
        </Stack>
      )}
    </Drawer>
  );
}
