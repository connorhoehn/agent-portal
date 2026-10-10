// The private card a `/summarize` leaves in the requester's own view of a
// conversation: the library's AgentRunCard for progress (live over the run's
// requester-private channel via useFlowRun), then the summary to review, with
// "Post to conversation" as the one explicit act that shares it. Nothing is
// sent until that button is pressed; Dismiss drops the card. In memory only,
// like the reference's private run card — a reload loses it.
//
// Shared by Social (SocialSummaryCard) and the tenant conversations / huddles
// (useConversationSummarize); `api` names the mount, `testIdPrefix` the surface.

import { useState } from 'react';
import { useFlowRun } from '../../hooks/useFlowRun';
import { AgentRunCard } from '@connorhoehnslalom/ui-components/social';
import { Button, Card, InlineAlert, Inline, MarkdownView, Stack } from '@connorhoehnslalom/ui-components/shared';
import {
  MAX_POLLS, agentRunStatusOf, canPost, isTerminal, pollDelayMs, reviewMarkdown,
  type PostedSummary, type SummarizeApi, type SummarizeRunStatus,
} from './conversationSummarize';

export interface ConversationSummaryCardProps {
  runId: string;
  instruction: string;
  requestedBy: string;
  api: SummarizeApi;
  /** Sends the server-built message into the conversation. Rejects when delivery fails. */
  onPost: (message: PostedSummary) => Promise<void>;
  onDismiss: () => void;
  testIdPrefix?: string;
  /** Drawn inside the thread's private-message frame (localMessages `body`): no Card, no "only you" notice. */
  bare?: boolean;
}

export default function ConversationSummaryCard({ runId, instruction, requestedBy, api, onPost, onDismiss, testIdPrefix = 'conversation-summary', bare = false }: ConversationSummaryCardProps) {
  const [postError, setPostError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const flow = useFlowRun<SummarizeRunStatus>(runId, (id) => api.status(id), {
    isFinished: isTerminal, delayMs: pollDelayMs, maxPolls: MAX_POLLS,
  });
  const status = flow.run;
  const error = postError ?? flow.error
    ?? (flow.timedOut ? 'The summary is taking too long. Dismiss it and try again.' : null);

  const post = async (): Promise<void> => {
    setPosting(true); setPostError(null);
    try {
      await onPost(await api.requestPost(runId));
      setPosted(true); onDismiss();
    } catch (cause) {
      setPostError(cause instanceof Error ? cause.message : 'The summary could not be posted.');
    } finally { setPosting(false); }
  };

  const content = (
      <Stack gap="sm">
        {!bare && <InlineAlert tone="info">Only you can see this. Post it when it is ready.</InlineAlert>}
        <AgentRunCard runId={runId} instruction={instruction} agentName="Nova" command="/summarize" requestedBy={requestedBy}
          {...(status ? { status: agentRunStatusOf(status) } : {})} defaultExpanded data-testid={`${testIdPrefix}-run`} />
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
        {status?.result && status.result.messageCount > 0 && (
          <MarkdownView markdown={reviewMarkdown(status.result)} scale="sm" data-testid={`${testIdPrefix}-result`} />
        )}
        <Inline gap="sm" align="center">
          {status && canPost(status) && !posted && (
            <Button variant="primary" size="sm" disabled={posting} onClick={() => { void post(); }} data-testid={`${testIdPrefix}-post`}>
              Post to conversation
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={posting} onClick={onDismiss} data-testid={`${testIdPrefix}-dismiss`}>Dismiss</Button>
        </Inline>
      </Stack>
  );
  return bare ? <Stack gap="none" data-testid={`${testIdPrefix}-card`}>{content}</Stack>
    : <Card padding="sm" data-testid={`${testIdPrefix}-card`}>{content}</Card>;
}
