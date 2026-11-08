// `/summarize`, `/diagram` and `/doc` for a tenant conversation or huddle (Social
// has its own wiring in SocialConversation.tsx; both take their list from
// chatCommandRegistry.ts): the composer's command menu, the interception of
// a typed command, and the private run cards. The command itself
// is the library's ChatCommand shape run directly (parseChatCommand + run), so
// a surface needs no provider above it.
//
// Nothing reaches the conversation until the requester presses "Post to
// conversation" (summary, diagram) or "Save as document" (page) on a finished
// card; `post` is the surface's own confirmed send (gateway chat for a family,
// the huddle's send route for a huddle).

import { useMemo, useRef, useState } from 'react';
import { chatCommandsToComposer, parseChatCommand, type ChatCommand } from '@connorhoehn/ui-components/social';
import type { WrappedLocalMessage } from '@connorhoehn/ui-components/integrations/realtime-modules';
import type { ConversationCommand } from '@connorhoehn/ui-components/social/rich-composer';
import ConversationSummaryCard from './ConversationSummaryCard';
import ConversationArtifactCard from './ConversationArtifactCard';
import ConversationAgentCard from './ConversationAgentCard';
import ConversationApprovalCard from './ConversationApprovalCard';
import { useWaitingApprovals } from './useWaitingApprovals';
import SocialDeckCard from '../../pages/social/decks/SocialDeckCard';
import TenantDeckCard from './TenantDeckCard';
import { TENANT_DECK_PIPELINE_ID, tenantDeckAdapterOf, tenantDeckCommand, parseTenantDeckText } from './tenantDeck';
import { DECK_WRITE_ACTION } from '../decks/deckApi';
import { useCapabilities } from '../../lib/capabilities';
import { DECK_PIPELINE_ID } from '../../pages/social/decks/socialDecksApi';
import { conversationSummarizeApi, type PostedSummary, type SummarizeApi } from './conversationSummarize';
import { artifactKindOf, conversationArtifactApi, type ArtifactApi, type ArtifactCommandName, type ArtifactResult, type PostedArtifact } from './conversationArtifact';
import { commandFailureMessage } from './commandFailure';
import { heldRunNote } from './heldRunNote';
import { conversationAgentApi, isAgentPipeline, type AgentApi, type AgentStepRefKind } from './conversationAgent';
import { CONVERSATION_CHAT_COMMANDS, withoutAgent } from './chatCommandRegistry';

const COMMANDS = [...CONVERSATION_CHAT_COMMANDS];

interface HeldRun { runId: string; instruction: string; kind: 'summary' | 'deck' | 'tenantDeck' | 'agent' | ArtifactCommandName; at: string; notice?: string | null; preview?: boolean }

export interface ConversationSummarize {
  /** The composer's slash commands with their handlers (ConversationComposer `commands`). */
  commands: ConversationCommand[];
  /** The bare menu rows, for a host that runs commands itself. */
  composerCommands: ReturnType<typeof chatCommandsToComposer>;
  /** null: not a command (send it as a message); true: started; false: refused (error is set). */
  intercept(text: string): Promise<boolean | null>;
  /** The private cards for this conversation, as `localMessages` rows (rich `body`, drawn in the thread). */
  localMessages: WrappedLocalMessage[];
  error: string | null;
  clearError(): void;
}

const parseTenantDeckPreview = (text: string): boolean => {
  const request = parseTenantDeckText(text.trim().replace(/^\/deck\b/i, ''));
  return typeof request !== 'string' && request.preview;
};

type RunOutcome = Awaited<ReturnType<ChatCommand['run']>> | null;

/** What a host with its own wiring (Social) swaps in; every field defaults to the tenant-conversation path. */
export interface ConversationSummarizeOptions {
  /** The command list (default: the shared registry). */
  commands?: readonly ChatCommand[];
  /** Runs a parsed command (default: the command's own `run`). */
  runCommand?: (text: string, ctx: Record<string, unknown>) => Promise<RunOutcome>;
  channelKind?: 'room' | 'dm';
  summarizeApi?: SummarizeApi;
  artifactApi?: (kind: ArtifactCommandName) => ArtifactApi;
  /** Test-id prefix for the cards: `<prefix>-summary`, `<prefix>-<kind>` (default `conversation`). */
  testIdPrefix?: string;
  /** Sends a finished /diagram or /doc (default: `post`, which carries no file). */
  sendArtifact?: (message: PostedArtifact, result: ArtifactResult) => Promise<void>;
  /** Present when `/deck` is offered: posts the stored deck's file into the conversation. */
  postDeck?: (deckId: string) => Promise<void>;
  agentApi?: AgentApi;
  /** Hold only runs the command marked private. */
  privateOnly?: boolean;
  /** The reader may post here. Without it `/agent` is not offered (it starts flows; the BFF refuses it too). Default true. */
  maySend?: boolean;
}

