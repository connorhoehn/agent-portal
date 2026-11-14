// What sits under a Nova message in the call chat (docs/meeting-assistant-design.md, decisions 5 and 6).
// The thread draws Nova's message through three slots:
//   assistant-notice  a system line (`renderSystemMessage`): no avatar, author or bubble
//   assistant-reply   an ordinary bubble, with "Asked by <name>" under it (`renderMessageReferences`)
//   assistant-action  a card that stands in for the bubble's text (`renderMessageBody`): detail lines, a status, and Confirm and Decline for the asker only; everyone else
//                     reads it with "Waiting for <name>". A decision updates the same message (the server edits it),
//                     so the card changes in place for every reader.
// The card's first line is its summary sentence (the bubble does not repeat it), then every detail line, then the status and the controls.
// Library components only.

import { useState, type ReactNode } from 'react';
import { Button, Card, Inline, InlineAlert, Stack, StatusPill, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { actionCardView, askedByLine, decideAssistantAction, readAssistantMessage, type ActionDecision, type AssistantAction } from '../../lib/assistantMessages';

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
        {action.tool.name === 'create' && <CallInitiativeLine callId={callId} />}
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

/** A Nova notice as a system line (the message's own sentence); null for any other message, so the thread draws it as usual. */
export function assistantSystemLine(message: { content: string; metadata?: Record<string, unknown> }): ReactNode | null {
  return readAssistantMessage(message.metadata)?.kind === 'assistant-notice'
    ? <T size="xs" tone="secondary" wrap data-testid="assistant-notice-line">{message.content}</T> : null;
}

/** The action card standing in for the bubble's text; null for any other message. */
export function assistantBody(message: { metadata?: Record<string, unknown> }, viewerId: string | null, callId: string | null, decide?: typeof decideAssistantAction): ReactNode | null {
  const read = readAssistantMessage(message.metadata);
  return read?.kind === 'assistant-action' ? <AssistantActionCard action={read} viewerId={viewerId} callId={callId} decide={decide} /> : null;
}
