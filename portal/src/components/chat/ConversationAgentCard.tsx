// The private plan card `/agent` leaves in the requester's own view of a
// conversation: the library's AgentRunCard for progress (live over the run's
// requester-private channel via useFlowRun), the plan with its acceptance
// criteria, then Approve / Discard. After Approve the steps run in order on the
// server; each step that started a flow shows that flow's own card (summary,
// diagram, page or deck) beneath the plan, with that card's own Post / Save.
// A step that fails stops the loop and the card says why. In memory only, like
// the other run cards: a reload loses the card (the run itself stays private).

import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useFlowRun } from '../../hooks/useFlowRun';
import { AgentRunCard } from '@connorhoehnslalom/ui-components/social';
import { Button, Card, InlineAlert, Inline, MarkdownView, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { MAX_POLLS, pollDelayMs } from './conversationSummarize';
import AgentApprovalPrompt from './AgentApprovalPrompt';
import {
  agentRunStatusOf, canDecide, canStop, isSettled, isWaitingApproval, planMarkdown, stepLinkView,
  type AgentApi, type AgentRunStatusBody, type AgentStepStatus,
} from './conversationAgent';

export interface ConversationAgentCardProps {
  runId: string;
  instruction: string;
  requestedBy: string;
  api: AgentApi;
  /** Draws the card of the flow a step started (the surface owns Post / Save). */
  renderStepRun: (step: AgentStepStatus & { ref: NonNullable<AgentStepStatus['ref']> }) => ReactNode;
  onDismiss: () => void;
  testIdPrefix?: string;
  /** Drawn inside the thread's private-message frame (localMessages `body`): no Card, no "only you" notice. */
  bare?: boolean;
}

/** What a creation step made, with the way in: the app's own route, the stored file, or the lobby's name. */
function StepLink({ step, testId }: { step: AgentStepStatus & { link: NonNullable<AgentStepStatus['link']> }; testId: string }) {
  const navigate = useNavigate();
  const view = stepLinkView(step.link);
  const open = (): void => {
    if (!view.href) return;
    if (view.open === 'file') window.open(view.href, '_blank', 'noopener');
    else navigate(view.href);
  };
  return (
    <Stack gap="xs" data-testid={testId}>
      <T className="text-xs text-text-muted">{`${view.noun} created`}</T>
      <Inline gap="sm" align="center">
        {view.open === 'none' ? <T className="text-sm font-medium text-text-primary">{view.label}</T>
          : <Button variant="secondary" size="sm" onClick={open} data-testid={`${testId}-open`}>{`Open ${view.label}`}</Button>}
      </Inline>
      {view.note && <T className="text-xs text-text-muted">{view.note}</T>}
    </Stack>
  );
}

const ENDED: ReadonlySet<string> = new Set(['done', 'stopped', 'discarded', 'failed']);
/** A loop paused at an approval step is waiting on a person, not on the server: the card stops following until they decide. */
const PAUSED = 'waiting-approval';

/**
 * Follows one run. Remounted (new `round`) after Approve: round 0 ends at the plan awaiting a
 * decision, later rounds follow the approved loop to its end.
 */
function FollowedAgentCard({ round, runId, instruction, requestedBy, api, renderStepRun, busy, actionError, decide, decideApproval, onDismiss, testIdPrefix, bare }:
  ConversationAgentCardProps & { round: number; busy: boolean; actionError: string | null; decide: (verb: 'approve' | 'discard') => void; decideApproval: (verb: 'approve' | 'reject', reason?: string) => void; testIdPrefix: string; bare: boolean }) {
  const flow = useFlowRun<AgentRunStatusBody>(runId, (id) => api.status(id), {
    isFinished: s => (round === 0 ? isSettled(s) : ENDED.has(s.stage) || s.stage === PAUSED), delayMs: pollDelayMs, maxPolls: MAX_POLLS,
  });
  const status = flow.run;
  const error = actionError ?? flow.error ?? (flow.timedOut ? 'The plan is taking too long. Dismiss it and try again.' : null);
  const childSteps = (status?.steps ?? []).filter((s): s is AgentStepStatus & { ref: NonNullable<AgentStepStatus['ref']> } => !!s.ref);
  const linkSteps = (status?.steps ?? []).filter((s): s is AgentStepStatus & { link: NonNullable<AgentStepStatus['link']> } => !!s.link);
  const content = (
    <Stack gap="sm">
      {!bare && <InlineAlert tone="info">Only you can see this. Nothing runs until you approve the plan.</InlineAlert>}
      <AgentRunCard runId={runId} instruction={instruction} agentName="Nova" command="/agent" requestedBy={requestedBy}
        {...(status ? { status: agentRunStatusOf(status) } : {})} defaultExpanded data-testid={`${testIdPrefix}-run`} />
      {error && <InlineAlert tone="error" data-testid={`${testIdPrefix}-error`}>{error}</InlineAlert>}
      {status?.plan && <MarkdownView markdown={planMarkdown(status.plan)} scale="sm" data-testid={`${testIdPrefix}-plan`} />}
      {status && status.stage === 'stopped' && status.error && (
        <InlineAlert tone="error" data-testid={`${testIdPrefix}-stopped`}>{status.error}</InlineAlert>
      )}
      {status && isWaitingApproval(status) && (
        <AgentApprovalPrompt approval={status.approval!} role="requester" requestedBy={requestedBy} busy={busy} onDecide={decideApproval} testIdPrefix={testIdPrefix} />
      )}
      <Inline gap="sm" align="center">
        {status && canDecide(status) && (
          <>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => decide('approve')} data-testid={`${testIdPrefix}-approve`}>Approve</Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => decide('discard')} data-testid={`${testIdPrefix}-discard`}>Discard</Button>
          </>
        )}
        {status && canStop(status) && (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => decide('discard')} data-testid={`${testIdPrefix}-stop`}>Stop after this step</Button>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss} data-testid={`${testIdPrefix}-dismiss`}>Dismiss</Button>
      </Inline>
      {linkSteps.map(step => <StepLink key={step.id} step={step} testId={`${testIdPrefix}-link-${step.id}`} />)}
      {childSteps.map(step => (
        <Stack key={step.id} gap="xs" data-testid={`${testIdPrefix}-step-${step.id}`}>{renderStepRun(step)}</Stack>
      ))}
    </Stack>
  );
  return bare ? <Stack gap="none" data-testid={`${testIdPrefix}-card`}>{content}</Stack>
    : <Card padding="sm" data-testid={`${testIdPrefix}-card`}>{content}</Card>;
}

export default function ConversationAgentCard(props: ConversationAgentCardProps) {
  const { runId, api, onDismiss, testIdPrefix = 'conversation-agent', bare = false } = props;
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const decide = (verb: 'approve' | 'discard'): void => {
    setBusy(true); setActionError(null);
    api[verb](runId)
      .then((out) => { if (verb === 'discard' && out.stage === 'discarded' && round === 0) onDismiss(); else setRound(n => n + 1); })
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : 'The decision could not be saved.'))
      .finally(() => setBusy(false));
  };
  // A decision on the paused loop: remount to follow it again (Approve continues, Reject ends with its reason).
  const decideApproval = (verb: 'approve' | 'reject', reason?: string): void => {
    setBusy(true); setActionError(null);
    api.decideApproval(runId, verb, reason)
      .then(() => setRound(n => n + 1))
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : 'The decision could not be saved.'))
      .finally(() => setBusy(false));
  };
  return <FollowedAgentCard key={round} {...props} round={round} busy={busy} actionError={actionError} decide={decide} decideApproval={decideApproval} testIdPrefix={testIdPrefix} bare={bare} />;
}