export function useConversationSummarize({ channel, userId, displayName, post, commands: allCommands = COMMANDS, runCommand, channelKind = 'room', summarizeApi = conversationSummarizeApi, artifactApi = conversationArtifactApi, testIdPrefix = 'conversation', sendArtifact, postDeck, privateOnly = false, agentApi = conversationAgentApi, maySend = false }: {
  channel: string | null; userId: string; displayName: string;
  post: (message: PostedSummary) => Promise<void>;
} & ConversationSummarizeOptions): ConversationSummarize {
  const { can } = useCapabilities();
  const adapter = useMemo(() => tenantDeckAdapterOf(channel), [channel]);
  // The tenant `/deck` is offered only where this channel has a deck to build.
  const commands = useMemo(() => (maySend ? [...allCommands] : withoutAgent(allCommands)).filter(c => c !== tenantDeckCommand || adapter), [allCommands, maySend, adapter]);
  const deckWriter = adapter ? (can as (action: string) => boolean)(DECK_WRITE_ACTION[adapter.tenant]) : true;
  const [held, setHeld] = useState<{ channel: string | null; runs: HeldRun[] }>({ channel, runs: [] });
  const [error, setError] = useState<string | null>(null);
  const runs = held.channel === channel ? held.runs : [];
  const ctx = useMemo(() => ({
    channel: channel ?? '', channelKind, user: { id: userId, displayName }, idToken: null,
    sidePanel: { current: null, open: () => undefined, close: () => undefined }, deckWriter,
  }), [channel, channelKind, userId, displayName, deckWriter]);
  const composerCommands = useMemo(() => (channel ? chatCommandsToComposer(commands, ctx) : []), [channel, commands, ctx]);
  const dismiss = (runId: string) => setHeld(state => ({ ...state, runs: state.runs.filter(r => r.runId !== runId) }));
  // Loops paused at an approval step: the requester's own that this view does not hold (after a reload), and other
  // members' (read-only, or decidable by an eligible approver). `/agent` is offered only to posters, but any reader may see a pause.
  const waiting = useWaitingApprovals(agentApi, channel, !!channel && allCommands.some(c => c.trigger === '/agent'));
  const [dismissedWaiting, setDismissedWaiting] = useState<ReadonlySet<string>>(new Set());

  const intercept = async (text: string): Promise<boolean | null> => {
    const parsed = parseChatCommand(text.trim(), commands);
    if (!parsed || !channel) return null;
    try {
      const outcome: RunOutcome = runCommand ? await runCommand(text.trim(), ctx)
        : await parsed.command.run({ ...ctx, text: text.trim(), argumentText: parsed.argumentText });
      if (outcome && outcome.kind === 'run' && (!privateOnly || outcome.visibility === 'private')) {
        const instruction = outcome.echo ?? text.trim();
        const kind = isAgentPipeline(outcome.pipelineId) ? 'agent' as const : outcome.pipelineId === TENANT_DECK_PIPELINE_ID ? 'tenantDeck' as const : outcome.pipelineId === DECK_PIPELINE_ID ? 'deck' as const : artifactKindOf(outcome.pipelineId) ?? 'summary' as const;
        setHeld(state => ({ channel, runs: [...(state.channel === channel ? state.runs : []), { runId: outcome.runId, instruction, kind, at: new Date().toISOString(),
          ...(kind === 'tenantDeck' ? { notice: (outcome.card as { notice?: string | null } | undefined)?.notice ?? null, preview: parseTenantDeckPreview(text) } : {}) }] }));
      }
      setError(null);
      return true;
    } catch (cause) {
      setError(commandFailureMessage(parsed.command.trigger, cause));
      return false;
    }
  };

  // The card of the flow an /agent step started: the same card the command alone would have left.
  const stepCard = (kind: AgentStepRefKind, runId: string) => {
    const instruction = `/${kind === 'summary' ? 'summarize' : kind}`;
    const noop = () => undefined;
    if (kind === 'summary') {
      return <ConversationSummaryCard bare runId={runId} instruction={instruction} requestedBy={displayName} api={summarizeApi}
        onPost={post} onDismiss={noop} testIdPrefix={`${testIdPrefix}-summary`} />;
    }
    if (kind === 'deck') {
      return <SocialDeckCard bare runId={runId} instruction={instruction} requestedBy={displayName}
        onPost={deckId => (postDeck ? postDeck(deckId) : Promise.reject(new Error('Decks cannot be posted here.')))} onDismiss={noop} />;
    }
    return <ConversationArtifactCard bare runId={runId} instruction={instruction} requestedBy={displayName} api={artifactApi(kind)}
      send={(message, result) => (sendArtifact ? sendArtifact(message, result) : post(message))} onDismiss={noop} testIdPrefix={`${testIdPrefix}-${kind}`} />;
  };

  const heldIds = new Set(runs.map(r => r.runId));
  const waitingMessages: WrappedLocalMessage[] = waiting.runs.filter(w => !heldIds.has(w.runId) && !dismissedWaiting.has(w.runId)).map(w => ({
    id: `waiting-${w.runId}`, clientId: `waiting-${w.runId}`, timestamp: new Date().toISOString(), displayName: 'Nova', // a card sits at the bottom of the thread while it waits, like a held run's
    content: `/agent (${w.requestedBy})`,
    note: w.mine ? 'Only you can see this. The loop is paused until you decide.' : 'A loop in this conversation is paused for a decision.',
    body: w.mine ? (
      <ConversationAgentCard bare runId={w.runId} instruction="/agent" requestedBy={displayName} api={agentApi}
        renderStepRun={step => stepCard(step.ref.kind, step.ref.runId)}
        onDismiss={() => setDismissedWaiting(prev => new Set(prev).add(w.runId))} testIdPrefix={`${testIdPrefix}-agent`} />
    ) : (
      <ConversationApprovalCard bare item={w} api={agentApi} onDecided={waiting.refresh} testIdPrefix={`${testIdPrefix}-agent`} />
    ),
  }));

  const localMessages: WrappedLocalMessage[] = runs.map(run => ({
    id: `held-${run.runId}`, clientId: `held-${run.runId}`, timestamp: run.at, displayName: 'Nova',
    content: run.instruction, note: heldRunNote(run.kind === 'deck' || run.kind === 'tenantDeck' ? 'summary' : run.kind),
    body: run.kind === 'agent' ? (
      <ConversationAgentCard bare runId={run.runId} instruction={run.instruction} requestedBy={displayName} api={agentApi}
        renderStepRun={step => stepCard(step.ref.kind, step.ref.runId)} onDismiss={() => dismiss(run.runId)} testIdPrefix={`${testIdPrefix}-agent`} />
    ) : run.kind === 'summary' ? (
      <ConversationSummaryCard bare runId={run.runId} instruction={run.instruction} requestedBy={displayName}
        api={summarizeApi} onPost={post} onDismiss={() => dismiss(run.runId)} testIdPrefix={`${testIdPrefix}-summary`} />
    ) : run.kind === 'tenantDeck' ? (
      <TenantDeckCard bare deckId={run.runId} channel={channel ?? ''} instruction={run.instruction} notice={run.notice ?? null} preview={!!run.preview}
        onPost={post} onDismiss={() => dismiss(run.runId)} />
    ) : run.kind === 'deck' ? (
      <SocialDeckCard bare runId={run.runId} instruction={run.instruction} requestedBy={displayName}
        onPost={deckId => (postDeck ? postDeck(deckId) : Promise.reject(new Error('Decks cannot be posted here.')))} onDismiss={() => dismiss(run.runId)} />
    ) : (
      <ConversationArtifactCard bare runId={run.runId} instruction={run.instruction} requestedBy={displayName}
        api={artifactApi(run.kind)} send={(message, result) => (sendArtifact ? sendArtifact(message, result) : post(message))} onDismiss={() => dismiss(run.runId)}
        testIdPrefix={`${testIdPrefix}-${run.kind}`} />
    ),
  }));
  const interceptRef = useRef(intercept);
  interceptRef.current = intercept;
  // A typed command runs here; its private card joins the thread's local messages.
  const handled = useMemo<ConversationCommand[]>(() => composerCommands.map(c => ({
    trigger: c.trigger, label: c.label,
    ...(c.hint ? { hint: c.hint } : {}), ...(c.description ? { description: c.description } : {}),
    ...(c.disabled ? { disabled: true } : {}), ...(c.argument ? { argument: c.argument } : {}),
    run: async input => (await interceptRef.current(input.text)) ?? false,
  })), [composerCommands]);
  return { commands: handled, composerCommands, intercept, localMessages: [...localMessages, ...waitingMessages], error, clearError: () => setError(null) };
}
