// One open social conversation — a channel, a DM or a team channel — on the
// BFF's realtime gateway, drawn as the library's conversation surface
// (`WrappedConversationSurface`, the one realtime-examples' MessagesPage uses):
// the header (name, description, the view tabs Chat | Documents | Pinned |
// Calls, the audio/video call actions, who is here, the page's ⋯ menu) over the
// view. Chat is the pair the document conversation uses
// (pages/assessment/knowledge/DocumentConversation.tsx): `useChat` from
// realtime-modules, the hook-bound `WrappedChatPanel` from the scope-agnostic
// `integrations/realtime` entry, and the library `ConversationComposer`.
//
//   - Documents: the documents this conversation carries — a document card
//     posted in it (`documentRefFromMetadata`) and a `#document` reference in a
//     message (`documentRefsFromMetadata`), newest first.
//   - Pinned: usePins over the BFF's authenticated /api/chat/pins routes;
//     the library's panel and message actions share that same pin state.
//   - Calls: the recordings made in this conversation's lobby
//     (`GET /api/social/recordings`, filtered by the page).
//
// Mounted only for a conversation the caller may read: the gateway admits a
// `social:ch:*` subscribe only from a member and a `social:dm:*` one only from
// someone the lobby names, so a page mounts this after a join, never before.

import { offlineReason } from '../../components/chat/chatConnection';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuoteReply, type ChatReply } from '../../components/chat/ConversationThread';
import { ConversationComposer, useChatAttachmentSend } from '../../lib/conversationComposer';
import { WrappedChatPanel, WrappedConversationSurface } from '@connorhoehnslalom/ui-components/integrations/realtime';
import {
  ChatCommandProvider, chatCommandsToComposer, documentRefFromMetadata, documentRefsFromMetadata, parseChatCommand,
  useChatCommands, useRunChatCommand,
  type ChannelDocumentItem, type ChannelRecordingItem, type ConversationFeature,
} from '@connorhoehnslalom/ui-components/social';
import { Button, DropdownMenu, InlineAlert, Inline, MoreIcon, PresenceAvatars, Stack, type DropdownMenuItem } from '@connorhoehnslalom/ui-components/shared';
import { useUnreadBoundary } from '../../hooks/useUnreadBoundary';
import { useMessagePortraits } from '../../hooks/useMessagePortraits';
import { useChat, useChatMembers, useChatReadReceipts, useGatewayOptional, usePresence, useReactions } from '@connorhoehnslalom/realtime-modules/client';
import { presenceAvatarUsers } from '../assessment/knowledge/knowledgeFormat';
import { sendAndWaitForSocialChatAck, socialChatError } from './socialChatDelivery';
import type { EmbeddedSocialTransport } from '../../lib/embeddedSocial';
import type { ContextComposerProps } from '@connorhoehnslalom/ui-components/social/rich-composer';
import type { CallPageDescriptor } from '../../lib/callPages';
import { readDmPageDescriptor } from '../../lib/dmPageReferences';
import { useChannelFiles } from '../../hooks/useChannelFiles';
import { useChatPins } from '../../components/chat/useChatPins';
import { useChatForward } from '../../components/chat/useChatForward';
import { useMentionCandidates } from '../../components/chat/useMentionCandidates';
import { DmPageReference } from './DmPageReference';
import { socialSummarizeApi } from './socialSummarize';
import { useConversationSummarize } from '../../components/chat/useConversationSummarize';
import { socialSummarizeCommand } from './socialSummarize';
import { recordingPicks, withRecordingPicker } from './socialRecordingPicker';
import { DECK_PIPELINE_ID, fetchDeckFile, postMetadata, requestDeckPost, socialDeckCommand } from './decks/socialDecksApi';
import { WorkGraphActivity } from '../../components/work-graph/WorkGraphActivity';
import ConversationArtifactCard from '../../components/chat/ConversationArtifactCard';
import { artifactFile, artifactKindOf, socialArtifactApi, type ArtifactCommandName, type ArtifactResult, type PostedArtifact } from '../../components/chat/conversationArtifact';
import { socialChatCommands } from '../../components/chat/chatCommandRegistry';
import { conversationCommands } from './socialConversationModel';
import { socialAgentApi } from '../../components/chat/conversationAgent';
import { useCallBlock } from '../../lib/conversationCall';

