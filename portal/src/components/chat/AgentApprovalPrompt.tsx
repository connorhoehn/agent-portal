// The question an `/agent` loop asks at an `approval` step (docs/agentic-flows-migration.md slice 10,
// HITL). One drawing for the requester's own card and for another member's card: the requester and
// an eligible second approver get Approve / Reject (with an optional reason that lands on the loop's
// card); a reader sees the same question read-only and is told who can decide.

import { useState } from 'react';
import { Button, InlineAlert, Inline, Input, Stack, T } from '@connorhoehn/ui-components/shared';
import { approvalExpiryNote, canDecideApproval, type AgentApproval, type AgentApprovalRole } from './conversationAgent';

export interface AgentApprovalPromptProps {
  approval: AgentApproval;
  role: AgentApprovalRole;
  /** Who started the loop, for the read-only and approver wording. */
  requestedBy: string;
  busy: boolean;
  onDecide: (verb: 'approve' | 'reject', reason?: string) => void;
  testIdPrefix: string;
}

export default function AgentApprovalPrompt({ approval, role, requestedBy, busy, onDecide, testIdPrefix }: AgentApprovalPromptProps) {
  const [reason, setReason] = useState('');
  const decide = canDecideApproval(role);
  return (
    <Stack gap="xs" data-testid={`${testIdPrefix}-approval`}>
      <T className="text-xs text-text-muted">{role === 'requester' ? 'The loop is paused for your decision' : `${requestedBy}'s loop is paused for a decision`}</T>
      <T className="text-sm font-medium text-text-primary" data-testid={`${testIdPrefix}-approval-question`}>{approval.question}</T>
      <T className="text-xs text-text-muted">{approvalExpiryNote(approval)}</T>
      {decide ? (
        <Stack gap="xs">
          <Input size="sm" value={reason} maxLength={200} placeholder="Reason (optional, shown if you reject)" aria-label="Reason"
            onChange={event => setReason(event.target.value)} data-testid={`${testIdPrefix}-approval-reason`} />
          <Inline gap="sm" align="center">
            <Button variant="primary" size="sm" disabled={busy} onClick={() => onDecide('approve')} data-testid={`${testIdPrefix}-approval-approve`}>Approve</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => onDecide('reject', reason.trim() || undefined)} data-testid={`${testIdPrefix}-approval-reject`}>Reject</Button>
          </Inline>
          {role === 'approver' && <T className="text-xs text-text-muted">If you approve, the next steps run as you.</T>}
        </Stack>
      ) : (
        <InlineAlert tone="info" data-testid={`${testIdPrefix}-approval-readonly`}>
          {`Read only. ${requestedBy} or an approver for this conversation decides.`}
        </InlineAlert>
      )}
    </Stack>
  );
}
