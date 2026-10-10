// Shared message pins for a tenant discussion (orgiq initiative/work,
// pipelines run/definition, assessment document chat), composed the way
// SocialConversation does it: realtime-modules' `usePins` over the BFF's
// authenticated `/api/chat/pins` routes, the hook handed to WrappedChatPanel
// for the per-message pin control, and the library's PinnedMessagesPanel as
// the Pinned view with Jump.
//
// The BFF asks the conversation's own authority on every request
// (routes/chat-pins.ts `tenantPinAccess`): its read authority to list and
// Jump, its content-publish authority to pin and unpin. `canPin` only decides
// whether the controls are offered; a reader gets a read-only Pinned view.
//
// Jump scrolls to the message when it is loaded. Otherwise it asks the BFF for
// that one original (`GET /api/chat/message`, same authority, history floor and
// deletions) and shows it beside the latest messages with a notice that the
// messages between them are not loaded.

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChannelFilesPanel, PinnedMessagesPanel, type ChannelFileItem, type ChatAttachment } from '@connorhoehnslalom/ui-components/social';
import { ChatIcon, Inline, InlineAlert, PaperclipIcon, PhoneIcon, PinIcon, SegmentedControl, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useGatewayOptional, usePins, type useChat } from '@connorhoehnslalom/realtime-modules/client';
import { useComposerFocusReveal } from '@connorhoehnslalom/ui-components/social/rich-composer';

type Chat = ReturnType<typeof useChat>;
type LoadedMessage = Chat['messages'][number];
export type ChatPinsView = 'chat' | 'pins' | 'files' | 'calls';

export interface UseChatPinsOptions {
  /** The conversation; null turns pins off entirely (no reads, no controls, no tabs). */
  channel: string | null;
  chat: Chat;
  /** The reader holds the conversation's publish authority (pin and unpin). */
  canPin: boolean;
  /** The reader, so their own pins read "pinned by <name>" rather than an id. */
  currentUser?: { id: string; displayName: string };
  /** Prefix for the view's test ids. */
  testId?: string;
  /** A host that owns its tabs: the view lives there, and Jump asks it for Chat. */
  controlledView?: { view: string; onViewChange: (view: 'chat') => void };
  /** A host-owned name for a pinner's id; wins over names read from the thread. */
  nameOf?: (userId: string) => string;
  /** Where the host's thread lives, for Jump (default: the element behind `threadRef`). */
  threadSelector?: string;
  /** A Files tab beside Chat | Pinned: the conversation's attachments (hooks/useChannelFiles), with the image source resolver. */
  files?: { items: readonly ChannelFileItem[]; error: string | null; isLoading: boolean; thumbnailSrc?: (a: ChatAttachment) => string | null | undefined; onJump?: (messageId: string) => void };
  /** A Calls tab beside Chat | Pinned | Files: a page lobby's call history (components/calls/PageCallsView). `onOpen` refreshes it when the tab opens; `badge` is the missed count. */
  calls?: { view: ReactNode; badge?: number; onOpen?: () => void };
  /** A host with one error line takes Jump's failures there instead of in `header`. */
  reportError?: (message: string | null) => void;
}

export interface ChatPinsState {
  enabled: boolean;
  /** `chat` with any originals Jump fetched merged in, oldest first. */
  chat: Chat;
  /** For WrappedChatPanel's `pins`: present only when the reader may pin. */
  messagePins: ReturnType<typeof usePins> | undefined;
  view: ChatPinsView;
  /** Attach to the element that contains the thread, so Jump can find the row. */
  threadRef: React.RefObject<HTMLElement | null>;
  /** Tabs (Chat | Pinned), the alerts and — on the Pinned view — the panel. */
  header: ReactNode;
  /** The pins as the Pinned view shows them (pinner named), for a host that draws its own panel. */
  pins: ReturnType<typeof usePins>['pins'];
  unpin: (messageId: string) => void;
  /** Open the pinned original: scroll to it, or fetch it when it is not loaded. */
  jump: (messageId: string) => Promise<void>;
  isLoading: boolean;
  pinsError: Error | null | undefined;
  /** A fetched original is showing beside the latest messages. */
  fetchedShown: boolean;
}

const JUMP_GONE = 'This pinned message is no longer in the available chat history.';

/**
 * Bring a row into view by scrolling only the real scroll boxes around it
 * (overflow auto/scroll), innermost centred. `scrollIntoView` also scrolls
 * overflow-hidden ancestors and the document, which shoves the fixed-height
 * app shell up and leaves a blank band under it.
 */