const OFFLINE_REASON = offlineReason('this conversation');
/** The views the header offers, in the reference's order. */
export const CONVERSATION_VIEWS: readonly ConversationFeature[] = ['chat', 'files', 'documents', 'pins', 'calls'];

export function conversationView(value: string | null | undefined): ConversationFeature {
  return (CONVERSATION_VIEWS as readonly string[]).includes(value ?? '') ? value as ConversationFeature : 'chat';
}

export interface SocialConversationProps {
  /** `social:ch:<slug>`, `social:dm:<ids>` or `social:team:<team>:<channel>`. */
  channel: string;
  /** The header's name — `#slug` for a channel, the other people for a DM. */
  name: string;
  description?: string;
  /** A DM: whether the other person is in the workspace now (the header's dot). */
  online?: boolean;
  /** A one-person DM uses the same disclosed portrait as the directory and transcript. */
  avatarUrl?: string;
  /** The ⋯ menu's items (Leave, Members, …). */
  menu?: DropdownMenuItem[];
  /** Controls beside the call actions. */
  headerActions?: ReactNode;
  /** Start (or join) this conversation's call; absent when calls are unavailable. */
  onStartCall?: (audioOnly: boolean) => void;
  callInProgress?: boolean;
  /** Recordings made in this conversation's lobby (the Calls view). */
  recordings?: readonly ChannelRecordingItem[];
  onOpenRecording?: (recordingId: string) => void;
  view: ConversationFeature;
  onViewChange: (view: ConversationFeature) => void;
  userId: string;
  displayName: string;
  nameOf?: (userId: string) => string;
  placeholder: string;
  /** The Social workspace's open conversation: the shell footer's Message lands in this composer. Never set on embedded panels. */
  focusTarget?: boolean;
  /** Called with the thread's message count whenever it changes (a page marks the conversation read). */
  onMessages?: (count: number) => void;
  /** The newest message, summarised ("Mira: shipping Friday"), or null — the shell's binding strip shows it. */
  onLatestMessage?: (summary: string | null) => void;
  /** Shell embedding keeps hook state alive even while the panel is closed. */
  renderSurface?: (surface: ReactNode) => ReactNode;
  /** Optional host-owned draft persists across panel close and route changes. */
  draft?: ContextComposerProps['draft'];
  onDraftChange?: ContextComposerProps['onDraftChange'];
  /** Current BFF authority can make an otherwise connected chat read-only. */
  /** Whether THIS reader may post here, from the host's capabilities (PostMessage) or the server's answer — never assumed; absent means no. */
  maySend?: boolean;
  onRuntimeChange?: (runtime: EmbeddedSocialTransport) => void | (() => void);
  onSendText?: (text: string) => Promise<boolean>;
  declaredViews?: readonly ConversationFeature[];
  /** Chat commands this conversation offers; Social's `/summarize` and `/deck` by default.
   *  A non-Social conversation (the shell's tenant DMs) passes `[]`: those routes are Social's. */
  commands?: typeof SOCIAL_COMMANDS;
  /** A command to run once when the conversation opens (the Recordings pane's Summarize). It is consumed by `onAutoRunDone`. */
  autoRun?: string | null;
  onAutoRunDone?: () => void;
  /** Offers the conversation's work graph beside the call actions (docs/activity-graph-migration.md §10). Absent: no graph. */
  onToggleGraph?: () => void;
  /** The graph, not the transcript, fills the pane (`?view=graph`); any view tab closes it. */
  graphOpen?: boolean;
  /** The toggle's word ("Work graph" by default; the Communication plane's "Shared work"). */
  graphLabel?: string;
  /** What fills the pane while the toggle is on, given the thread's messages; the conversation's work graph by default. */
  renderGraph?: (messages: readonly { id?: string; userId?: string; timestamp?: string; metadata?: Record<string, unknown> }[]) => ReactNode;
  /**
   * The conversation sits in a narrow host (the footer's Social panel, a
   * tenant DM): the call bar above the composer draws its compact form.
   */
  compactCallDock?: boolean;
}

type ChatMessage = { id?: string; timestamp?: string; userId?: string; metadata?: Record<string, unknown> };

