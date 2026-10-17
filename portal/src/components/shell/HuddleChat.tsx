// The huddle's conversation: ordinary gateway chat on the call's
// `orgiq:huddle:<callId>` channel, composed like every tenant discussion —
// `useChat` + read receipts + reactions + quote-reply + shared pins +
// attachments + `/summarize` through ConversationThread. The BFF admits the
// channel only to current seats of the call (middleware lib/call-chat.ts), so
// nothing here decides who may read or post; the resolver
// (GET /api/calls/:callId/chat, lib/huddleRoster.ts) only names the channel,
// its participants and whether this person may post.
//
// Sends keep the persisted-acknowledgement contract: one in flight per shell,
// correlated by delivery id (the socket echo plus the gateway's `sent` after
// the store write, socialChatDelivery.ts). Only a matching stored receipt
// clears the submitted draft; failure or a call end keeps it. The channel
// is captured when Send begins so a changed
// recipient cannot redirect it. A retry of the same text and page reuses its
// delivery id, which the gateway answers with the original message.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useGatewayOptional, type useReactions } from '@connorhoehnslalom/realtime-modules/client';
import { composerDraftOf, useComposerFocus, useComposerFocusReveal, useThreadInput, type MentionCandidate, type RichChatComposerHandle, type RichChatDraft } from '@connorhoehnslalom/ui-components/social/rich-composer';
import { PageReferenceCard } from '../chat/PageReferenceCard';
import { ConversationThread, useConversation, type ConversationRuntime } from '../chat/ConversationThread';
import { ChatSidePanelFrame, ReactionOverlay, ReactionPicker, SidePaneSplit, useSidePaneHost } from '@connorhoehnslalom/ui-components';
import { AtIcon, Button, DocumentAddIcon, FloatingPanel, IconButton, Inline, InlineAlert, InlinePopover, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { aboveFooterEnd, useFooterAnchorKey } from './footerPanel';
import { useSession } from '../../lib/auth';
import { useGatewayFrames } from '../../lib/gatewayFrames';
import { sendAndWaitForSocialChatAck } from '../../pages/social/socialChatDelivery';
import { HuddleRoster, createHuddleRosterReader, huddleScopeKey, type HuddleParticipant } from '../../lib/huddleRoster';
import { INERT_MEETING, announceInstead, huddleChatChannelFor, isBreakoutChat } from '../../lib/meetingRooms';
import { MeetingPane, useCallMeeting } from './CallMeeting';
import { currentCallPage, isCallContextReference, readCallChatPageReference, type CallPageDescriptor } from '../../lib/callPages';
import { useCallBlockPageClaimed, useCallHost, useCallMediaPanel, useClaimCallBlock } from '../../lib/conversationCall';
import { useMeetingChat, type MeetingChatBinding } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { callScopeKey, hasJoinedCall, huddleChatScopeTenant } from './callShellModel';
import { CallReactionPlayback } from '../../lib/callReactionPlayback';
import { settleHuddleDraft } from '../../lib/huddleDraft';
import { HuddleDraftMemory, type SavedHuddleDraft } from '../../lib/huddleDraftMemory';

export type RetiredHuddleDraft = SavedHuddleDraft<RichChatDraft, CallPageDescriptor>;

export interface HuddleChatState {
  participants: readonly HuddleParticipant[];
  loaded: boolean; refreshing: boolean; pending: boolean; ended: boolean;
  error: string | null;
}
export interface HuddleChatContextValue {
  /** A page places this transcript in its registered dialogue pane. */
  paneOwned: boolean;
  registerPaneOwner(): () => void;
  /** Only an accepted active OrgIQ call is an eligible destination. */
  callId: string | null;
  /**
   * The gateway channel the conversation reads and posts to: the call's
   * huddle channel, or its breakout room's while the meeting has you in one
   * (lib/meetingRooms.ts `huddleChatChannelFor`). Composers claim this one.
   */
  channel: string | null;
  actorId: string | null;
  title: string;
  participants: readonly HuddleParticipant[];
  state: HuddleChatState;
  canSend: boolean;
  unavailableReason: string | null;
  /** Open anywhere: the shell's right split pane (default) or popped out. */
  open: boolean;
  view: HuddleChatView;
  /** Opens the right pane and focuses its composer (the footer's chat toggle). */
  openMessage(): void;
  popOut(): void;
  closeMessage(): void;
  /** The pane composer's draft and page reference, kept at shell scope per identity and call. */
  draft: RichChatDraft;
  setDraft(draft: RichChatDraft, previous?: RichChatDraft): void;
  /** Unsent local drafts from this exact signed identity's former calls; no call access is granted. */
  retiredDrafts: readonly RetiredHuddleDraft[];
  updateRetiredDraft(callId: string, draft: RichChatDraft): void;
  discardRetiredDraft(callId: string): void;
  page: CallPageDescriptor | null;
  setPage(page: CallPageDescriptor | null): void;
  /** Set by the mounted composer so a toggle can move focus into it. */
  focusRequest: number;
  /** Resolves true only after the gateway acknowledges the stored message. */
  send(text: string, page?: CallPageDescriptor | null, extra?: Record<string, unknown>, submittedDraft?: RichChatDraft): Promise<boolean>;
  /**
   * A page composer hands a huddle-bound draft to this pane (the work item's
   * composer, whose huddle chat is the shell's pane): open/focus it, seed the
   * draft and attach the page. False with no joined huddle.
   */
  openPane(request?: HuddlePaneRequest): boolean;
  refresh(): void;
  /**
   * The call meeting's chat binding (ui-components `useMeetingChat`), run ONCE here so every
   * composer that sends to the huddle — this pane's, the initiative composer's, the presentation
   * dock's — shares one "To" target: while an organizer has "To: All rooms" chosen, `send`
   * announces through the binding's `onSend` and posts nothing to the chat. Null without a meeting.
   */
  meetingChat: MeetingChatBinding | null;
}
export interface HuddlePaneRequest {
  /** Text to carry into the pane's composer. The pane owns it from here. */
  draft?: string;
  /** The draft's page reference (`{kind,id}` only); null when removed. */
  page?: CallPageDescriptor | null;
  /** Selecting a recipient opens its transcript without another focus request. */
  focus?: boolean;
}
export type HuddleChatView = 'closed' | 'pane' | 'floating';
const EMPTY_DRAFT: RichChatDraft = { html: '', files: [] };
const HuddleChatContext = createContext<HuddleChatContextValue | null>(null);
const ReactionPlaybackContext = createContext<CallReactionPlayback | null>(null);
export const useHuddleChat = (): HuddleChatContextValue | null => useContext(HuddleChatContext);

/** What the mounted channel exposes to the shell: the hooks' state and the confirmed send. */
interface HuddleChannelRuntime {
  channel: string;
  conversation: ConversationRuntime;
  /** Rejects on a refusal, timeout, lost connection or a channel change. */
  sendConfirmed(text: string, deliveryId: string, page: CallPageDescriptor | null, extra: Record<string, unknown>): Promise<void>;
}
/** An external store, so publishing the channel's state re-renders its readers, never the shell. */
function channelStore() {
  let value: HuddleChannelRuntime | null = null; const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: HuddleChannelRuntime | null) => { value = next; for (const listener of listeners) listener(); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
const ChannelContext = createContext<ReturnType<typeof channelStore> | null>(null);
function useHuddleChannel(): HuddleChannelRuntime | null {
  const store = useContext(ChannelContext);
  return useSyncExternalStore(store?.subscribe ?? (() => () => {}), store?.get ?? (() => null), store?.get ?? (() => null));
}

/** Mounted only for a confirmed participant on a live gateway: joins the call's chat channel. */
function HuddleChannel({ channel, userId, displayName, maySend, post, publish }: {
  channel: string; userId: string; displayName: string; maySend: boolean;
  /** Posts a finished card through the huddle's confirmed send. */
  post: (text: string, metadata: Record<string, unknown>) => Promise<void>;
  publish: (runtime: HuddleChannelRuntime | null) => void;
}) {
  const gateway = useGatewayOptional();
  const conversation = useConversation(channel, { maySend, post });
  const { chat } = conversation;
  const connected = gateway?.connectionState === 'connected';
  // Unmounting (a new call, identity or reconnect) abandons in-flight
  // acknowledgements: their drafts are kept and nothing is retried here.
  const abort = useRef(new AbortController());
  useEffect(() => { const current = abort.current; return () => current.abort(); }, []);
  const latest = useRef({ chat, connected, listen: gateway?.onMessage });
  latest.current = { chat, connected, listen: gateway?.onMessage };
  const sendConfirmed = useCallback(async (text: string, deliveryId: string, page: CallPageDescriptor | null, extra: Record<string, unknown>) => {
    const { listen, connected: online } = latest.current;
    if (!listen || !online) throw new Error('Reconnect to send huddle messages.');
    await sendAndWaitForSocialChatAck({ channel, deliveryId, userId, listen, signal: abort.current.signal,
      send: () => latest.current.chat.sendMessage(text, { displayName, ...extra, clientDeliveryId: deliveryId,
        ...(page ? { pageReference: { kind: page.kind, id: page.id } } : {}) }) });
  }, [channel, userId, displayName]);
  useEffect(() => { publish({ channel, conversation, sendConfirmed }); });
  useEffect(() => () => publish(null), [publish]);
  return null;
}

/** One shell controller survives route changes; its identity/call scope does not. */
export function HuddleChatProvider({ children }: { children: ReactNode }) {
  const [reactionPlayback] = useState(() => new CallReactionPlayback());
  const host = useCallHost();
  const { session } = useSession();
  const frames = useGatewayFrames();
  const [roster] = useState(() => new HuddleRoster(createHuddleRosterReader()));
  const [store] = useState(channelStore);
  const rosterState = useSyncExternalStore(roster.subscribe, roster.getSnapshot, roster.getSnapshot);
  const [view, setView] = useState<HuddleChatView>('closed');
  const [paneOwners, setPaneOwners] = useState(0);
  const registerPaneOwner = useCallback(() => {
    setPaneOwners(n => n + 1);
    return () => setPaneOwners(n => Math.max(0, n - 1));
  }, []);
  const [draftMemory] = useState(() => new HuddleDraftMemory<RichChatDraft, CallPageDescriptor>(EMPTY_DRAFT));
  const draftSnapshot = useSyncExternalStore(draftMemory.subscribe, draftMemory.getSnapshot, draftMemory.getSnapshot);
  const [focusRequest, setFocusRequest] = useState(0);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // The socket generation whose membership the resolver last confirmed; the
  // channel rejoins only after that (a reconnect is a new, unseated socket).
  const [readyEpoch, setReadyEpoch] = useState<number | null>(null);
  const joined = hasJoinedCall(host?.call.call, host?.call.phase ?? 'idle');
  // Every joined call asks the server for its conversation under the session's
  // tenant; a lobby the BFF does not admit (lib/call-access.ts
  // huddleLobbyTenant) answers 403, which the roster reads as `denied`.
  const tenant = huddleChatScopeTenant(host?.tenant ?? null, joined);
  const callId = tenant ? host?.call.call?.callId ?? null : null;
  const actorId = host?.self?.userId ?? null;
  const identityKey = callScopeKey(session);
  const draftIdentity = session ? identityKey : null;
  const scope = useMemo(() => callId && actorId && tenant && session?.sub === actorId && session.tenant === tenant
    ? { callId, actorId, tenant, identityKey } : null,
    [callId, actorId, tenant, identityKey, session?.sub, session?.tenant]);
  const scopeKey = huddleScopeKey(scope);
  const latestDraftScope = useRef({ scopeKey, identityKey: draftIdentity });
  latestDraftScope.current = { scopeKey, identityKey: draftIdentity };
  const activeDraft = draftMemory.active(draftIdentity, scope);
  const draft = activeDraft?.draft ?? EMPTY_DRAFT;
  const page = activeDraft?.page ?? null;
  const draftRef = useRef(draft); draftRef.current = draft;
  const retiredDrafts = useMemo(() => draftMemory.retired(draftIdentity, scope), [draftMemory, draftSnapshot, draftIdentity, scope]);
  const sameDraftScope = useCallback(() => latestDraftScope.current.scopeKey === scopeKey
    && latestDraftScope.current.identityKey === draftIdentity, [scopeKey, draftIdentity]);
  const setDraft = useCallback((next: RichChatDraft, previous?: RichChatDraft) => {
    // An editor unmounted during a send may acknowledge its old submission
    // with an empty draft. Only that exact revision may be cleared.
    if (previous && !next.html && !next.files.length && previous !== draftRef.current) return;
    if (sameDraftScope() && draftMemory.setDraft(draftIdentity, scope, next)) draftRef.current = next;
  }, [sameDraftScope, draftMemory, draftIdentity, scope]);
  const setPage = useCallback((next: CallPageDescriptor | null) => {
    if (!sameDraftScope()) return;
    const previous = draftMemory.active(draftIdentity, scope)?.page;
    if (previous?.kind === next?.kind && previous?.id === next?.id) return;
    draftMemory.setPage(draftIdentity, scope, next ? { kind: next.kind, id: next.id } : null);
  }, [sameDraftScope, draftMemory, draftIdentity, scope]);
  const updateRetiredDraft = useCallback((retiredCallId: string, next: RichChatDraft) => {
    if (sameDraftScope()) draftMemory.updateRetired(draftIdentity, scope, retiredCallId, next);
  }, [sameDraftScope, draftMemory, draftIdentity, scope]);
  const discardRetiredDraft = useCallback((retiredCallId: string) => {
    if (sameDraftScope()) draftMemory.discardRetired(draftIdentity, scope, retiredCallId);
  }, [sameDraftScope, draftMemory, draftIdentity, scope]);
  const generation = useRef(0);
  const deliveries = useRef(new Map<string, string>());
  useEffect(() => {
    roster.setScope(scope); generation.current += 1; deliveries.current.clear();
    draftMemory.setScope(draftIdentity, scope, host?.lobby?.title ?? 'Huddle');
    inFlight.current = false;
    setView(scope ? 'pane' : 'closed'); setPending(false); setSendError(null); setReadyEpoch(null);
    return () => roster.setScope(null);
  }, [roster, scope, draftMemory, draftIdentity]);
  const sessionEpoch = frames.gateway.sessionEpoch ?? 0;
  const confirm = useCallback(async (retryRegistration: boolean) => {
    const epoch = sessionEpoch;
    if (await roster.refresh({ retryRegistration })) setReadyEpoch(epoch);
  }, [roster, sessionEpoch]);
  // Roster frames are server pushes; a membership change rereads the resolver.
  useEffect(() => frames.gateway.onMessage(frame => {
    roster.receive(frame);
    if (frame.callId === callId && frame.type === 'call-chat' && frame.action === 'members') {
      void confirm(true);
    } else if (frame.type === 'call' && ['accepted', 'participant-state', 'active-call'].includes(String(frame.action ?? ''))) {
      const data = frame.data && typeof frame.data === 'object' ? frame.data as Record<string, unknown> : frame;
      if (data.callId === callId && !roster.getSnapshot().loaded) void confirm(true);
    }
  }), [roster, frames.gateway.onMessage, callId, confirm]);
  useEffect(() => {
    if (scope && frames.connectionState === 'connected') void confirm(true);
  }, [confirm, scope, frames.connectionState]);
  const current = !!scope && rosterState.scopeKey === scopeKey && rosterState.scopeKey !== '';
  const connected = frames.connectionState === 'connected';
  // Inside a breakout room the conversation is the room's (decision 1); the
  // roster stays the call's, since a room's members are the call's seats.
  const channel = callId ? huddleChatChannelFor(callId, host?.meeting?.activeChat) : null;
  // Joined once the resolver confirmed this socket's seat; it stays mounted
  // (read-only) through an end or a dropped connection, so the transcript and
  // draft stay in view, and unmounts when the person is refused or leaves.
  const mounted = current && frames.configured && rosterState.loaded && !rosterState.denied && readyEpoch !== null;
  // Only the joined channel's NAME is read here (a stable string): the shell
  // must not re-render on every message the channel publishes.
  const channelName = useCallback(() => store.get()?.channel ?? null, [store]);
  const joinedChannel = useSyncExternalStore(store.subscribe, channelName, channelName);
  const ready = mounted && joinedChannel === channel;
  const unavailableReason = !current ? 'Join a huddle to message its participants.' : rosterState.ended ? 'This huddle has ended.'
    : !connected ? 'Reconnect to send huddle messages.'
    : !rosterState.loaded ? 'Loading the huddle conversation…'
    : rosterState.denied || !rosterState.canSend ? 'You cannot send messages to this huddle.'
    : !ready ? 'Loading the huddle conversation…' : null;
  // The work item's composer hands a huddle-bound draft to this pane: open
  // and focus it, seed the draft and attach the page reference.
  const openPane = useCallback((request: HuddlePaneRequest = {}): boolean => {
    if (!current) return false;
    setView(v => v === 'floating' ? v : 'pane');
    if (request.draft !== undefined) setDraft(composerDraftOf(request.draft));
    if (request.page !== undefined) setPage(request.page);
    if (request.focus !== false) setFocusRequest(n => n + 1);
    return true;
  }, [current, setDraft, setPage]);
  const sendRef = useRef<(text: string, page: CallPageDescriptor | null, extra: Record<string, unknown>) => Promise<boolean>>(async () => false);
  // One meeting chat binding for the shell (see `meetingChat` above); a source on every render.
  const meetingSource = host?.meeting ?? null;
  const binding = useMeetingChat(meetingSource ?? INERT_MEETING, { send: content => { void sendRef.current(content, null, {}); } });
  const announcements = binding.withAnnouncements([]).length;
  const meetingChat = useMemo(() => (meetingSource ? binding : null),
    // The binding is rebuilt every render; expose a new one only when what it draws or routes changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [!!meetingSource, binding.target, binding.title, announcements, meetingSource?.isOrganizer, meetingSource?.breakout.phase, meetingSource?.myRoom?.id, meetingSource?.ready]);
  const meetingChatRef = useRef(meetingChat);
  meetingChatRef.current = meetingSource ? binding : null;
  const send = useCallback(async (text: string, sendPage: CallPageDescriptor | null = null, extra: Record<string, unknown> = {}, submittedDraft?: RichChatDraft): Promise<boolean> => {
    // "To: All rooms": every composer's send becomes the meeting's announcement, never a chat post.
    if (announceInstead(meetingChatRef.current, text)) {
      if (submittedDraft && sameDraftScope()) setDraft(settleHuddleDraft(draftRef.current, submittedDraft, true, EMPTY_DRAFT));
      return true;
    }
    const live = store.get();
    if (!live || !ready || unavailableReason || inFlight.current) return false;
    const trimmed = text.trim();
    if (!trimmed && !sendPage) return false;
    // A references-only message carries no text: the BFF stores the reference alone.
    const body = trimmed;
    // The same text and page again (an explicit retry) keeps its delivery id.
    const signature = JSON.stringify([body, sendPage?.kind ?? null, sendPage?.id ?? null, extra]);
    const deliveryId = deliveries.current.get(signature) ?? crypto.randomUUID();
    deliveries.current.set(signature, deliveryId);
    if (deliveries.current.size > 32) deliveries.current.delete(deliveries.current.keys().next().value!);
    const mine = generation.current;
    inFlight.current = true; setPending(true); setSendError(null);
    try {
      await live.sendConfirmed(body, deliveryId, sendPage, extra);
      if (mine !== generation.current || !sameDraftScope()) return false;
      deliveries.current.delete(signature);
      if (submittedDraft) setDraft(settleHuddleDraft(draftRef.current, submittedDraft, true, EMPTY_DRAFT));
      return true;
    } catch (error) {
      if (mine === generation.current && sameDraftScope()) {
        setSendError(error instanceof Error ? error.message : 'The huddle message was not confirmed. Retry to confirm it.');
        if (submittedDraft) setDraft(settleHuddleDraft(draftRef.current, submittedDraft, false, EMPTY_DRAFT));
      }
      return false;
    } finally {
      if (mine === generation.current && sameDraftScope()) { inFlight.current = false; setPending(false); }
    }
  }, [store, ready, unavailableReason, setDraft, sameDraftScope]);
  sendRef.current = send;
  const state = useMemo<HuddleChatState>(() => current ? {
    participants: rosterState.participants, loaded: rosterState.loaded, refreshing: rosterState.refreshing, pending, ended: rosterState.ended,
    error: sendError ?? rosterState.error,
  } : { participants: [], loaded: false, refreshing: false, pending: false, ended: false, error: null },
  [current, rosterState, pending, sendError]);
  const value = useMemo<HuddleChatContextValue>(() => ({
    paneOwned: paneOwners > 0, registerPaneOwner,
    callId: current ? callId : null, channel: current ? channel : null, actorId: current ? actorId : null,
    title: host?.lobby?.title ?? 'Huddle', participants: state.participants, state,
    canSend: current && !unavailableReason && !pending, unavailableReason,
    open: current && view !== 'closed', view: current ? view : 'closed',
    openMessage: () => { if (current) { setView(v => v === 'floating' ? v : 'pane'); setFocusRequest(n => n + 1); } },
    popOut: () => { if (current) setView('floating'); }, closeMessage: () => setView('closed'),
    draft, setDraft, retiredDrafts, updateRetiredDraft, discardRetiredDraft, page, setPage, focusRequest, send, openPane,
    refresh: () => { setSendError(null); void confirm(true); }, meetingChat,
  }), [meetingChat, paneOwners, registerPaneOwner, current, callId, channel, actorId, host?.lobby?.title, state, unavailableReason, pending, view, draft, setDraft, retiredDrafts, updateRetiredDraft, discardRetiredDraft, page, setPage, focusRequest, send, openPane, confirm]);
  const publish = useCallback((next: HuddleChannelRuntime | null) => {
    if (next || store.get()) store.set(next);
  }, [store]);
  return <HuddleChatContext.Provider value={value}>
    <ReactionPlaybackContext.Provider value={reactionPlayback}>
    <ChannelContext.Provider value={store}>
      {children}
      {mounted && channel && actorId ? <HuddleChannel key={`${scopeKey}:${readyEpoch}:${channel}`} channel={channel} userId={actorId}
        displayName={session?.name ?? actorId} maySend={!rosterState.denied && rosterState.canSend && !rosterState.ended}
        post={async (text, metadata) => { if (!await sendRef.current(text, null, metadata)) throw new Error('The summary could not be sent to this huddle.'); }}
        publish={publish} /> : null}
    </ChannelContext.Provider>
    </ReactionPlaybackContext.Provider>
  </HuddleChatContext.Provider>;
}

/** Offered in calls: the picker set the reactions service's catalog also accepts. */
export const HUDDLE_REACTION_EMOJIS = ['👍', '❤️', '🔥', '🎉', '😮'];

type HuddleReaction = ReturnType<typeof useReactions>['reactions'][number];
const NO_REACTIONS: HuddleReaction[] = [];

/**
 * In-call reactions on the huddle's own seat-only channel (the one the chat
 * uses): an untargeted reaction is a floating event, a targeted one is a chat
 * message's chip. The returned list changes only when a new floating reaction
 * arrives, so a chip toggle never re-floats the last emoji.
 */
function useHuddleCallReactions(): { floating: HuddleReaction[]; react: (emoji: string) => void } | null {
  const runtime = useHuddleChannel();
  const all = runtime?.conversation.reactions.reactions;
  const lastId = useMemo(() => { const floats = (all ?? NO_REACTIONS).filter(r => !r.targetId); return floats[floats.length - 1]?.id ?? null; }, [all]);
  const latest = useRef<HuddleReaction[]>(NO_REACTIONS);
  const floating = useMemo(() => {
    const floats = (all ?? NO_REACTIONS).filter(r => !r.targetId);
    if (floats[floats.length - 1]?.id === latest.current[latest.current.length - 1]?.id) return latest.current;
    latest.current = floats;
    return floats;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastId]);
  const send = runtime?.conversation.reactions.react;
  const react = useCallback((emoji: string) => { send?.(emoji); }, [send]);
  return runtime ? { floating, react } : null;
}

/** The huddle's reaction send for the meeting's React item (CallMeeting `useMeetingBarItems`); null until the channel is joined. */
export function useHuddleReact(): { send(emoji: string): void; emojis: string[] } | null {
  const react = useHuddleCallReactions()?.react;
  return useMemo(() => react ? { send: react, emojis: HUDDLE_REACTION_EMOJIS } : null, [react]);
}

/** Emoji floating up over the call tiles, wherever the shell's one media sink is drawn. */
export function HuddleReactionOverlay() {
  const reactions = useHuddleCallReactions();
  const playback = useContext(ReactionPlaybackContext);
  const [live, setLive] = useState<HuddleReaction[]>(NO_REACTIONS);
  const floating = reactions?.floating ?? NO_REACTIONS;
  useEffect(() => {
    const fresh = playback?.take(floating) ?? NO_REACTIONS;
    if (fresh.length) setLive(fresh);
  }, [playback, floating]);
  return <ReactionOverlay reactions={live} />;
}

/** The footer's reaction row (the in-call HuddleBar `extras` slot; inline, since the footer row clips popovers); null until the huddle channel is joined. */
export function HuddleReactionBar() {
  const reactions = useHuddleCallReactions();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!reactions) return null;
  return <>
    <IconButton ref={trigger} variant="ghost" size="sm" aria-label="React to the huddle" title="Send a reaction" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(value => !value)} data-testid="huddle-reaction-toggle"
      icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20.8 10a9 9 0 1 0-10.6 10.8" /><path d="M8 14s1.5 2 4 2c.8 0 1.5-.2 2.1-.5" /><path d="M8.5 8.5h.01M15.5 8.5h.01" /><circle cx="18" cy="18" r="4.5" /><path d="M18 15.8v4.4M15.8 18h4.4" /></svg>} />
    <InlinePopover trigger={trigger} open={open} onClose={() => setOpen(false)} placement="bottom-end" offset={10}
      aria-label="Send a reaction" className="p-2" data-testid="huddle-reaction-picker">
      <Inline justify="center" align="center">
        <ReactionPicker onReact={emoji => { reactions.react(emoji); setOpen(false); }} emojis={HUDDLE_REACTION_EMOJIS} className="border-0 bg-transparent shadow-none" />
      </Inline>
    </InlinePopover>
  </>;
}

/**
 * The footer bar's chat toggle: opens the huddle chat in the right pane, or
 * focuses its composer when open. Null without an eligible call.
 */
export function useHuddleChatToggle(): { open: boolean; toggle(): void } | null {
  const chat = useHuddleChat();
  const input = useThreadInput(chat?.channel ?? null);
  const focus = useComposerFocus();
  if (!chat?.callId) return null;
  // A page composer that claims the huddle's conversation (the library ConversationInputProvider)
  // owns its input: the pane opens on the thread and the caret goes to that
  // composer (HuddleChatBody routes the focus request). Otherwise, closed: a page
  // composer that answers (the overview's) takes the focus; whenever the pane is
  // open, the pane's composer does.
  return { open: chat.open, toggle: () => {
    chat.openMessage();
    focus.request({ mode: 'chat', target: { kind: 'huddle' } });
    if (input.owner === 'composer') input.focus();
  } };
}

/** The huddle conversation: ConversationThread on the call's channel (a room's inside one), with the page reference and participant mentions. */
export function HuddleChatBody() {
  const chat = useHuddleChat();
  const runtime = useHuddleChannel();
  const location = useLocation();
  const navigate = useNavigate();
  const currentPage = currentCallPage(location.pathname, location.search);
  const composer = useRef<RichChatComposerHandle>(null);
  const focusRequest = chat?.focusRequest ?? 0;
  // One input per conversation: when a composer elsewhere claims this huddle's
  // channel the pane is the thread only, and a send intent (the footer's
  // Message, the pane's Write) puts the caret in that composer.
  const input = useThreadInput(chat?.channel ?? null);
  const latestInput = useRef(input);
  latestInput.current = input;
  useEffect(() => {
    if (focusRequest <= 0) return;
    if (latestInput.current.owner === 'composer') latestInput.current.focus();
    else composer.current?.focus();
  }, [focusRequest]);
  // Each message's reference arrives resolved by the BFF for this reader.
  const host = useCallHost();
  const callLobby = host?.lobby?.lobbyName ?? null;
  const references = useCallback((message: { metadata?: Record<string, unknown> }) => {
    const reference = readCallChatPageReference(message.metadata?.['pageReference']);
    return reference && !isCallContextReference(reference, callLobby) ? <PageReferenceCard reference={reference} onOpen={target => navigate(target.href)}
      openTestId="huddle-chat-reference-open" unavailableTestId="huddle-chat-reference-unavailable" /> : null;
  }, [navigate, callLobby]);
  if (!chat?.callId) return null;
  const { state } = chat;
  const inRoom = isBreakoutChat(chat.callId, runtime?.channel ?? chat.channel);
  const draftPage = chat.page;
  const pending = state.pending;
  // The native recipient contract waits for the stored acknowledgement.
  // A call end or rejection leaves the submitted draft available for recovery;
  // a late receipt cannot clear a newer draft or another call's input.
  const confirmed = (text: string, page: CallPageDescriptor | null, extra: Record<string, unknown>) =>
    chat.send(text, page, extra, chat.draft).then(sent => {
      if (sent) {
        runtime?.conversation.quote.clear();
        if (page) chat.setPage(null);
      }
      return sent;
    });
  // @mention candidates are the call's current participants only.
  const searchPeople = (query: string): MentionCandidate[] => {
    const needle = query.trim().toLowerCase();
    return state.participants.filter(p => p.userId !== chat.actorId && (!needle || p.displayName.toLowerCase().includes(needle)))
      .slice(0, 8).map(p => ({ id: p.userId, label: p.displayName }));
  };
  const pageReferences = draftPage ? [{ id: `${draftPage.kind}:${draftPage.id}`, label: `${draftPage.kind === 'work-item' ? 'Work item' : 'Initiative'} context` }] : [];
  const error = state.error && <Inline gap="sm" align="center" wrap className="m-3">
    <InlineAlert tone="error" className="min-w-0 flex-1" data-testid="huddle-chat-error">{state.error}</InlineAlert>
    <Button variant="link" size="sm" className="text-xs" disabled={state.refreshing || pending || state.ended}
      onClick={chat.refresh} data-testid="huddle-chat-refresh">
      {state.refreshing ? 'Refreshing…' : 'Refresh'}
    </Button>
  </Inline>;
  if (!runtime) {
    return <Stack gap="none" className="min-h-0 flex-1">
      {error}
      {!state.error && <T size="sm" tone="tertiary" className="m-3" wrap data-testid="huddle-chat-loading">{chat.unavailableReason ?? 'Loading the huddle conversation…'}</T>}
    </Stack>;
  }
  // The shell's meeting chat binding: announcements merged and marked, the which-chat line and the
  // organizer's "To" switch; its target routes chat.send (HuddleChatProvider), from this pane or any composer.
  const meetingChat = chat.meetingChat;
  const announcing = meetingChat?.target === 'rooms';
  const thread = <ConversationThread editable={false} conversation={runtime.conversation} title={chat.title} data-testid="huddle-thread"
      input={input.owner === 'composer' ? 'below' : undefined}
      includeFiles={input.owner !== 'composer'}
      // An empty room chat with announcements draws the panel, so they show.
      emptyState={meetingChat && meetingChat.withAnnouncements([]).length ? undefined : <Stack gap="sm" className="px-4 pt-5"><T size="sm" weight="semibold">Start the conversation</T><T size="sm" tone="secondary" wrap>Messages stay with this huddle as you move between work and documents.</T></Stack>}
      // Writers react, pin and attach; a reader sees the thread, its pins and files.
      // A room's chat is gateway-only: pins and files (REST on the call's channel) stay with the main huddle.
      reactions={!chat.unavailableReason} {...(inRoom ? {} : { pins: { canPin: !chat.unavailableReason } })} attachments={!chat.unavailableReason && !inRoom}
      readOnlyReason={chat.unavailableReason} placeholder={announcing ? 'Announce to every room…' : 'Message this huddle…'} typingUsers={runtime.conversation.chat.typingUsers}
      renderMessageReferences={meetingChat ? (message => meetingChat.renderMessageReferences(message) ?? references(message)) : references}
      {...(meetingChat ? { transformMessages: meetingChat.withAnnouncements, ...(meetingChat.dock ? { dock: meetingChat.dock } : {}) } : {})}
      composer={{
        // The huddle's confirmed send: one in flight, the delivery id, the page the draft carries.
        recipients: [{ id: 'huddle', label: chat.title, channel: runtime.channel, attachments: true,
          send: out => {
            if (pending || chat.unavailableReason) return false;
            if (!out.text.trim() && !draftPage) return false;
            const { displayName: _name, ...extra } = out.metadata;
            return confirmed(out.text.trim(), draftPage, extra);
          } }],
        draft: chat.draft, onDraftChange: chat.setDraft, composerRef: composer, onSearchPeople: searchPeople, contextChip: false, inputLabel: 'Huddle message',
        // The full card keeps the strip (mention, attach page, files) in view, as the pane always showed it.
        expanded: true,
        references: pageReferences, onRemoveReference: () => chat.setPage(null),
        submitLabel: pending ? 'Sending…' : announcing ? 'Announce' : 'Send',
        // A page-only message goes through the composer's own send: the BFF stores the reference alone.
        sendWithReferencesOnly: true,
        modeRowStart: <T size="xs" weight="medium" tone="tertiary" data-testid="huddle-chat-mode-label">Chat</T>,
        // On the card's mode row, after the page chip, so a narrow pane keeps
        // them in view (the formatting strip folds behind "Aa" there).
        modeRowEnd: <Inline gap="xs" align="center" wrap={false}>
          <IconButton variant="ghost" size="sm" icon={<AtIcon size={16} />} aria-label="Mention someone" title="Mention someone"
            disabled={state.ended} onClick={() => { composer.current?.focus(); composer.current?.insertText('@'); }} data-testid="huddle-chat-mention" />
          {currentPage ? <IconButton variant="ghost" size="sm" icon={<DocumentAddIcon size={16} />}
            aria-label={`Attach current ${currentPage.kind === 'work-item' ? 'work item' : 'initiative'}`}
            title={`Attach current ${currentPage.kind === 'work-item' ? 'work item' : 'initiative'}`} disabled={pending || state.ended}
            onClick={() => chat.setPage(currentPage)} data-testid="huddle-chat-attach-page" /> : null}
        </Inline>,
      }} />;
  return <Stack gap="none" className="min-h-0 flex-1">
    {error}
    {thread}
    {chat.unavailableReason && input.owner !== 'composer' && <T size="xs" tone="tertiary" className="px-3 pb-2" wrap>{chat.unavailableReason}</T>}
  </Stack>;
}

function participantsLine(chat: HuddleChatContextValue): string {
  const count = chat.state.participants.length;
  return `${chat.title} · ${count ? `${count} participant${count === 1 ? '' : 's'}` : 'Loading participants…'}`;
}

/**
 * The huddle's media panel at the top of the shell's right pane: it claims the
 * shell's one call-media sink as 'pane', so ConversationCallDock draws its
 * participant grid here (ShellCallHost ShellCallMedia). Mic, camera and Leave
 * stay in the footer bar; × collapses the grid back into the footer.
 */
function CallMediaGrid() {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const holds = useClaimCallBlock(target, 'pane');
  return <Stack ref={setTarget} gap="none" className="max-h-56 min-h-0 shrink-0 overflow-y-auto border-b border-border p-2" aria-label="Huddle video"
    data-testid="huddle-media-grid" data-holds-media={holds ? 'true' : 'false'} />;
}

function CallMediaPanel({ onClose, title, count }: { onClose(): void; title: string; count: number }) {
  return <ChatSidePanelFrame title={title} subtitle={count ? `${count} in the huddle` : 'Connecting…'} onClose={onClose}
    className="h-auto max-h-[40%] flex-none border-b border-l border-border bg-surface" data-testid="huddle-media-panel">
    <CallMediaGrid />
  </ChatSidePanelFrame>;
}

/** The shell fallback for pages without an owned conversation pane. Media
 * stays with the central composer when that page has claimed it. */
export function HuddleChatSplit({ children }: { children: ReactNode }) {
  const chat = useHuddleChat();
  const host = useCallHost();
  const media = useCallMediaPanel();
  const pageHoldsMedia = useCallBlockPageClaimed();
  const pane = useSidePaneHost();
  // The footer's Message (and any other focus request for the page's own
  // conversation) brings the pane on screen before a composer takes the caret.
  const { registered, reveal } = pane;
  useComposerFocusReveal(request => {
    if (request.mode !== 'chat') return;
    if (request.target?.kind === 'huddle') chat?.openPane({ focus: false });
    else if (!request.target || request.target.kind === 'discussion') {
      if (request.target?.kind === 'discussion') chat?.closeMessage();
      if (registered) reveal();
    }
  }, !chat?.paneOwned);

  // ── The huddle ───────────────────────────────────────────────────────────
  const shown = !!chat?.callId && !chat.paneOwned && chat.view === 'pane';
  const mediaShown = !!media?.open && !pageHoldsMedia;
  const chatPane = shown && chat
    ? <ChatSidePanelFrame title="Huddle chat" subtitle={participantsLine(chat)}
      onClose={chat.closeMessage}
      onOpenFullPage={chat.popOut} className="min-h-0 flex-1 border-l border-border bg-surface"
      data-testid="huddle-chat-panel">
      <Stack gap="none" className="h-full min-h-0">
        {mediaShown && <CallMediaGrid />}
        <T className="sr-only" data-testid="huddle-chat-participants">{chat.state.participants.map(person => person.displayName).join(', ')}</T>
        <HuddleChatBody />
      </Stack>
    </ChatSidePanelFrame>
    : null;
  const lobbyTitle = host?.lobby?.title ?? 'Huddle';
  const meeting = useCallMeeting();
  const meetingOpen = meeting?.pane === 'people' || (meeting?.pane === 'rooms' && meeting.rooms);
  const mediaPanel = mediaShown && !chatPane
    ? <CallMediaPanel onClose={() => media?.setOpen(false)} title={/huddle$/i.test(lobbyTitle) ? lobbyTitle : `${lobbyTitle} huddle`}
        count={host?.call.call?.participants?.filter(p => p.state === 'in-call' || p.state === 'reconnecting').length ?? 0} />
    : null;
  // The meeting's Rooms or People pane (CallMeeting.tsx) stacks under the media.
  const meetingPane = <MeetingPane />;
  return <SidePaneSplit before={mediaPanel || meetingOpen ? <>{mediaPanel}{meetingPane}</> : null} after={chatPane} paneTestId="page-conversation-pane"
      dividerLabel="Resize page and conversation" data-testid="shell-split">{children}</SidePaneSplit>;
}

/** The popped-out huddle chat (the pane's ↗), floating above the footer. */
export function HuddleChatPanel() {
  const chat = useHuddleChat();
  const anchorKey = useFooterAnchorKey();
  if (!chat?.callId) return null;
  return <FloatingPanel key={anchorKey} open={chat.view === 'floating'} onClose={chat.closeMessage} title={`${chat.title} · Huddle chat`}
    tone="light" defaultPosition={aboveFooterEnd(32, 28)} widthClassName="w-[min(28rem,calc(100vw-2rem))]"
    heightClassName="h-[min(32rem,calc(100dvh-var(--shell-collaboration-floor,0px)-2rem))]" data-testid="huddle-chat-panel">
    <Stack gap="none" className="flex-1 min-h-0">
      <T size="xs" tone="secondary" className="border-b border-border px-3 py-2" wrap data-testid="huddle-chat-participants">
        {chat.state.participants.map(person => person.displayName).join(', ') || 'Loading participants…'}
      </T>
      <HuddleChatBody />
    </Stack>
  </FloatingPanel>;
}

