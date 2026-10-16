// A tenant conversation (an initiative's or work item's discussion, a team's,
// a run's, a document's chat, a huddle's): ONE runtime per channel and the
// thread drawn from it.
//
//   const convo = useConversation(channel, { maySend });          // one join per channel
//   <ConversationThread conversation={convo} title="Discussion" … />          // in a pane
//   <ConversationComposer channel={channel} chat={convo.chat} commands={convo.commands}
//     reply={convo.quote} … />                                                 // in the content column
//
// The runtime is the gateway chat (`useChat` + read receipts + reactions), the
// quote-reply, and the conversation's slash commands (`/summarize`, `/deck`,
// `/diagram`, `/doc`, `/agent` — useConversationSummarize) whose private cards
// live in the thread. A page that docks its composer in the content column and
// shows the thread in the side pane hands the SAME runtime to both, so a card a
// command starts there appears here.
//
// The thread is the library's WrappedChatPanel with the views this app keeps
// beside Chat (Pinned, Files, Calls), Forward, the unread divider and the
// page-reference cards. Its input is the library ConversationComposer — unless
// a composer elsewhere on the page claims this conversation (the library's one
// input per conversation, `useThreadInput`), when the thread draws the library
// hand-off instead; `input="below"` is a page whose composer sits right under
// the thread (no input, no hand-off).

import { useChat, useChatReadReceipts, useGatewayOptional, useReactions } from '@connorhoehnslalom/realtime-modules/client';
import { WrappedChatPanel, type WrappedChatPanelProps } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { Button, EmptyState, Inline, InlineAlert, LoadingState, LockIcon, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { ThreadInputHandoff, useThreadInput, type ConversationComposerProps } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useChannelFiles } from '../../hooks/useChannelFiles';
import { useMessagePortraits } from '../../hooks/useMessagePortraits';
import { usePageCalls, usePeopleNames } from '../../hooks/usePageCalls';
import { useUnreadBoundary } from '../../hooks/useUnreadBoundary';
import { useSession } from '../../lib/auth';
import { ConversationComposer, useAttachmentSource } from '../../lib/conversationComposer';
import { isPageCallLobby } from '../../lib/pageCalls';
import { PageCallsView } from '../calls/PageCallsView';
import { OFFLINE_REASON, isConnected } from './chatConnection';
import type { ConversationReadState } from './conversationReadState';
import { useChatForward } from './useChatForward';
import { useChatPins } from './useChatPins';
import { useConversationReadState } from './useConversationReadState';
import { useConversationSummarize, type ConversationSummarize } from './useConversationSummarize';
import { useMentionCandidates } from './useMentionCandidates';

/** Said to a reader who may see the thread but not post. */
export const READ_ONLY_REASON = 'You can read and filter messages. Your current role cannot post.';

/** A pending quote-reply, from the thread to the composer. */
export interface ChatReply { messageId: string; author: string; text: string; timestamp?: string }
export interface QuoteReply {
  reply: ChatReply | null;
  start(message: { id?: string; displayName?: string; content: string; timestamp?: string }): void;
  clear(): void;
}

/** The quote-reply a thread starts and its composer sends (`metadata.replyTo`); a new channel drops it. */
export function useQuoteReply(channel: string): QuoteReply {
  const [reply, setReply] = useState<{ channel: string; reply: ChatReply } | null>(null);
  const start = useCallback((m: { id?: string; displayName?: string; content: string; timestamp?: string }) => {
    if (m.id) setReply({ channel, reply: { messageId: m.id, author: m.displayName ?? 'Unknown', text: m.content, ...(m.timestamp ? { timestamp: m.timestamp } : {}) } });
  }, [channel]);
  const clear = useCallback(() => setReply(null), []);
  return useMemo(() => ({ reply: reply?.channel === channel ? reply.reply : null, start, clear }), [reply, channel, start, clear]);
}

export interface ConversationRuntime {
  channel: string;
  chat: ReturnType<typeof useChat>;
  receipts: ReturnType<typeof useChatReadReceipts>;
  reactions: ReturnType<typeof useReactions>;
  quote: QuoteReply;
  connected: boolean;
  readState?: ConversationReadState;
  /** The server's answer: this reader may post here. */
  maySend: boolean;
  userId: string;
  displayName: string;
  /** Slash commands for the composer (their cards draw in the thread). */
  commands: ConversationSummarize['commands'];
  summarize: ConversationSummarize;
}

