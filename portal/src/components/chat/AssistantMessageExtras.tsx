// What sits under a Nova message in the call chat (docs/meeting-assistant-design.md, decisions 5 and 6).
// The thread draws Nova's message through three slots:
//   assistant-notice  a system line (`renderSystemMessage`): no avatar, author or bubble
//   assistant-reply   an ordinary bubble, with "Asked by <name>" under it (`renderMessageReferences`)
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
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { needsLine, outcomeLine, personChips, stateLine, type ProposalState } from '../../lib/meetingProposals';
import { actionCardView, askedByLine, namesNoInitiative, decideAssistantAction, readAssistantMessage, type ActionDecision, type AssistantAction, type AssistantProposalCard } from '../../lib/assistantMessages';

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
    <Card padding="sm" className="mt-1 max-w-md" data-testid="assistant-action-card" data-status={action.status}>
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
  const navigate = useNavigate();
  const nova = useMeetingAssistant(callId);
  const view = nova.proposals.find((p) => p.id === card.proposalId) ?? null;
  // The message's state moves with every change; the route's view may lag a poll behind, so the pill follows the message.
  const state = card.state;
  const initiativeName = useInitiativeName(view?.outcome.kind === 'decision' ? view.outcome.initiativeId : null);
  const [label, tone] = PROPOSAL_PILL[state];
  const live = view ? { ...view, state } : null;
  const needs = live && (state === 'open' || state === 'objected') ? needsLine(live) : null;
  const closing = live ? stateLine(live) : null;
  const href = live?.state === 'done' ? live.result?.href ?? null : null;
  return (
    <Card padding="sm" className="mt-1 max-w-md" data-testid="assistant-proposal-card" data-proposal-id={card.proposalId} data-state={state}>
      <Stack gap="sm">
        <Inline gap="sm" align="center" wrap>
          <T size="xs" weight="medium" tone="secondary">Proposal</T>
          <StatusPill tone={tone} label={label} size="sm" data-testid="assistant-proposal-status" />
        </Inline>
        <T size="sm" weight="medium" wrap data-testid="assistant-proposal-statement">{statement}</T>
        {live && <T size="xs" tone="secondary" wrap data-testid="assistant-proposal-outcome">{outcomeLine(live.outcome, initiativeName)}</T>}
        {needs && <T size="xs" tone="tertiary" wrap data-testid="assistant-proposal-needs">{needs}</T>}
        {live && (
          <Inline gap="xs" align="center" wrap data-testid="assistant-proposal-people">
            {personChips(live).map((chip) => (
              <Chip key={chip.userId} size="xs" tone={chip.tone} dot="static" data-testid="assistant-proposal-person" data-person={chip.userId} data-person-state={chip.state}>
                {chip.runsIt ? `${chip.label} · runs it` : chip.label}
              </Chip>
            ))}
          </Inline>
        )}
        {closing && <T size="xs" tone={state === 'failed' ? 'danger' : 'secondary'} wrap data-testid="assistant-proposal-closing">{closing}</T>}
        {href && (
          <Link href={href} data-testid="assistant-proposal-result-link" onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}>
            Open the record
          </Link>
        )}
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
 * A closing notice names its meeting in the message's metadata, never in its text: the link under the sentence is built
 * from that field (the portal's own meeting path), so nothing in the chat becomes a link because of what a message says.
 */
function NoticeLine({ content, callId }: { content: string; callId: string | undefined }) {
  const navigate = useNavigate();
  const href = callId ? meetingHref(callId) : null;
  return (
    <Stack gap="xs">
      <T size="xs" tone="secondary" wrap data-testid="assistant-notice-line">{content}</T>
      {href && (
        <Link href={href} data-testid="assistant-notice-meeting-link" onClick={(e) => { if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); navigate(href); } }}>
          Open the meeting page
        </Link>
      )}
    </Stack>
  );
}

/** A Nova notice as a system line (the message's own sentence, and the meeting link when it carries one); null for any other message, so the thread draws it as usual. */
export function assistantSystemLine(message: { content: string; metadata?: Record<string, unknown> }): ReactNode | null {
  const read = readAssistantMessage(message.metadata);
  return read?.kind === 'assistant-notice' ? <NoticeLine content={message.content} callId={read.meetingCallId} /> : null;
}

/** The action or proposal card standing in for the bubble's text; null for any other message. */
export function assistantBody(message: { content?: string; metadata?: Record<string, unknown> }, viewerId: string | null, callId: string | null, decide?: typeof decideAssistantAction): ReactNode | null {
  const read = readAssistantMessage(message.metadata);
  if (read?.kind === 'assistant-proposal') return <AssistantProposalCardView card={read} statement={message.content ?? ''} callId={callId} />;
  return read?.kind === 'assistant-action' ? <AssistantActionCard action={read} viewerId={viewerId} callId={callId} decide={decide} /> : null;
}