/** Documents carried by the thread: cards posted in it and `#` references, newest first, one row each. */
function threadDocuments(messages: readonly ChatMessage[]): ChannelDocumentItem[] {
  const byId = new Map<string, ChannelDocumentItem>();
  for (const m of messages) {
    const card = documentRefFromMetadata(m.metadata);
    const refs = documentRefsFromMetadata(m.metadata).map((r) => ({ documentId: r.id, title: r.label, ...(r.icon ? { icon: r.icon } : {}) }));
    for (const doc of [...(card ? [card] : []), ...refs]) {
      byId.set(doc.documentId, { ...byId.get(doc.documentId), ...doc, ...(m.timestamp ? { updatedAt: m.timestamp } : {}) });
    }
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

// The shared registry (components/chat/chatCommandRegistry.ts) also feeds tenant discussions and huddles.
const SOCIAL_COMMANDS = socialChatCommands(socialSummarizeCommand, socialDeckCommand);
/** Only these read a recorded call (`--from recording:<id>`), so only they get the recording picker. */
const RECORDING_COMMANDS: readonly string[] = ['/summarize', '/deck'];

/** The conversation, with the chat commands (`/summarize`, `/deck`, `/diagram`, `/doc`) registered through the library's provider. */
export default function SocialConversation(props: SocialConversationProps) {
  // The recording picker reads this conversation's recordings as they refresh; the commands stay one stable list.
  // A command that takes an argument makes a bare `/summarize` a two-step pick in the library's menu, so the
  // picker is attached only when this conversation has a recording to offer.
  const current = recordingPicks(props.channel, props.recordings ?? []);
  const picks = useRef(current);
  useEffect(() => { picks.current = current; });
  const hasPicks = current.length > 0;
  // Default closed: a host that does not say whether this reader may post (its capabilities, the
  // channel's membership) offers no composer send and no `/agent`; the server would refuse anyway,
  // but a control that invites what it cannot do is a lie (audit A5).
  const maySend = props.maySend ?? false;
  const commands = useMemo(
    () => {
      const list = props.commands ?? (hasPicks ? SOCIAL_COMMANDS.map(command => RECORDING_COMMANDS.includes(command.trigger) ? withRecordingPicker(command, () => picks.current) : command) : SOCIAL_COMMANDS);
      // `/agent` starts flows as the member, so a reader who may not post is not offered it (socialConversationModel.ts).
      return conversationCommands(list, maySend);
    },
    [props.commands, hasPicks, maySend],
  );
  return <ChatCommandProvider commands={commands}><SocialConversationInner {...props} /></ChatCommandProvider>;
}

function SocialConversationInner({
  channel, name, description, online, avatarUrl, menu, headerActions, onStartCall, callInProgress, recordings, onOpenRecording,
  view, onViewChange, userId, displayName, nameOf, placeholder, onMessages, onLatestMessage,
  renderSurface, draft, onDraftChange, maySend = false, onRuntimeChange, onSendText, declaredViews, autoRun, onAutoRunDone, focusTarget = false, onToggleGraph, graphOpen = false, graphLabel = 'Work graph', renderGraph, compactCallDock = false,
}: SocialConversationProps) {
  const chat = useChat(channel);
  // While this conversation holds the shell's call: the call bar and tiles above the input.
  const { block: callBlock } = useCallBlock(channel, { compact: compactCallDock });
  const viewNow = useRef({ view, onViewChange });
  viewNow.current = { view, onViewChange };
  // The @ menu: the conversation's own members; an open channel has no member rows, so the tenant directory stands in.
  const memberRoster = useChatMembers(channel);
  const directoryCandidates = useMentionCandidates(memberRoster.open, { userId, key: channel });
  const onSearchPeople = useCallback((query: string) => {
    if (memberRoster.open) return directoryCandidates?.(query) ?? [];
    const needle = query.trim().toLowerCase();
    return memberRoster.members
      .filter(m => m.userId !== userId)
      .map(m => ({ id: m.userId, label: nameOf?.(m.userId) ?? m.userId }))
      .filter(c => !needle || c.label.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [memberRoster.open, memberRoster.members, directoryCandidates, nameOf, userId]);
  const pinsEnabled = (declaredViews ?? CONVERSATION_VIEWS).includes('pins');
  const { roster } = usePresence(channel, { join: true });
  const reactions = useReactions(channel);
  const gateway = useGatewayOptional();
  const attachments = useChatAttachmentSend(channel, displayName);
  const connected = gateway?.connectionState === 'connected';
  const sessionEpoch = gateway?.sessionEpoch;
  const newest = chat.messages[chat.messages.length - 1];
  const receipts = useChatReadReceipts(channel, {
    ...(userId ? { currentUserId: userId } : {}),
    active: connected && view === 'chat',
    newestMessage: newest?.timestamp ? { ...(newest.id ? { id: newest.id } : {}), timestamp: newest.timestamp } : null,
  });
  const unreadFrom = useUnreadBoundary(channel, userId, chat.messages);
  const [joined, setJoined] = useState<{ channel: string; epoch: number | undefined } | null>(null);
  const ready = maySend && connected && joined?.channel === channel && joined.epoch === sessionEpoch;
  const unavailableReason = connected ? 'This conversation is connecting. Wait until chat is ready before sending.' : OFFLINE_REASON;
  const sendScope = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController(); sendScope.current = controller;
    return () => controller.abort();
  }, [channel, connected, sessionEpoch]);
  useEffect(() => { setJoined(null); }, [channel, sessionEpoch]);
  const [error, setError] = useState<string | null>(null);
  const currentChannel = useRef(channel);
  currentChannel.current = channel;
  const pinState = useChatPins({
    channel: pinsEnabled ? channel : null, chat, canPin: true, ...(nameOf ? { nameOf } : {}),
    controlledView: { view, onViewChange }, threadSelector: '[data-testid="social-chat-panel"]', reportError: setError,
  });
  const { pins, chat: threadChat } = pinState;
  // Files ride with Documents (the library merges them into one list); the BFF lists only what this member could download.
  const channelFiles = useChannelFiles(channel, (declaredViews ?? CONVERSATION_VIEWS).includes('files'), threadChat.messages);
  const messages = useMessagePortraits(threadChat.messages);
  const portraitChat = { ...threadChat, messages };
  const listen = gateway?.onMessage;
  useEffect(() => listen?.((frame) => {
    const failure = socialChatError(frame, channel);
    if (failure) setError(failure);
    if (frame.type === 'chat' && frame.channel === channel && frame.action === 'joined') {
      setJoined({ channel, epoch: sessionEpoch });
    }
    if (frame.type === 'chat' && frame.channel === channel && frame.action === 'left') setJoined(null);
  }), [listen, channel, sessionEpoch]);
  const here = presenceAvatarUsers(roster);
  const count = chat.messages.length;
  useEffect(() => { onMessages?.(count); }, [count, onMessages]);
  const newestText = typeof (newest as { message?: unknown } | undefined)?.message === 'string'
    ? ((newest as { message: string }).message).replace(/\s+/g, ' ').trim() : '';
  const newestWho = newest?.userId ? (nameOf?.(newest.userId) ?? (newest.metadata as { displayName?: unknown } | undefined)?.displayName) : null;
  const latestSummary = newestText ? `${typeof newestWho === 'string' && newestWho ? `${newestWho}: ` : ''}${newestText}` : null;
  useEffect(() => { onLatestMessage?.(latestSummary); }, [latestSummary, onLatestMessage]);
  const documents = useMemo(() => threadDocuments(messages as readonly ChatMessage[]), [messages]);

  // Private run cards (`/summarize`, `/deck`, `/diagram`, `/doc`) are rendered in the thread by the shared hook, below.
  const commands = useChatCommands();
  const runCommand = useRunChatCommand();
  const quote = useQuoteReply(channel);
  const forward = useChatForward({ channel, userId, displayName, enabled: ready });
  useEffect(() => quote.clear(), [channel]); // eslint-disable-line react-hooks/exhaustive-deps
  const sendConfirmed = async (text: string, signal?: AbortSignal, page?: CallPageDescriptor | null, reply?: ChatReply | null, extra?: Record<string, unknown>): Promise<void> => {
    if (!ready || !listen || !text.trim()) throw new Error(unavailableReason);
    const controller = sendScope.current;
    const deliveryId = crypto.randomUUID();
    try {
      // The gateway stamps the sender from the token; the name travels too so
      // an older peer still renders it (WrappedChatPanel's own rule).
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      await sendAndWaitForSocialChatAck({ channel, deliveryId, userId, listen, signal: combined,
        send: () => chat.sendMessage(text.trim(), { displayName, clientDeliveryId: deliveryId,
          ...(page ? { pageReference: { kind: page.kind, id: page.id } } : {}), ...(reply ? { replyTo: reply } : {}), ...extra }) });
      if (combined.aborted) throw new Error('The conversation changed before the message was confirmed.');
      setError(null);
    } catch (cause) {
      if (!controller.signal.aborted && !signal?.aborted) setError(cause instanceof Error ? cause.message : 'The message could not be sent.');
      throw cause;
    }
  };
  // "Post to conversation" for a /deck card: the BFF re-checks membership and PostMessage and
  // returns the message; the .pptx goes through the same upload path as any attachment.
  const postDeck = async (deckId: string): Promise<void> => {
    const posted = await requestDeckPost(deckId);
    if (posted.channel !== channel) throw new Error('This deck belongs to another conversation.');
    const { uploaded, metadata } = await attachments.prepare(posted.text, [await fetchDeckFile(posted)]);
    if (uploaded.length === 0) throw new Error('The deck file was not uploaded.');
    await sendConfirmed(posted.text, undefined, null, null, postMetadata(posted, metadata, displayName));
  };
  // "Post to conversation" (/diagram) and "Save as document" (/doc): the BFF re-checked membership and
  // PostMessage and built the message; the drawio / markdown file goes up through the same attachment
  // path as any file (the thread's Documents view lists it), and only then is the message sent.
  const sendArtifact = async (message: PostedArtifact, result: ArtifactResult): Promise<void> => {
    if (message.channel !== channel) throw new Error('This result belongs to another conversation.');
    const { uploaded, metadata } = await attachments.prepare(message.text, [artifactFile(result)]);
    if (uploaded.length === 0) throw new Error('The file was not uploaded.');
    await sendConfirmed(message.text, undefined, null, null, { ...message.metadata, ...metadata });
  };
  const summarize = useConversationSummarize({
    channel, userId, displayName, commands, channelKind: channel.startsWith('social:dm:') ? 'dm' : 'room',
    runCommand: (text, ctx) => runCommand(text, ctx as Parameters<typeof runCommand>[1]),
    summarizeApi: socialSummarizeApi, artifactApi: socialArtifactApi, agentApi: socialAgentApi, maySend, testIdPrefix: 'social', privateOnly: true,
    post: message => sendConfirmed(message.text, undefined, null, null, message.metadata),
    sendArtifact, postDeck,
  });
  // The Recordings pane's Summarize: run the command once here, so its private card (and Post) live in the conversation.
  const autoRan = useRef<string | null>(null);
  useEffect(() => {
    if (!autoRun || autoRan.current === `${channel}|${autoRun}`) return;
    autoRan.current = `${channel}|${autoRun}`;
    void summarize.intercept(autoRun).finally(() => onAutoRunDone?.());
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const confirmedRef = useRef(sendConfirmed); confirmedRef.current = sendConfirmed;
  useEffect(() => onRuntimeChange?.({ channel, ready, send: (text, signal, page, extra) => confirmedRef.current(text, signal, page, null, extra) }),
    [onRuntimeChange, channel, ready, sessionEpoch]);
  // The conversation's confirmed send (the composer has landed any files and stamped the quote).
  const send = async (text: string, metadata: Record<string, unknown>): Promise<boolean> => {
    if (onSendText) return onSendText(text);
    try {
      await sendConfirmed(text, undefined, null, null, metadata);
      return true;
    } catch { return false; }
  };

  const actions = (
    <Inline gap="sm" align="center" wrap={false}>
      {here.length > 0 && <PresenceAvatars size={24} maxVisible={5} users={here} />}
      {headerActions}
      {onToggleGraph && (
        <Button variant={graphOpen ? 'primary' : 'secondary'} size="sm" aria-pressed={graphOpen} onClick={onToggleGraph} data-testid="social-conversation-graph-toggle">
          {graphLabel}
        </Button>
      )}
      {menu && menu.length > 0 && (
        <DropdownMenu trigger={<MoreIcon size={16} />} triggerLabel={`More for ${name}`} triggerTitle="More"
          triggerTestId="social-conversation-menu" triggerClassName="h-8 w-8 border-transparent px-0 py-0 text-text-secondary"
          align="end" sections={[{ items: menu }]} />
      )}
    </Inline>
  );

  const surface = (
    <Stack gap="none" className="min-h-0 min-w-0 flex-1">
      {pinState.pinsError && <InlineAlert tone="error">{`Pinned messages are unavailable: ${pinState.pinsError.message}`}</InlineAlert>}
      {error && <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert>}
      {forward.picker}
      {summarize.error && <InlineAlert tone="error" onDismiss={summarize.clearError}>{summarize.error}</InlineAlert>}
      {view === 'pins' && pinState.isLoading && <InlineAlert tone="info">Loading pinned messages…</InlineAlert>}
      {pinState.fetchedShown && <InlineAlert tone="info">Showing the pinned message alongside the latest conversation. Messages between them are not loaded.</InlineAlert>}
      <WrappedConversationSurface
        className="min-h-0 min-w-0 flex-1"
        name={name}
        {...(description ? { description } : {})}
        {...(online !== undefined ? { online } : {})}
        {...(avatarUrl ? { avatarUrl } : {})}
        declare={declaredViews ?? CONVERSATION_VIEWS}
        view={view}
        onViewChange={onViewChange}
        documents={documents}
        files={channelFiles.files}
        thumbnailSrc={a => attachments.srcFor(a)}
        pins={pins}
        onUnpin={pinState.unpin}
        onJumpToMessage={id => { void pinState.jump(id); }}
        recordings={recordings ?? []}
        {...(onOpenRecording ? { onOpenRecording } : {})}
        {...(onStartCall ? { onStartCall } : {})}
        callInProgress={!!callInProgress}
        headerActions={actions}
        canvas={!connected ? <InlineAlert tone="warning">{OFFLINE_REASON}</InlineAlert> : undefined}
        data-testid="social-chat-panel"
      >
        {graphOpen && renderGraph ? renderGraph(messages as readonly ChatMessage[]) : graphOpen ? (
          <WorkGraphActivity subject={{ kind: 'conversation', id: channel }} cursorChannel={channel} mode="split" title={`${name} activity`} className="h-full min-h-[360px]" />
        ) : <WrappedChatPanel key={channel} chat={portraitChat} {...(summarize.localMessages.length ? { localMessages: summarize.localMessages } : {})} reactions={reactions} attachmentSrc={a => attachments.srcFor(a)} pins={pinState.messagePins} currentUserId={userId} displayName={displayName} editable={ready} {...(forward.onForwardMessage ? { onForwardMessage: forward.onForwardMessage } : {})}
          renderMessageReferences={message => {
            const page = readDmPageDescriptor(message.metadata?.pageReference);
            return page && typeof message.id === 'string' && channel.startsWith('social:dm:')
              ? <DmPageReference channel={channel} messageId={message.id} page={page} /> : null;
          }}
          fill showHeader={false} disabled={!ready} onReply={quote.start} typingUsers={threadChat.typingUsers}
          threaded={!channel.startsWith('social:dm:')} readReceipts={receipts.receipts} readReceiptsEnabled={receipts.enabled} {...(unreadFrom ? { unreadFrom } : {})}
          composer={<ConversationComposer channel={channel} chat={threadChat} context={{ kind: 'conversation', id: channel, title: name }}
            capabilities={{ maySend, mayAttach: !onSendText }} offline={ready || !maySend ? null : unavailableReason}
            identity={{ userId, displayName }} reply={quote} commands={summarize.commands} callBlock={callBlock}
            recipients={[{ id: 'discussion', label: name, channel, attachments: true, send: out => send(out.text, out.metadata) }]}
            modePlaceholders={{ chat: placeholder }} onSearchPeople={onSearchPeople} draftKey={`social:${channel}`}
            {...(draft !== undefined ? { draft } : {})} {...(onDraftChange ? { onDraftChange } : {})}
            answersFocus={focusTarget} onReveal={() => { if (viewNow.current.view !== 'chat') viewNow.current.onViewChange('chat'); }}
            label={`Message ${name}`} data-testid="social-chat-composer-dock" composerTestId="social-chat-composer" />} />}
      </WrappedConversationSurface>
    </Stack>
  );
  return renderSurface ? renderSurface(surface) : surface;
}
