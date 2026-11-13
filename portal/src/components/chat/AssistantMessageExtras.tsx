// What sits under a Nova message in the call chat (docs/meeting-assistant-design.md, decisions 5 and 6).
// The thread draws Nova's message as an ordinary bubble (author "Nova", the sentence as its text); this adds the
// kind's own part, through the thread's `renderMessageReferences` slot:
//   assistant-notice  a quiet "Notice" line
//   assistant-reply   "Asked by <name>"
//   assistant-action  a card: detail lines, a status, and Confirm and Decline for the asker only; everyone else
//                     reads it with "Waiting for <name>". A decision updates the same message (the server edits it),
//                     so the card changes in place for every reader.
// Library components only.

import { useState } from 'react';
import { Button, Card, Inline, InlineAlert, Stack, StatusPill, T } from '@connorhoehn/ui-components/shared';
import { actionCardView, askedByLine, decideAssistantAction, readAssistantMessage, type ActionDecision, type AssistantAction } from '../../lib/assistantMessages';

export interface AssistantActionCardProps {
  action: AssistantAction;
  viewerId: string | null;
  callId: string | null;
  /** Injected for tests; the app posts to the BFF. */
  decide?: typeof decideAssistantAction;
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
        {action.detail.length > 0 && (
          <Stack gap="none" data-testid="assistant-action-detail">
            {action.detail.map((line, index) => <T key={index} size="xs" tone="secondary" wrap>{line}</T>)}
          </Stack>
        )}
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

/** The kind's own part under a Nova message; null for any other message. */
export function AssistantMessageExtras({ metadata, viewerId, callId, decide }: AssistantMessageExtrasProps) {
  const message = readAssistantMessage(metadata);
  if (!message) return null;
  if (message.kind === 'assistant-notice') return <T size="xs" tone="tertiary" data-testid="assistant-notice-note">Notice from Nova</T>;
  if (message.kind === 'assistant-reply') return <T size="xs" tone="tertiary" data-testid="assistant-reply-asked-by">{askedByLine(message)}</T>;
  return <AssistantActionCard action={message} viewerId={viewerId} callId={callId} decide={decide} />;
}
