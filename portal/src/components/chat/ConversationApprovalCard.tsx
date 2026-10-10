// The card another member of the conversation sees for someone else's paused `/agent` loop (the
// requester's own loop keeps ConversationAgentCard). Driven by the waiting list the hook polls
// (`GET /agent/waiting`): the question and the step titles, never the goal's source text. An
// eligible approver may decide; a reader sees it read-only. Once the loop moves on the list drops it.

import { useState } from 'react';
import { Card, InlineAlert, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import AgentApprovalPrompt from './AgentApprovalPrompt';
import type { AgentApi, AgentWaitingRun } from './conversationAgent';

export interface ConversationApprovalCardProps {
  item: AgentWaitingRun;
  api: AgentApi;
  /** Called after a decision is saved so the list refreshes at once. */
  onDecided: () => void;
  testIdPrefix?: string;
  bare?: boolean;
}

export default function ConversationApprovalCard({ item, api, onDecided, testIdPrefix = 'conversation-agent', bare = false }: ConversationApprovalCardProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [decided, setDecided] = useState<'approve' | 'reject' | null>(null);
  const decide = (verb: 'approve' | 'reject', reason?: string): void => {
    setBusy(true); setError(null);
    api.decideApproval(item.runId, verb, reason)
      .then(() => { setDecided(verb); onDecided(); })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The decision could not be saved.'))
      .finally(() => setBusy(false));
  };
  const content = (
    <Stack gap="sm">
      <T className="text-sm text-text-primary">{item.summary}</T>
      <Stack gap="none" data-testid={`${testIdPrefix}-waiting-steps`}>
        {item.steps.map(step => <T key={step.id} className="text-xs text-text-muted">{`${step.label}${step.status === 'completed' ? ' (done)' : ''}`}</T>)}
      </Stack>
      {item.approval && !decided && (
        <AgentApprovalPrompt approval={item.approval} role={item.role} requestedBy={item.requestedBy} busy={busy} onDecide={decide} testIdPrefix={`${testIdPrefix}-waiting`} />
      )}
      {decided && <InlineAlert tone="info" data-testid={`${testIdPrefix}-waiting-decided`}>{decided === 'approve' ? 'Approved. The loop continues as you.' : 'Rejected. The loop ended.'}</InlineAlert>}
      {error && <InlineAlert tone="error" data-testid={`${testIdPrefix}-waiting-error`}>{error}</InlineAlert>}
    </Stack>
  );
  return bare ? <Stack gap="none" data-testid={`${testIdPrefix}-waiting-card`}>{content}</Stack>
    : <Card padding="sm" data-testid={`${testIdPrefix}-waiting-card`}>{content}</Card>;
}
