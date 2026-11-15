// What sits under a Nova message in the call chat (docs/meeting-assistant-design.md, decisions 5 and 6).
// Every Nova message reads as one voice: the thread marks it (`isAssistantChatMessage` as ChatPanel's `isAssistantMessage`), so its
// row wears Nova's mark and the accent author ink, its text sits on the accent-tinted surface, and its cards use `Card tone="assistant"`.
// The thread draws Nova's message through these slots:
//   assistant-notice  a state notice (paused, resumed, extended, left...) is a system line (`renderSystemMessage`): one compact row
//                     under Nova's mark in a muted tinted pill. The minutes notice (it carries counts) is a card instead (below).
//   assistant-minutes the minutes notice as a card (`renderMessageBody`): "Meeting minutes", the summary's first lines, the counts
//                     of decisions, action items and proposals, and the link to the meeting page.
//   assistant-reply   the tinted bubble, with "Asked by <name>" under it (`renderMessageReferences`)
//   assistant-action  a card that stands in for the bubble's text (`renderMessageBody`): detail lines, a status, and Confirm and Decline for the asker only; everyone else
//                     reads it with "Waiting for <name>". A decision updates the same message (the server edits it),
//                     so the card changes in place for every reader.
// The card's first line is its summary sentence (the bubble does not repeat it), then every detail line, then the status and the controls.
//   assistant-proposal  a read-only card (docs/meeting-consent-design.md): "Proposal", the statement (the message's text), what it will
//                     do, who it still needs, one chip per involved person with their answer, and how it ended. It has no buttons:
//                     answers are given in the deck above the footer row. Names and reasons come from the proposals route, so a reader
//                     who may not see the proposal sees the statement and its state only.
// Library components only.

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, Card, Chip, Inline, InlineAlert, Link, Stack, StatusPill, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { meetingHref } from '../../pages/meetings/meetingsModel';
import { answerProposal, raiseProposalAgain, useMeetingAssistant } from '../../lib/meetingAssistant';
import {
  blockedLine, expiryLine, eyebrowOf, heardText, isAnswerable, needsLine, optionalFor, outcomeLine, personChips, recordsLine, resultHref, stateLine, waitingOnYou,
  type ProposalState, type ProposalView,
} from '../../lib/meetingProposals';
import { setProposalDeckHidden } from '../../lib/proposalDeckState';
import { actionCardView, askedByLine, minutesCountLabels, namesNoInitiative, decideAssistantAction, readAssistantMessage, type ActionDecision, type AssistantAction, type AssistantProposalCard, type MinutesCounts } from '../../lib/assistantMessages';

export interface AssistantActionCardProps {
  action: AssistantAction;
  viewerId: string | null;
  callId: string | null;
  /** Injected for tests; the app posts to the BFF. */
  decide?: typeof decideAssistantAction;
}

/** "Initiative: <name>" for a create: the call's initiative, where the work item will land. Shown only once the name is known. */
function CallInitiativeLine({ callId }: { callId: string | null }) {
  const nova = useMeetingAssistant(callId);
  const id = nova.view.initiativeId;
  const named = useFetch<{ name?: string }>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : null);
  const name = named.data?.name?.trim();
  return name ? <T size="xs" tone="secondary" wrap data-testid="assistant-action-initiative">{`Initiative: ${name}`}</T> : null;
}