function revealInScrollers(row: HTMLElement) {
  let inner = true;
  for (let el = row.parentElement; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if ((overflowY !== 'auto' && overflowY !== 'scroll') || el.scrollHeight <= el.clientHeight) continue;
    const box = el.getBoundingClientRect(), r = row.getBoundingClientRect();
    if (inner) el.scrollTop += (r.top - box.top) - (box.height - r.height) / 2;
    else if (r.top < box.top || r.bottom > box.bottom) el.scrollTop += r.top < box.top ? r.top - box.top : r.bottom - box.bottom;
    inner = false;
  }
}

/**
 * Where a pane wants the conversation's view switcher: an element on its own
 * header row (the initiative pane's tab row, right end). Without one the
 * switcher sits right-aligned above the thread. Either way it is one compact
 * icon control (chat / pin / paperclip / phone, each named by its tooltip) —
 * never a second tab bar under the pane's tabs, and nothing to fold.
 */
export const ConversationViewsSlot = createContext<HTMLElement | null>(null);

export function useChatPins({ channel, chat, canPin, currentUser, testId = 'chat-pins', controlledView, nameOf, threadSelector, reportError, files, calls }: UseChatPinsOptions): ChatPinsState {
  const enabled = channel !== null;
  const pins = usePins(channel);
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  const [ownView, setOwnView] = useState<ChatPinsView>('chat');
  useComposerFocusReveal(request => {
    if (enabled && !controlledView && ['discussion', 'huddle'].includes(request.target?.kind ?? '')) setOwnView('chat');
  });
  const view = (controlledView?.view ?? ownView) as ChatPinsView;
  const setView = (next: ChatPinsView) => { if (controlledView) controlledView.onViewChange('chat'); else setOwnView(next); };
  const [ownError, setOwnError] = useState<string | null>(null);
  const error = reportError ? null : ownError;
  const setError = reportError ?? setOwnError;
  const reportRef = useRef(setError); reportRef.current = setError;
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  const [older, setOlder] = useState<{ channel: string | null; messages: LoadedMessage[] }>({ channel, messages: [] });
  const threadRef = useRef<HTMLElement | null>(null);
  const currentChannel = useRef(channel);
  currentChannel.current = channel;
  useEffect(() => {
    setOlder({ channel, messages: [] }); setJumpTo(null); reportRef.current(null);
    if (!controlledView) setOwnView('chat');
  }, [channel]); // eslint-disable-line react-hooks/exhaustive-deps

  const messages = useMemo(() => {
    if (!enabled || older.channel !== channel || older.messages.length === 0) return chat.messages;
    const ids = new Set(chat.messages.map(message => message.id));
    return [...older.messages.filter(message => !ids.has(message.id)), ...chat.messages]
      .sort((a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''));
  }, [enabled, chat.messages, older, channel]);

  // Live: a peer's pin/unpin, and an edit/delete that changes a pin's excerpt.
  const listen = gateway?.onMessage;
  const refreshPins = pins.refresh;
  useEffect(() => {
    if (!enabled || !listen) return;
    return listen((frame) => {
      if (frame.channel !== channel) return;
      if (frame.type === 'chat:pins-changed'
        || (frame.type === 'chat' && (frame.action === 'messageUpdated' || frame.action === 'messageDeleted'))) refreshPins();
      if (frame.type !== 'chat') return;
      if (frame.action === 'messageUpdated' && frame.message && typeof (frame.message as LoadedMessage).id === 'string') {
        const message = frame.message as LoadedMessage;
        setOlder(state => state.channel === channel ? { ...state, messages: state.messages.map(row => row.id === message.id ? message : row) } : state);
      } else if (frame.action === 'messageDeleted' && typeof frame.messageId === 'string') {
        setOlder(state => state.channel === channel ? { ...state, messages: state.messages.filter(row => row.id !== frame.messageId) } : state);
      }
    });
  }, [enabled, listen, channel, refreshPins]);
  // A missed hint is repaired on reconnect.
  const wasConnected = useRef(connected);
  useEffect(() => {
    if (enabled && connected && !wasConnected.current) refreshPins();
    wasConnected.current = connected;
  }, [enabled, connected, refreshPins]);

  const onOpenCalls = calls?.onOpen;
  useEffect(() => { if (view === 'calls') onOpenCalls?.(); }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (view !== 'chat' || !jumpTo) return;
    const scope: ParentNode | null | undefined = threadSelector ? document.querySelector(threadSelector) : threadRef.current;
    const row = scope?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(jumpTo)}"]`);
    if (row) { revealInScrollers(row); setJumpTo(null); return; }
    const timer = window.setTimeout(() => { setError(JUMP_GONE); setJumpTo(null); }, 2_000);
    return () => window.clearTimeout(timer);
  }, [view, jumpTo, messages]);

  const jump = async (id: string) => {
    if (!channel) return;
    setError(null); setView('chat');
    if (messages.some(message => message.id === id)) { setJumpTo(id); return; }
    try {
      const response = await fetch(`/api/chat/message?channel=${encodeURIComponent(channel)}&messageId=${encodeURIComponent(id)}`, { credentials: 'include' });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? 'This pinned message is no longer available.');
      if (currentChannel.current !== channel) return;
      const message = body.message as LoadedMessage;
      setOlder(state => ({ channel, messages: [...(state.channel === channel ? state.messages.filter(row => row.id !== id) : []), message] }));
      setJumpTo(id);
    } catch (cause) {
      if (currentChannel.current === channel) setError(cause instanceof Error ? cause.message : 'This pinned message is no longer available.');
    }
  };

  // WrappedChatPanel's pin action supplies the excerpt and author; keep the
  // original's time too (the BFF re-derives all three from the stored message).
  const messagePins = enabled && canPin ? { ...pins, pin: (input: Parameters<typeof pins.pin>[0]) => {
    const sentAt = messages.find(m => m.id === input.messageId)?.timestamp;
    return pins.pin({ ...input, ...(sentAt ? { sentAt } : {}) });
  } } : undefined;

  // "pinned by": the server stores the pinner's id. Name it the way the thread
  // already names that person (the gateway-stamped sender name), else the id.
  const names = useMemo(() => {
    const byId = new Map<string, string>();
    for (const m of messages) {
      const name = m.metadata?.['displayName'];
      if (m.userId && typeof name === 'string' && name.trim()) byId.set(m.userId, name);
    }
    if (currentUser?.id) byId.set(currentUser.id, currentUser.displayName);
    return byId;
  }, [messages, currentUser?.id, currentUser?.displayName]);
  const panelPins = useMemo(() => pins.pins.map(pin => ({ ...pin, pinnedBy: nameOf?.(pin.pinnedBy) ?? names.get(pin.pinnedBy) ?? pin.pinnedBy })), [pins.pins, names, nameOf]);

  const fetchedShown = view === 'chat' && older.channel === channel
    && older.messages.some(message => !chat.messages.some(row => row.id === message.id));
  const slot = useContext(ConversationViewsSlot);
  const switcher = (
    <SegmentedControl iconOnly size="sm" tone="accent" aria-label="Conversation views" value={view} onChange={id => setView(id as ChatPinsView)}
      data-testid={`${testId}-tabs`}
      options={[
        { value: 'chat', label: 'Chat', icon: <ChatIcon />, testId: `${testId}-tab-chat` },
        { value: 'pins', label: 'Pinned', icon: <PinIcon />, ...(pins.pins.length ? { badge: pins.pins.length } : {}), testId: `${testId}-tab-pins` },
        ...(files ? [{ value: 'files', label: 'Files', icon: <PaperclipIcon />, ...(files.items.length ? { badge: files.items.length } : {}), testId: `${testId}-tab-files` }] : []),
        ...(calls ? [{ value: 'calls', label: 'Calls', icon: <PhoneIcon />, ...(calls.badge ? { badge: calls.badge } : {}), testId: `${testId}-tab-calls` }] : []),
      ]} />
  );
  const header = enabled ? (
    <Stack gap="xs">
      {slot ? createPortal(switcher, slot) : <Inline justify="end" className="px-4">{switcher}</Inline>}
      {pins.error && view === 'pins' && <InlineAlert tone="error">{`Pinned messages are unavailable: ${pins.error.message}`}</InlineAlert>}
      {error && <InlineAlert tone="error" onDismiss={() => setError(null)}>{error}</InlineAlert>}
      {fetchedShown && <InlineAlert tone="info">Showing the pinned message alongside the latest conversation. Messages between them are not loaded.</InlineAlert>}
      {view === 'files' && files?.error && <InlineAlert tone="error">{files.error}</InlineAlert>}
      {view === 'files' && files?.isLoading && !files.items.length && <InlineAlert tone="info">Loading files…</InlineAlert>}
      {view === 'files' && files && (
        <ChannelFilesPanel files={files.items} {...(files.thumbnailSrc ? { thumbnailSrc: files.thumbnailSrc } : {})}
          {...(files.onJump ? { onJump: (id: string) => { setView('chat'); files.onJump?.(id); } } : {})} data-testid={`${testId}-files`} />
      )}
      {view === 'calls' && calls?.view}
      {view === 'pins' && pins.isLoading && <InlineAlert tone="info">Loading pinned messages…</InlineAlert>}
      {view === 'pins' && (
        <PinnedMessagesPanel pins={panelPins} onJump={id => { void jump(id); }}
          {...(canPin ? { onUnpin: (id: string) => { void pins.unpin(id); } } : {})}
          data-testid={`${testId}-panel`} />
      )}
    </Stack>
  ) : null;

  const unpin = (id: string) => { void pins.unpin(id); };
  return { enabled, pins: panelPins, unpin, jump, isLoading: pins.isLoading, pinsError: pins.error, fetchedShown, chat: messages === chat.messages ? chat : { ...chat, messages }, messagePins, view, threadRef, header };
}