export interface UseConversationOptions {
  /** This reader may post here (the conversation's write authority). Required: missing means no. */
  maySend: boolean;
  /** Posts a finished card (`/summarize`, `/diagram`) through a confirmed send (default: the gateway chat). */
  post?: (text: string, metadata: Record<string, unknown>) => Promise<void>;
  /** Confirm native history before claiming that this discussion is empty. */
  confirmHistory?: boolean;
}

/** The runtime of one conversation: call once per channel and share it. */
export function useConversation(channel: string, { maySend, post, confirmHistory = false }: UseConversationOptions): ConversationRuntime {
  const { session } = useSession();
  const userId = session?.sub ?? '';
  const displayName = session?.name ?? session?.sub ?? 'You';
  const chat = useChat(channel);
  const reactions = useReactions(channel);
  const connected = isConnected(useGatewayOptional()?.connectionState);
  const readState = useConversationReadState(channel, confirmHistory, chat.loadHistory);
  const last = chat.messages[chat.messages.length - 1];
  const receipts = useChatReadReceipts(channel, {
    ...(userId ? { currentUserId: userId } : {}),
    active: connected,
    newestMessage: last?.timestamp ? { ...(last.id ? { id: last.id } : {}), timestamp: last.timestamp } : null,
  });
  const quote = useQuoteReply(channel);
  const postRef = useRef(post);
  postRef.current = post;
  const summarize = useConversationSummarize({ channel, userId, displayName, maySend,
    post: async (message) => {
      if (!connected) throw new Error(OFFLINE_REASON);
      if (postRef.current) return postRef.current(message.text, message.metadata);
      chat.sendMessage(message.text, { displayName, ...message.metadata });
    } });
  return { channel, chat, receipts, reactions, quote, connected, ...(readState ? { readState } : {}), maySend, userId, displayName, commands: summarize.commands, summarize };
}

/**
 * Owns a conversation whose channel can change or be absent (a page that
 * loads, a focused work item): mount it keyed by the channel beside the page's
 * columns and it publishes the ONE runtime they share.
 */