export function AssistantActionCard({ action, viewerId, callId, decide = decideAssistantAction }: AssistantActionCardProps) {
  const [busy, setBusy] = useState<ActionDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const view = actionCardView(action, viewerId);
  const choose = (decision: ActionDecision): void => {
    if (!callId || busy) return;
    setBusy(decision); setError(null);
    decide(callId, action.actionId, decision)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The decision could not be saved.'))
      .finally(() => setBusy(null));
  };
  return (
    <Card tone="assistant" padding="sm" className="mt-1 max-w-md" data-testid="assistant-action-card" data-status={action.status}>
      <Stack gap="sm">
        <T size="sm" weight="medium" wrap data-testid="assistant-action-summary">{action.summary}</T>
        {action.detail.length > 0 && (
          <Stack gap="none" data-testid="assistant-action-detail">
            {action.detail.map((line, index) => <T key={index} size="xs" tone="secondary" wrap>{line}</T>)}
          </Stack>
        )}
        {namesNoInitiative(action) && <CallInitiativeLine callId={callId} />}
        <Inline gap="sm" align="center" wrap>
          <StatusPill tone={view.tone} label={view.statusLabel} size="sm" data-testid="assistant-action-status" />
          {view.waitingNote && <T size="xs" tone="tertiary" data-testid="assistant-action-waiting-note">{view.waitingNote}</T>}
        </Inline>
        {action.resultText && <T size="xs" tone="secondary" wrap data-testid="assistant-action-result">{action.resultText}</T>}
        {view.canDecide && (
          <Inline gap="sm" align="center">
            <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => choose('confirm')} data-testid="assistant-action-confirm">
              {busy === 'confirm' ? 'Confirming…' : 'Confirm'}
            </Button>
            <Button variant="secondary" size="sm" disabled={busy !== null} onClick={() => choose('decline')} data-testid="assistant-action-decline">
              {busy === 'decline' ? 'Declining…' : 'Decline'}
            </Button>
          </Inline>
        )}
        {error && <InlineAlert tone="error" data-testid="assistant-action-error">{error}</InlineAlert>}
      </Stack>
    </Card>
  );
}

const PROPOSAL_PILL: Record<ProposalState, [string, 'info' | 'success' | 'warning' | 'error' | 'neutral' | 'pending']> = {
  open: ['Waiting for consent', 'pending'], consented: ['Consented', 'info'], running: ['Running', 'info'], done: ['Done', 'success'],
  failed: ['Failed', 'error'], objected: ['Objected', 'warning'], dismissed: ['Not a decision', 'neutral'], expired: ['Expired', 'neutral'],
};

/** The initiative's name for "Record as a decision on <name>"; null until known. */
function useInitiativeName(id: string | null): string | null {
  const named = useFetch<{ name?: string }>(id ? `/api/graph/projects/${encodeURIComponent(id)}` : null);
  return named.data?.name?.trim() || null;
}

export function AssistantProposalCardView({ card, statement, callId }: { card: AssistantProposalCard; statement: string; callId: string | null }) {
  const nova = useMeetingAssistant(callId);
  const view = nova.proposals.find((p) => p.id === card.proposalId) ?? null;
  // The message's state moves with every change; the route's view may lag a poll behind, so the pill follows the message.
  return <ProposalCard proposalId={card.proposalId} state={card.state} statement={statement} view={view} surface="assistant" />;
}

/**
 * One proposal: who raised it ("Nova heard a decision" with the lines it heard, or "Asked by Dana"), the statement, what will be
 * written, who it needs, whether a decision will be recorded as decided or waiting, a chip per person and how it ended, with a link to
 * what was made once done. The call chat's card and the meeting page's Proposals section draw this same card. Answers are given in a
 * deck; the card holds only quiet actions: Answer (opens the deck in the call), withdrawing your answer, Undo of your dismissal, and
 * Raise it again on a blocked or failed one.
 */
