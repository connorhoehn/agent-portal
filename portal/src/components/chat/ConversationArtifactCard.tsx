// The private card a `/diagram` or `/doc` leaves in the requester's own view of a
// conversation: the library's AgentRunCard for progress (live over the run's
// requester-private channel via useFlowRun), then the result to review — a
// diagram drawn with the library's NodeGraph, or the page draft in MarkdownView —
// with the quotes it rests on. "Post to conversation" (diagram) and "Save as
// document" (doc) are the only acts that share anything; Dismiss drops the card.
// In memory only, like the /summarize card.
//
// The surface supplies `send`: how the server-built message reaches the
// conversation (gateway chat, the huddle's send route, or — in Social — an
// attachment upload first). Save makes the page through the tenant's existing
// route (conversationArtifactSave.ts) before the server claims it.

import { useState } from 'react';
import { useFlowRun } from '../../hooks/useFlowRun';
import { AgentRunCard } from '@connorhoehn/ui-components/social';
import { NodeGraph } from '@connorhoehn/ui-components/graph';
import { Button, Card, InlineAlert, Inline, MarkdownView, Stack } from '@connorhoehn/ui-components/shared';
import { MAX_POLLS, pollDelayMs } from './conversationSummarize';
import {
  agentRunStatusOf, canPost, canSave, isTerminal, sourcesMarkdown,
  type ArtifactApi, type ArtifactResult, type ArtifactRunStatus, type PostedArtifact, type SaveTarget,
} from './conversationArtifact';
import { createPageForSave } from './conversationArtifactSave';

export interface ConversationArtifactCardProps {
  runId: string;
  instruction: string;
  requestedBy: string;
  api: ArtifactApi;
  /** Sends the server-built message into the conversation (Social attaches the file first). Rejects when delivery fails. */
  send: (message: PostedArtifact, result: ArtifactResult, target: SaveTarget) => Promise<void>;
  onDismiss: () => void;
  testIdPrefix?: string;
  /** Drawn inside the thread's private-message frame (localMessages `body`): no Card, no "only you" notice. */
  bare?: boolean;
}

/** The graph draws a short label so neighbours do not overlap; the full text is the node's hover title and the outline below it. */
const shortLabel = (label: string): string => (label.length > 14 ? `${label.slice(0, 13)}…` : label);

export default function ConversationArtifactCard({ runId, instruction, requestedBy, api, send, onDismiss, testIdPrefix = 'conversation-artifact', bare = false }: ConversationArtifactCardProps) {
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const flow = useFlowRun<ArtifactRunStatus>(runId, (id) => api.status(id), { isFinished: isTerminal, delayMs: pollDelayMs, maxPolls: MAX_POLLS });
  const status = flow.run;
  const result = status?.result ?? null;
  const what = api.command === 'diagram' ? 'diagram' : 'page';
  const error = actionError ?? flow.error ?? (flow.timedOut ? `The ${what} is taking too long. Dismiss it and try again.` : null);

  const act = async (work: () => Promise<void>, failure: string): Promise<void> => {
    setBusy(true); setActionError(null);
    try { await work(); onDismiss(); }
    catch (cause) { setActionError(cause instanceof Error ? cause.message : failure); }
    finally { setBusy(false); }
  };
  const post = () => act(async () => { await send(await api.requestPost(runId), result!, null); }, 'The diagram could not be posted.');
  const save = () => act(async () => {
    const target = status!.saveTarget ?? null;
    // The page is made by the tenant's own route first; the server then claims Save once and builds the reference.
    const documentId = target === 'document' ? await createPageForSave(status!.channel, result!) : undefined;
    await send(await api.requestSave(runId, documentId), result!, target);
  }, 'The page could not be saved.');

  const content = (
      <Stack gap="sm">
        {!bare && <InlineAlert tone="info">Only you can see this. {api.command === 'diagram' ? 'Post it when it is ready.' : 'Save it as a document when it is ready.'}</InlineAlert>}
        <AgentRunCard runId={runId} instruction={instruction} agentName="Nova" command={`/${api.command}`} requestedBy={requestedBy}
          {...(status ? { status: agentRunStatusOf(status) } : {})} defaultExpanded data-testid={`${testIdPrefix}-run`} />
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
        {result && result.messageCount > 0 && (
          <Stack gap="sm" data-testid={`${testIdPrefix}-result`}>
            {result.command === 'diagram'
              ? <>
                <NodeGraph nodes={result.nodes.map(node => ({ id: node.id, label: shortLabel(node.label), sublabel: node.label }))} edges={result.edges}
                  height={240} data-testid={`${testIdPrefix}-graph`} />
                <MarkdownView markdown={result.nodes.map((node, i) => `${i + 1}. ${node.label}`).join('\n')} scale="sm" data-testid={`${testIdPrefix}-outline`} />
              </>
              : <MarkdownView markdown={result.content} scale="sm" data-testid={`${testIdPrefix}-preview`} />}
            {result.sourceSpans.length > 0 && <MarkdownView markdown={`**Sources**\n\n${sourcesMarkdown(result)}`} scale="sm" data-testid={`${testIdPrefix}-sources`} />}
          </Stack>
        )}
        {status && status.phase === 'completed' && result && result.command === 'doc' && result.messageCount > 0 && !status.saveTarget && (
          <InlineAlert tone="info" data-testid={`${testIdPrefix}-no-store`}>This workspace has no document store to save a page into, so this draft cannot be saved from here.</InlineAlert>
        )}
        <Inline gap="sm" align="center">
          {status && canPost(status) && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void post(); }} data-testid={`${testIdPrefix}-post`}>Post to conversation</Button>
          )}
          {status && canSave(status) && (
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void save(); }} data-testid={`${testIdPrefix}-save`}>Save as document</Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={onDismiss} data-testid={`${testIdPrefix}-dismiss`}>Dismiss</Button>
        </Inline>
      </Stack>
  );
  return bare ? <Stack gap="none" data-testid={`${testIdPrefix}-card`}>{content}</Stack>
    : <Card padding="sm" data-testid={`${testIdPrefix}-card`}>{content}</Card>;
}