export function ConversationOwner({ channel, maySend, onChange }: { channel: string; maySend: boolean; onChange: (conversation: ConversationRuntime | null) => void }) {
  const conversation = useConversation(channel, { maySend });
  const { chat, connected, quote, summarize, receipts, reactions } = conversation;
  useEffect(() => { onChange(conversation); },
    // The runtime is a fresh object per render; what changes is its state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [channel, maySend, chat.messages, chat.typingUsers, connected, quote.reply, summarize.localMessages.length, summarize.commands, summarize.error, receipts.receipts, receipts.enabled, reactions.reactions]);
  useEffect(() => () => onChange(null), [onChange]);
  return null;
}

export interface ConversationThreadProps {
  conversation: ConversationRuntime;
  title: string;
  /** Why this reader cannot post (shown on the off Chat mode). */
  readOnlyReason?: string | null;
  /** Shared pins (Chat | Pinned | Files | Calls). `canPin`: the reader holds the publish authority. */
  pins?: { canPin: boolean };
  /** Writers attach files; readers still see and download what is attached. */
  attachments?: boolean;
  includeFiles?: boolean;
  /** Writers react; a reader gets no picker. */
  reactions?: boolean;
  /** Offer Edit/Delete on the viewer's own messages (the gateway still decides). */
  editable?: boolean;
  renderMessageReferences?: WrappedChatPanelProps['renderMessageReferences'];
  /** Who else is composing; default the chat's. */
  typingUsers?: string[];
  /** Fill the parent's height (default); false lays the thread out inline. */
  fill?: boolean;
  /** `below`: the page's composer sits right under this thread — draw no input and no hand-off. */
  input?: 'own' | 'below';
  /** The thread's own composer: what the host adds (a recipient with a confirmed send, a draft, chips). */
  composer?: Partial<ConversationComposerProps>;
  /** Chat placeholder for the own composer. */
  placeholder?: string;
  /** Say above the thread when the gateway is offline and when this reader may only read (`<id>-offline`, `<id>-read-only`). */
  notices?: boolean;
  emptyState?: ReactNode;
  /** WrappedChatPanel `dock`, pinned above the input (the meeting chat's: which chat this is, the organizer's "To" switch). */
  dock?: ReactNode;
  /** WrappedChatPanel `transformMessages` (the meeting chat's `withAnnouncements`); must be cheap. */
  transformMessages?: WrappedChatPanelProps['transformMessages'];
  'data-testid'?: string;
}

export function ConversationThread({ conversation, title, readOnlyReason = null, pins, attachments = false, includeFiles = true, reactions = false, editable = true, renderMessageReferences, typingUsers, fill = true, input = 'own', composer, placeholder, notices = false, emptyState, dock, transformMessages, 'data-testid': testId }: ConversationThreadProps) {
  const { channel, chat: originalChat, receipts, quote, connected, readState, maySend, userId, displayName, summarize } = conversation;
  const messages = useMessagePortraits(originalChat.messages);
  const chat = { ...originalChat, messages };
  const srcFor = useAttachmentSource();
  // Files: a Files tab beside Pinned on every tenant discussion (the BFF lists only what this reader could download).
  const channelFiles = useChannelFiles(pins && includeFiles ? channel : null, !!pins && includeFiles, chat.messages);
  // Calls: a page lobby's call history beside Files (the BFF lists only what this reader's page authority admits).
  const callLobby = pins && isPageCallLobby(channel) ? channel : null;
  const pageCalls = usePageCalls(callLobby);
  const peopleNames = usePeopleNames(!!callLobby);
  const pinned = useChatPins({ channel: pins ? channel : null, chat, canPin: !!pins?.canPin,
    ...(callLobby ? { calls: { badge: pageCalls.data?.counts.missed ?? 0, onOpen: pageCalls.refresh,
      view: <PageCallsView lobby={callLobby} calls={pageCalls} me={userId} nameOf={peopleNames} testId={testId ? `${testId}-calls` : 'page-calls'} /> } } : {}),
    ...(pins && includeFiles ? { files: { items: channelFiles.files, error: channelFiles.error, isLoading: channelFiles.isLoading, thumbnailSrc: a => srcFor(a) } } : {}),
    currentUser: { id: userId, displayName }, testId: testId ? `${testId}-pins` : 'chat-pins' });
  const onSearchPeople = useMentionCandidates(true, { userId, key: channel, tenant: channel.split(':')[0] });
  const unreadFrom = useUnreadBoundary(channel, userId, chat.messages);
  const forward = useChatForward({ channel, userId, displayName, enabled: editable });
  // One input per conversation: a composer elsewhere on the page that claims this channel owns it.
  const owner = useThreadInput(channel);
  const elsewhere = input === 'own' && owner.owner === 'composer' ? owner : null;
  const readPending = readState?.phase === 'loading';
  const readError = readState?.phase === 'error' ? readState : null;
  const canWrite = maySend && !readOnlyReason && !readPending && !readError;
  const field = input === 'below' ? <Fragment />
    : elsewhere ? <ThreadInputHandoff label={elsewhere.label} onFocus={() => owner.focus()} {...(testId ? { 'data-testid': `${testId}-input-elsewhere` } : {})} />
    : <ConversationComposer channel={channel} chat={chat} context={{ kind: 'conversation', id: channel, title }}
        capabilities={{ maySend: canWrite, ...(readOnlyReason ? { readOnlyReason } : {}), mayAttach: attachments && canWrite }}
        offline={connected ? null : OFFLINE_REASON} identity={{ userId, displayName }} commands={summarize.commands} reply={quote}
        draftKey={`${channel}:summarizable`} modePlaceholders={{ chat: placeholder ?? 'Write a message, or /summarize…' }}
        {...(onSearchPeople ? { onSearchPeople } : {})}
        {...(testId ? { 'data-testid': `${testId}-composer-dock`, composerTestId: `${testId}-composer` } : {})} {...composer} />;
  const gateway = useGatewayOptional();
  const noMessages = chat.messages.length === 0 && summarize.localMessages.length === 0;
  const waitingState = readError ? <Inline gap="sm" align="start" wrap={false} role="status"
    className="mx-4 mt-3 rounded-lg border border-border bg-surface-muted px-3 py-2"
    data-testid={testId ? `${testId}-load-error` : 'discussion-load-error'}>
      <LockIcon size={14} className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true" />
      <Stack gap="xs" className="min-w-0">
        <T size="sm" weight="semibold">{readError.denied ? 'Discussion access unavailable' : 'Discussion could not be loaded'}</T>
        <T size="xs" tone="secondary" wrap>{readError.message}</T>
        {!readError.denied && gateway?.reconnect && <Button variant="secondary" size="sm" onClick={gateway.reconnect}>Reconnect</Button>}
      </Stack>
    </Inline>
    : readPending ? <LoadingState label="Loading discussion…" />
    : noMessages && !connected ? <EmptyState align="start" title="Discussion is offline"
        description="Reconnect to load messages and continue the conversation."
        {...(gateway?.reconnect ? { actionLabel: 'Reconnect', onAction: gateway.reconnect } : {})}
        testId={testId ? `${testId}-offline-empty` : 'discussion-offline-empty'} /> : null;
  const thread = waitingState || (emptyState && noMessages)
    ? <Stack gap="none" className="min-h-0 flex-1">
        <Stack gap="none" className="min-h-0 flex-1 overflow-auto">{waitingState ?? emptyState}</Stack>
        {/* No panel draws here yet, so the dock stands over the input itself. */}
        {!readError && <Stack gap="none" className="shrink-0">{dock}{field}</Stack>}
      </Stack> : (
    <WrappedChatPanel key={channel} chat={pinned.chat} attachmentSrc={a => srcFor(a)} {...(reactions && canWrite ? { reactions: conversation.reactions } : {})}
      {...(pinned.messagePins ? { pins: pinned.messagePins } : {})} currentUserId={userId} displayName={displayName}
      editable={editable && canWrite && connected} {...(forward.onForwardMessage && canWrite ? { onForwardMessage: forward.onForwardMessage } : {})}
      {...(fill ? { fill: true } : {})} showHeader={false} contentAlign={input === 'below' || elsewhere ? 'start' : 'end'} {...(summarize.localMessages.length ? { localMessages: summarize.localMessages } : {})}
      threaded {...(unreadFrom ? { unreadFrom } : {})} readReceipts={receipts.receipts} readReceiptsEnabled={receipts.enabled} disabled={!connected}
      onReply={input === 'below' ? undefined : elsewhere ? (elsewhere.replies ? message => { quote.start(message); owner.focus(true); } : undefined) : quote.start}
      {...(renderMessageReferences ? { renderMessageReferences } : {})} typingUsers={typingUsers ?? chat.typingUsers}
      flushComposer={input !== 'below' && !elsewhere} composer={field}
      {...(dock ? { dock } : {})} {...(transformMessages ? { transformMessages } : {})} />
  );
  return (
    <Stack gap="sm" className={fill ? 'min-h-0 flex-1' : 'min-h-[16rem]'} data-testid={testId}>
      {notices && !connected && !noMessages && <InlineAlert tone="warning" {...(testId ? { 'data-testid': `${testId}-offline` } : {})}>{OFFLINE_REASON}</InlineAlert>}
      {notices && connected && !readPending && !readError && !canWrite && <Inline gap="sm" align="start" wrap={false}
        className="mx-4 mt-3 rounded-lg border border-border bg-surface-muted px-3 py-2" role="status"
        {...(testId ? { 'data-testid': `${testId}-read-only` } : {})}>
        <LockIcon size={14} className="mt-0.5 shrink-0 text-text-muted" aria-hidden="true" />
        <Stack gap="none" className="min-w-0">
          <T size="xs" weight="semibold">Viewing access</T>
          <T size="xs" tone="secondary" wrap>{readOnlyReason ?? READ_ONLY_REASON}</T>
        </Stack>
      </Inline>}
      {summarize.error && <InlineAlert tone="error" onDismiss={summarize.clearError}>{summarize.error}</InlineAlert>}
      {pinned.header}
      {forward.picker}
      {pinned.enabled
        // Jump looks for the row inside this wrapper; the Pinned view hides the thread without unmounting it.
        ? <Stack gap="none" ref={pinned.threadRef} className={pinned.view !== 'chat' ? 'hidden' : fill ? 'min-h-0 flex-1' : undefined}>{thread}</Stack>
        : thread}
    </Stack>
  );
}

/** A thread that owns its conversation (nothing else on the page writes to it): key it by the channel. */
export function ChannelThread({ channel, maySend, confirmHistory, ...props }: Omit<ConversationThreadProps, 'conversation'> & { channel: string; maySend: boolean; confirmHistory?: boolean }) {
  const conversation = useConversation(channel, { maySend, confirmHistory });
  return <ConversationThread {...props} conversation={conversation} />;
}