export function ProposalCard({ proposalId, state, statement, view, surface = 'default' }: {
  proposalId: string; state: ProposalState; statement: string; view: ProposalView | null;
  /** `assistant` in the call chat, where it is one of Nova's messages; the meeting page lists it on the plain surface. */
  surface?: 'default' | 'assistant';
}) {
  const navigate = useNavigate();
  const initiativeName = useInitiativeName(view?.outcome.kind === 'decision' ? view.outcome.initiativeId : null);
  const [label, tone] = PROPOSAL_PILL[state];
  const live = view ? { ...view, state } : null;
  const needs = live && state === 'open' ? needsLine(live) : null;
  const blocked = live ? blockedLine(live) : null;
  const closing = live ? stateLine(live) : null;
  const href = live ? resultHref(live) : null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const callId = view?.callId ?? null;
  const act = (run: (id: string) => Promise<string | null>) => {
    if (!callId || busy) return;
    setBusy(true); setError(null);
    void run(callId).then((why) => { setError(why); setBusy(false); });
  };
  // Answer opens the deck in the call, where it is asked; it is offered only when the deck has a question for this person.
  const answer = live && surface === 'assistant' && callId && (waitingOnYou(live) || optionalFor(live));
  const withdraw = live && callId && live.you.response !== null && isAnswerable(live);
  return (
    <Card tone={surface} padding="sm" className="mt-1 max-w-md" data-testid="assistant-proposal-card" data-proposal-id={proposalId} data-state={state}>
      <Stack gap="sm">
        <Inline gap="sm" align="center" wrap>
          <T size="xs" weight="medium" tone="secondary" data-testid="assistant-proposal-eyebrow">{live ? eyebrowOf(live) : 'Proposal'}</T>
          <StatusPill tone={tone} label={label} size="sm" data-testid="assistant-proposal-status" />
        </Inline>
        <T size="sm" weight="medium" wrap data-testid="assistant-proposal-statement">{statement}</T>
        {live && live.heard.length > 0 && (
          <Stack gap="none" data-testid="assistant-proposal-heard">
            {live.heard.map((line, i) => <T key={i} size="xs" tone="tertiary" wrap>{heardText(line)}</T>)}
          </Stack>
        )}
        {live && <T size="xs" tone="secondary" wrap data-testid="assistant-proposal-outcome">{outcomeLine(live.outcome, initiativeName)}</T>}
        {live && recordsLine(live) && <T size="xs" tone="secondary" wrap data-testid="assistant-proposal-records">{recordsLine(live)}</T>}
        {needs && <T size="xs" tone="tertiary" wrap data-testid="assistant-proposal-needs">{needs}</T>}
        {blocked && <T size="xs" tone="tertiary" wrap data-testid="assistant-proposal-blocked">{blocked}</T>}
        {live && expiryLine(live) && <T size="xs" tone="tertiary" wrap data-testid="assistant-proposal-expiry">{expiryLine(live)}</T>}
        {live && (
          <Inline gap="xs" align="center" wrap data-testid="assistant-proposal-people">
            {personChips(live).map((chip) => (
              <Chip key={chip.userId} size="xs" tone={chip.tone} dot="static" data-testid="assistant-proposal-person">
                {chip.runsIt ? `${chip.label} · runs it` : chip.label}
              </Chip>
            ))}
          </Inline>
        )}
        {closing && <T size="xs" tone={state === 'failed' ? 'danger' : 'secondary'} wrap data-testid="assistant-proposal-closing">{closing}</T>}
        {href && (
          <Link href={href} data-testid="assistant-proposal-result-link" onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}>
            {live?.outcome.kind === 'decision' ? 'Open the decision' : 'Open what was made'}
          </Link>
        )}
        {live && (answer || withdraw || live.you.canReopen || live.you.canRaiseAgain) && (
          <Inline gap="sm" align="center" wrap data-testid="assistant-proposal-actions">
            {answer && (
              <Button variant="link" size="sm" onClick={() => setProposalDeckHidden(callId, false)} data-testid="assistant-proposal-answer">Answer</Button>
            )}
            {live.you.canReopen && (
              <Button variant="link" size="sm" disabled={busy} onClick={() => act((c) => answerProposal(c, live.id, 'reopen'))} data-testid="assistant-proposal-undo">Undo</Button>
            )}
            {live.you.canRaiseAgain && (
              <Button variant="link" size="sm" disabled={busy} onClick={() => act((c) => raiseProposalAgain(c, live.id))} data-testid="assistant-proposal-raise">Raise it again</Button>
            )}
            {withdraw && (
              <Button variant="link" size="sm" disabled={busy} onClick={() => act((c) => answerProposal(c, live.id, 'withdraw'))} data-testid="assistant-proposal-withdraw">
                {live.you.response === 'consent' ? 'Withdraw my consent' : 'Withdraw my objection'}
              </Button>
            )}
          </Inline>
        )}
        {error && <T size="xs" tone="danger" wrap role="alert" data-testid="assistant-proposal-error">{error}</T>}
      </Stack>
    </Card>
  );
}

export interface AssistantMessageExtrasProps {
  metadata: Record<string, unknown> | undefined;
  viewerId: string | null;
  callId: string | null;
  decide?: typeof decideAssistantAction;
}

/** The part under a Nova reply ("Asked by <name>"); null for any other message. */
export function AssistantMessageExtras({ metadata }: Pick<AssistantMessageExtrasProps, 'metadata'>) {
  const message = readAssistantMessage(metadata);
  if (message?.kind !== 'assistant-reply') return null;
  return <T size="xs" tone="tertiary" data-testid="assistant-reply-asked-by">{askedByLine(message)}</T>;
}

/**
 * "Open the meeting page". A closing notice names its meeting in the message's metadata, never in its text: the link is built
 * from that field (the portal's own meeting path), so nothing in the chat becomes a link because of what a message says.
 */
function MeetingLink({ callId }: { callId: string }) {
  const navigate = useNavigate();
  const href = meetingHref(callId);
  return (
    <Link href={href} data-testid="assistant-notice-meeting-link" onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}>
      Open the meeting page
    </Link>
  );
}

/** A state notice's line inside the thread's tinted pill, with the meeting link when it carries one. */
function NoticeLine({ content, callId }: { content: string; callId: string | undefined }) {
  return (
    <Inline gap="sm" align="center" wrap>
      <T size="xs" tone="secondary" wrap data-testid="assistant-notice-line">{content}</T>
      {callId && <MeetingLink callId={callId} />}
    </Inline>
  );
}

/**
 * The minutes notice as a card: the title, the summary's first lines (the message's text, clamped to three lines with an
 * ellipsis), the counts the server attached, and the link to the meeting page. The counts name decisions consented through
 * the call's proposals too.
 */
export function MinutesCard({ summary, counts, callId }: { summary: string; counts: MinutesCounts; callId: string | undefined }) {
  const labels = minutesCountLabels(counts);
  return (
    <Card tone="assistant" padding="sm" className="mt-1 max-w-md" data-testid="assistant-minutes-card">
      <Stack gap="sm">
        <T size="sm" weight="semibold" data-testid="assistant-minutes-title">Meeting minutes</T>
        {summary && <T size="sm" tone="secondary" clamp={3} data-testid="assistant-minutes-summary">{summary}</T>}
        <Inline gap="xs" align="center" wrap data-testid="assistant-minutes-counts">
          <Chip size="xs" tone="neutral" data-testid="assistant-minutes-decisions">{labels.decisions}</Chip>
          <Chip size="xs" tone="neutral" data-testid="assistant-minutes-action-items">{labels.actionItems}</Chip>
          <Chip size="xs" tone="neutral" data-testid="assistant-minutes-proposals">{labels.proposals}</Chip>
        </Inline>
        {callId && <MeetingLink callId={callId} />}
      </Stack>
    </Card>
  );
}

/** A Nova state notice as a system line; null for any other message (and for the minutes notice, which is a card), so the thread draws it as usual. */
export function assistantSystemLine(message: { content: string; metadata?: Record<string, unknown> }): ReactNode | null {
  const read = readAssistantMessage(message.metadata);
  return read?.kind === 'assistant-notice' && !read.minutes ? <NoticeLine content={message.content} callId={read.meetingCallId} /> : null;
}

/** The action, proposal or minutes card standing in for the bubble's text; null for any other message. */
export function assistantBody(message: { content?: string; metadata?: Record<string, unknown> }, viewerId: string | null, callId: string | null, decide?: typeof decideAssistantAction): ReactNode | null {
  const read = readAssistantMessage(message.metadata);
  if (read?.kind === 'assistant-notice' && read.minutes) return <MinutesCard summary={message.content ?? ''} counts={read.minutes} callId={read.meetingCallId} />;
  if (read?.kind === 'assistant-proposal') return <AssistantProposalCardView card={read} statement={message.content ?? ''} callId={callId} />;
  return read?.kind === 'assistant-action' ? <AssistantActionCard action={read} viewerId={viewerId} callId={callId} decide={decide} /> : null;
}
